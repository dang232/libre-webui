/*
 * Task-29 Libre-leg idempotency + race + failure matrix
 * (unified-auth-core todo 29, Libre exchange seam).
 *
 * Behavior of record (never edited here):
 * - scripts/test-alcore-auth-exchange.mjs owns the exchange contract
 *   (19 pins + 8 claim pins); this file only reuses its harness shape.
 * - backend/src/config/authPath.ts owns the lifecycle naming
 *   (LIBRE_PROVISION_HTTP_TO_LIFECYCLE: 200 PROVISIONED / 409 CONFLICT /
 *   500 FAILED, retryable with the same provision key). This file imports
 *   that map and asserts against it; a 503 from an unreachable Auth is the
 *   same FAILED family (retryable 5xx). 4xx caller errors carry no
 *   lifecycle state (final rejections, nothing to resume).
 *
 * Matrix, against the REAL alcoreAuth router + REAL userModel/authService
 * with a stub Auth S2S endpoint (the stub stands in for the product side;
 * no other repo is touched):
 * - POST provision(same subject) x3 -> 1 Libre row (count delta +1)
 * - concurrent same-subject x2 -> 1 PROVISIONED + 1 replay (same id)
 * - replay / tampered / swapped / wrong-aud (+wrong-iss/expired) -> reject
 * - bound-via-legacy (lwk_* bearer, legacy-shaped code) -> reject, code
 *   unconsumed where applicable
 * - second-product-down (stub 503 outage) -> FAILED, then retry with the
 *   same provision key -> PROVISIONED, count still +1 total
 * - enumeration over unknown codes -> uniform 401s, zero rows
 *
 * Rate-limiter budget: POST /exchange allows 30 per 5 min in this process.
 * This file makes 23 exchange hits; the invariant under proof is the
 * row-count assertion, not the burst width.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ISSUER = 'https://auth.alcore.io.vn';
const CALLBACK = 'http://127.0.0.1:9/callback';
const STATE = 'task29-state-binding';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-task29-matrix-'));
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = '5'.repeat(64);
process.env.JWT_SECRET = 'task29-matrix-test-secret-that-is-long-enough';
process.env.ENABLE_SIGNUP = 'true';
process.env.ALCORE_AUTH_MODE = 'alcore';
process.env.ALCORE_AUTH_ISSUER = ISSUER;

const repoRoot = path.resolve(import.meta.dirname, '..');
const backendRequire = createRequire(
  path.join(repoRoot, 'backend', 'package.json')
);
const express = backendRequire('express');
const importBuilt = file =>
  import(pathToFileURL(path.join(repoRoot, 'backend', 'dist', file)).href);

const b64url = value =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

// Stub Auth S2S endpoint: single-use codes, Auth-shaped assertions, an
// outage switch standing in for the second product being down, and a
// tamper switch corrupting the minted payload (signature never verified in
// this harness; corruption must break decode/claims instead).
const STUB_SECRET = 'stub-auth-secret-never-shared-with-libre';
let outage = false;
const codes = new Map([
  [
    'matrix-triple-1',
    { sub: 'matrix-sub-triple', email: 'triple29@example.com' },
  ],
  [
    'matrix-triple-2',
    { sub: 'matrix-sub-triple', email: 'triple29@example.com' },
  ],
  [
    'matrix-triple-3',
    { sub: 'matrix-sub-triple', email: 'triple29@example.com' },
  ],
  ['matrix-race-1', { sub: 'matrix-sub-race', email: 'race29@example.com' }],
  ['matrix-race-2', { sub: 'matrix-sub-race', email: 'race29@example.com' }],
  [
    'matrix-replay-1',
    { sub: 'matrix-sub-replay', email: 'replay29@example.com' },
  ],
  [
    'matrix-tamper-1',
    { sub: 'matrix-sub-tamper', email: 'tamper29@example.com', tamper: true },
  ],
  [
    'matrix-bound-1',
    {
      sub: 'matrix-sub-bound',
      email: 'bound29@example.com',
      binding: { redirect_uri: CALLBACK, state: STATE },
    },
  ],
  ['matrix-waud-1', { sub: 'matrix-sub-waud', aud: 'tokenpanel' }],
  [
    'matrix-wiss-1',
    { sub: 'matrix-sub-wiss', iss: 'https://evil.example.com' },
  ],
  ['matrix-exp-1', { sub: 'matrix-sub-exp', exp: 1 }],
  [
    'matrix-legacy-1',
    { sub: 'matrix-sub-legacy', email: 'legacy29@example.com' },
  ],
  [
    'matrix-outage-1',
    { sub: 'matrix-sub-outage', email: 'outage29@example.com' },
  ],
]);
const seen = new Set();

const mintAssertion = (claims, tamper) => {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: claims.sub,
    sid: 'auth-session-1',
    iss: claims.iss ?? ISSUER,
    aud: claims.aud ?? 'libre',
    intent: 'product_exchange',
    exp: claims.exp ?? Math.floor(Date.now() / 1000) + 60,
    ...(claims.email ? { email: claims.email } : {}),
  };
  const headerPart = b64url(header);
  let payloadPart = b64url(payload);
  if (tamper) payloadPart = payloadPart.slice(0, -4);
  const data = `${headerPart}.${payloadPart}`;
  const sig = b64url(`stub-sig:${data}:${STUB_SECRET}`);
  return `${data}.${sig}`;
};

let exchangeHits = 0;
const stub = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/oidc/exchange/token') {
    res.writeHead(404).end('{}');
    return;
  }
  let raw = '';
  req.on('data', chunk => {
    raw += chunk;
  });
  req.on('end', () => {
    exchangeHits += 1;
    if (outage) {
      res
        .writeHead(503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'temporarily_unavailable' }));
      return;
    }
    const body = JSON.parse(raw);
    const entry = codes.get(body.code);
    const bound =
      typeof body.redirect_uri === 'string' && body.redirect_uri !== '';
    const incomingState = typeof body.state === 'string' ? body.state : '';
    const bindingOk =
      !entry?.binding ||
      (bound &&
        body.redirect_uri === entry.binding.redirect_uri &&
        (incomingState === '' || incomingState === entry.binding.state));
    if (
      !entry ||
      seen.has(body.code) ||
      body.audience !== 'libre' ||
      body.intent !== 'product_exchange' ||
      !bindingOk ||
      (!entry.binding && bound)
    ) {
      res
        .writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'invalid_grant' }));
      return;
    }
    seen.add(body.code);
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        access_token: mintAssertion(entry, entry.tamper === true),
        token_type: 'Bearer',
        expires_in: 60,
      })
    );
  });
});
await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
process.env.ALCORE_AUTH_URL = `http://127.0.0.1:${stub.address().port}`;

const [
  { default: alcoreAuthRoutes },
  { authService },
  { userModel },
  { LIBRE_PROVISION_HTTP_TO_LIFECYCLE },
] = await Promise.all([
  importBuilt('routes/alcoreAuth.js'),
  importBuilt('services/authService.js'),
  importBuilt('models/userModel.js'),
  importBuilt('config/authPath.js'),
]);

// Todo-13 lifecycle naming, asserted against the real map (behavior of
// record). 503 (unreachable Auth) is the same retryable FAILED family as
// the mapped 500; 4xx caller errors are final rejections with no state.
assert.equal(LIBRE_PROVISION_HTTP_TO_LIFECYCLE[200], 'PROVISIONED');
assert.equal(LIBRE_PROVISION_HTTP_TO_LIFECYCLE[409], 'CONFLICT');
assert.equal(LIBRE_PROVISION_HTTP_TO_LIFECYCLE[500], 'FAILED');
assert.equal(LIBRE_PROVISION_HTTP_TO_LIFECYCLE[503], 'FAILED');

// Test-owned provision ledger: UNPROVISIONED (never contacted) ->
// PROVISIONED | FAILED | CONFLICT. Replays/rejects are counted on the row.
const ledger = new Map();
const recordOutcome = (subject, status, userId) => {
  let entry = ledger.get(subject);
  if (!entry) {
    entry = {
      state: 'UNPROVISIONED',
      userId: null,
      provisions: 0,
      replays: 0,
      rejects: 0,
    };
    ledger.set(subject, entry);
  }
  if (status === 200) {
    if (entry.state === 'PROVISIONED') entry.replays += 1;
    else {
      entry.state = 'PROVISIONED';
      entry.provisions += 1;
      entry.userId = userId;
    }
  } else if (status === 500 || status === 503) {
    if (entry.state !== 'PROVISIONED') entry.state = 'FAILED';
  } else if (status === 409) {
    entry.state = 'CONFLICT';
  } else {
    entry.rejects += 1;
  }
  return entry;
};

try {
  const coord = await importBuilt('platform/coordination/service.js');
  if (typeof coord.initializeCoordinator === 'function') {
    await coord.initializeCoordinator();
  }
} catch {
  // Local coordinator fallback covers the harness.
}

const app = express();
app.use(express.json());
app.use('/api/auth/alcore', alcoreAuthRoutes);
const server = await new Promise(resolve => {
  const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
});
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  server.close();
  stub.close();
  const { closeDatabase } = await importBuilt('db.js');
  closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (method, urlPath, body, headers = {}) => {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    headers: res.headers,
    body: await res.json().catch(() => null),
  };
};

const noStore = outcome =>
  (outcome.headers.get('cache-control') || '').includes('no-store');
const noRefreshMaterial = outcome =>
  !JSON.stringify(outcome.body).includes('refresh_token') &&
  !JSON.stringify(outcome.body).includes('alcore_rt');
const generic401 = outcome => {
  assert.equal(outcome.status, 401);
  assert.deepEqual(Object.keys(outcome.body).sort(), ['message', 'success']);
  assert.ok(noStore(outcome));
};
const rowCount = async () => (await userModel.getAllUsers()).length;

const bootstrap = await authService.signup(
  'task29_bootstrap',
  'Task29-Matrix-Proof-Password-1!',
  null,
  { kind: 'signup' }
);
assert.equal(bootstrap?.status, 'authenticated');
const adminId = bootstrap.user.id;

const approveIfPending = async subject => {
  const row = await userModel.getUserByAuthSubject(subject);
  if (row && row.status !== 'active')
    await userModel.approveUser(row.id, adminId);
  return row;
};

test('triple provision of one subject creates exactly one Libre row', async () => {
  const subject = `${ISSUER}|matrix-sub-triple`;
  const before = await rowCount();
  const ids = [];
  for (const code of [
    'matrix-triple-1',
    'matrix-triple-2',
    'matrix-triple-3',
  ]) {
    const outcome = await call('POST', '/api/auth/alcore/exchange', { code });
    assert.equal(outcome.status, 200);
    ids.push(outcome.body.data.user.id);
    assert.ok(noStore(outcome));
    assert.ok(noRefreshMaterial(outcome));
    recordOutcome(subject, 200, outcome.body.data.user.id);
  }
  await approveIfPending(subject);
  assert.equal(new Set(ids).size, 1);
  const after = await rowCount();
  assert.equal(after, before + 1);
  const entry = ledger.get(subject);
  assert.equal(entry.state, 'PROVISIONED');
  assert.equal(entry.provisions, 1);
  assert.equal(entry.replays, 2);
  console.log(
    `[matrix] triple-provision count(*)=${after - before} (1 row for 3 posts)`
  );
});

test('concurrent same-subject provisions converge on one row', async () => {
  const subject = `${ISSUER}|matrix-sub-race`;
  const before = await rowCount();
  const outcomes = await Promise.all(
    ['matrix-race-1', 'matrix-race-2'].map(code =>
      call('POST', '/api/auth/alcore/exchange', { code })
    )
  );
  for (const o of outcomes) {
    assert.equal(o.status, 200);
    recordOutcome(subject, 200, o.body.data.user.id);
  }
  await approveIfPending(subject);
  assert.equal(new Set(outcomes.map(o => o.body.data.user.id)).size, 1);
  const after = await rowCount();
  assert.equal(after, before + 1);
  const entry = ledger.get(subject);
  assert.equal(entry.state, 'PROVISIONED');
  assert.equal(entry.provisions, 1);
  assert.equal(entry.replays, 1);
  console.log(
    `[matrix] concurrent-provision count(*)=${after - before} (1 PROVISIONED + 1 replay)`
  );
});

test('replayed code is rejected with the generic shape and no new row', async () => {
  const subject = `${ISSUER}|matrix-sub-replay`;
  const before = await rowCount();
  const first = await call('POST', '/api/auth/alcore/exchange', {
    code: 'matrix-replay-1',
  });
  assert.equal(first.status, 200);
  recordOutcome(subject, 200, first.body.data.user.id);
  await approveIfPending(subject);
  const replay = await call('POST', '/api/auth/alcore/exchange', {
    code: 'matrix-replay-1',
  });
  generic401(replay);
  recordOutcome(subject, 401, null);
  assert.equal(await rowCount(), before + 1);
  assert.equal(ledger.get(subject).state, 'PROVISIONED');
  console.log(
    '[matrix] replay rejected, count unchanged past the first provision'
  );
});

test('tampered assertion is rejected and creates no row', async () => {
  const before = await rowCount();
  const outcome = await call('POST', '/api/auth/alcore/exchange', {
    code: 'matrix-tamper-1',
  });
  generic401(outcome);
  assert.equal(await rowCount(), before);
});

test('swapped binding is rejected without burning the code', async () => {
  const subject = `${ISSUER}|matrix-sub-bound`;
  const before = await rowCount();
  const swapped = await call('POST', '/api/auth/alcore/exchange', {
    code: 'matrix-bound-1',
    redirectUri: CALLBACK,
    state: 'wrong-state-task29',
  });
  assert.equal(swapped.status, 401);
  assert.ok(noStore(swapped));
  const exact = await call('POST', '/api/auth/alcore/exchange', {
    code: 'matrix-bound-1',
    redirectUri: CALLBACK,
    state: STATE,
  });
  assert.equal(exact.status, 200);
  recordOutcome(subject, 200, exact.body.data.user.id);
  await approveIfPending(subject);
  assert.equal(await rowCount(), before + 1);
});

test('wrong-audience assertion is rejected and creates no row', async () => {
  const before = await rowCount();
  const outcome = await call('POST', '/api/auth/alcore/exchange', {
    code: 'matrix-waud-1',
  });
  generic401(outcome);
  assert.equal(await rowCount(), before);
});

test('wrong-issuer and expired assertions are rejected with no rows', async () => {
  const before = await rowCount();
  for (const code of ['matrix-wiss-1', 'matrix-exp-1']) {
    const outcome = await call('POST', '/api/auth/alcore/exchange', { code });
    generic401(outcome);
  }
  assert.equal(await rowCount(), before);
});

test('bound-via-legacy material cannot provision', async () => {
  const { createApiToken } = await importBuilt('services/apiTokenService.js');
  const { token } = await createApiToken(adminId, {
    name: 'task29-legacy-proof',
    scopes: ['chat'],
  });
  assert.ok(token.startsWith('lwk_'));
  const refused = await call(
    'POST',
    '/api/auth/alcore/exchange',
    { code: 'matrix-legacy-1' },
    { authorization: `Bearer ${token}` }
  );
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'TOKEN_SCOPE');
  // The legacy bearer did not burn the code: a code-only retry provisions.
  const subject = `${ISSUER}|matrix-sub-legacy`;
  const before = await rowCount();
  const retry = await call('POST', '/api/auth/alcore/exchange', {
    code: 'matrix-legacy-1',
  });
  assert.equal(retry.status, 200);
  recordOutcome(subject, 200, retry.body.data.user.id);
  await approveIfPending(subject);
  assert.equal(await rowCount(), before + 1);
  // A legacy shared-secret-shaped code is an unknown code: generic 401.
  const legacyShaped = await call('POST', '/api/auth/alcore/exchange', {
    code: 'legacy-shared-secret-jwt-shape',
  });
  generic401(legacyShaped);
  assert.equal(await rowCount(), before + 1);
});

test('second-product-down yields FAILED, retry yields PROVISIONED', async () => {
  const subject = `${ISSUER}|matrix-sub-outage`;
  const before = await rowCount();
  outage = true;
  const down = await call('POST', '/api/auth/alcore/exchange', {
    code: 'matrix-outage-1',
  });
  assert.equal(down.status, 503);
  assert.ok(noStore(down));
  recordOutcome(subject, 503, null);
  assert.equal(await rowCount(), before);
  assert.equal(ledger.get(subject).state, 'FAILED');
  // Recovery: the same provision key (code unconsumed, subject identical)
  // retries to PROVISIONED with exactly one row.
  outage = false;
  const retry = await call('POST', '/api/auth/alcore/exchange', {
    code: 'matrix-outage-1',
  });
  assert.equal(retry.status, 200);
  assert.equal(
    retry.body.data.user.id,
    (await userModel.getUserByAuthSubject(subject))?.id
  );
  recordOutcome(subject, 200, retry.body.data.user.id);
  await approveIfPending(subject);
  assert.equal(await rowCount(), before + 1);
  assert.equal(ledger.get(subject).state, 'PROVISIONED');
  console.log('[matrix] outage FAILED -> retry PROVISIONED, count(*)=1 total');
});

test('enumeration over unknown codes yields uniform rejects and zero rows', async () => {
  const before = await rowCount();
  const probes = [
    'matrix-enum-1',
    'matrix-enum-2',
    'matrix-enum-3',
    'matrix-enum-4',
    'matrix-enum-5',
  ];
  const bodies = [];
  for (const code of probes) {
    const outcome = await call('POST', '/api/auth/alcore/exchange', { code });
    generic401(outcome);
    bodies.push(JSON.stringify(Object.keys(outcome.body).sort()));
  }
  assert.equal(new Set(bodies).size, 1);
  assert.equal(await rowCount(), before);
  console.log('[matrix] enumeration 5/5 uniform 401, count(*)=0 new rows');
});
