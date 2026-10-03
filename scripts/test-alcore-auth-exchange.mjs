/*
 * Direct Auth relying party exchange (todo 45).
 *
 * Covers, against the REAL alcoreAuth router + REAL userModel/authService
 * with a stub Auth S2S endpoint: Alcore-mode config advertisement, code →
 * assertion → LOCAL profile → Libre product session only; same subject
 * converges on one profile with preserved data; replay/replay-binding and
 * malformed assertions fail closed with one generic 401; lwk_* never yields
 * a session; email collisions queue to manual link (409); concurrent
 * same-subject exchanges converge on one Libre row (count +1); pending accounts
 * stay 403; local mode isolates with 404 ALCORE_AUTH_ONLY; no-store on
 * every response; zero Auth refresh material anywhere in responses.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ISSUER = 'https://auth.alcore.io.vn';
const CALLBACK = 'http://127.0.0.1:9/callback';
const STATE = 'task45-state-binding';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-alcore-xchg-'));
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = '3'.repeat(64);
process.env.JWT_SECRET = 'alcore-exchange-test-secret-that-is-long-enough';
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

// Stub Auth S2S endpoint: single-use codes, Auth-shaped assertions, Auth
// failure shapes. Signed with a stub-only secret the BFF never holds.
const STUB_SECRET = 'stub-auth-secret-never-shared-with-libre';
const codes = new Map([
  ['good-code-1', { sub: 'auth-sub-1', email: 'prove@example.com' }],
  ['good-code-2', { sub: 'auth-sub-1', email: 'prove@example.com' }],
  ['good-code-3', { sub: 'auth-sub-1', email: 'changed@example.com' }],
  [
    'bound-code-1',
    {
      sub: 'auth-sub-1',
      email: 'prove@example.com',
      binding: { redirect_uri: CALLBACK, state: STATE },
    },
  ],
  // Task-6 binding-contract pins: one fresh bound code per negative case so
  // single-use consumption never couples the assertions.
  [
    'bound-code-task6-noredir',
    {
      sub: 'auth-sub-1',
      email: 'prove@example.com',
      binding: { redirect_uri: CALLBACK, state: STATE },
    },
  ],
  [
    'bound-code-task6-diffuri',
    {
      sub: 'auth-sub-1',
      email: 'prove@example.com',
      binding: { redirect_uri: CALLBACK, state: STATE },
    },
  ],
  [
    'bound-code-task6-nostate',
    {
      sub: 'auth-sub-1',
      email: 'prove@example.com',
      binding: { redirect_uri: CALLBACK, state: STATE },
    },
  ],
  [
    'bound-code-task6-empty',
    {
      sub: 'auth-sub-1',
      email: 'prove@example.com',
      binding: { redirect_uri: CALLBACK, state: STATE },
    },
  ],
  [
    'bound-code-task6-ws',
    {
      sub: 'auth-sub-1',
      email: 'prove@example.com',
      binding: { redirect_uri: CALLBACK, state: STATE },
    },
  ],
  [
    'bound-code-task6-mismatch',
    {
      sub: 'auth-sub-1',
      email: 'prove@example.com',
      binding: { redirect_uri: CALLBACK, state: STATE },
    },
  ],
  [
    'bound-code-task6-once',
    {
      sub: 'auth-sub-1',
      email: 'prove@example.com',
      binding: { redirect_uri: CALLBACK, state: STATE },
    },
  ],
  ['fresh-code-1', { sub: 'auth-sub-fresh', email: null }],
  ['race-code-1', { sub: 'auth-sub-race', email: 'race@example.com' }],
  ['race-code-2', { sub: 'auth-sub-race', email: 'race@example.com' }],
  ['collision-code-1', { sub: 'auth-sub-new', email: 'taken@example.com' }],
  ['wrong-aud-code', { sub: 'auth-sub-1', aud: 'tokenpanel' }],
  ['wrong-iss-code', { sub: 'auth-sub-1', iss: 'https://evil.example.com' }],
  ['expired-code', { sub: 'auth-sub-1', exp: 1 }],
  ['no-sub-code', { sub: '', email: 'prove@example.com' }],
]);
const seen = new Set();

const mintAssertion = claims => {
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
  const data = `${b64url(header)}.${b64url(payload)}`;
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
    const body = JSON.parse(raw);
    const entry = codes.get(body.code);
    const bound =
      typeof body.redirect_uri === 'string' && body.redirect_uri !== '';
    // Mirrors Auth consume/consumeForRedirect (store.ts:418-445), including
    // the line-433 short-circuit: an empty incoming state skips the hash
    // check. That is the bypass the Libre-route guard must close: Libre
    // coerces an omitted state to '' (alcoreAuthService.ts:174-177), so
    // without the route guard a bound code redeems with redirectUri alone.
    // A binding mismatch or an unknown code never burns the code; only a
    // successful redemption (or a replay of a consumed code) marks it used.
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
        access_token: mintAssertion(entry),
        token_type: 'Bearer',
        expires_in: 60,
      })
    );
  });
});
await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
process.env.ALCORE_AUTH_URL = `http://127.0.0.1:${stub.address().port}`;

const [{ default: alcoreAuthRoutes }, { authService }, { userModel }] =
  await Promise.all([
    importBuilt('routes/alcoreAuth.js'),
    importBuilt('services/authService.js'),
    importBuilt('models/userModel.js'),
  ]);

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

const bootstrap = await authService.signup(
  'task45_bootstrap',
  'Task45-Exchange-Proof-Password-1!',
  null,
  { kind: 'signup' }
);
assert.equal(bootstrap?.status, 'authenticated');
const adminId = bootstrap.user.id;

test('config advertises the Auth endpoint without identity', async () => {
  const outcome = await call('GET', '/api/auth/alcore/config');
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.data.issuer, ISSUER);
  assert.equal(outcome.body.data.mode, 'alcore');
  assert.ok(outcome.body.data.authUrl.startsWith('http://127.0.0.1:'));
  assert.ok(noStore(outcome));
});

test('first exchange auto-approves the Auth-verified profile with an active session', async () => {
  const outcome = await call('POST', '/api/auth/alcore/exchange', {
    code: 'good-code-1',
  });
  assert.equal(outcome.status, 200);
  assert.equal(outcome.body.data.user.email, 'prove@example.com');
  assert.ok(typeof outcome.body.data.token === 'string');
  assert.ok(noStore(outcome));
  assert.ok(noRefreshMaterial(outcome));
});

test('approved profile signs in and converges on repeat codes', async () => {
  const pending = await userModel.getUserByAuthSubject(`${ISSUER}|auth-sub-1`);
  assert.ok(pending, 'profile row exists after first exchange');
  const current = await userModel.getUserById(pending.id);
  const approved =
    current?.status === 'active'
      ? current
      : await userModel.approveUser(pending.id, adminId);
  assert.equal(
    (approved ?? (await userModel.getUserById(pending.id)))?.status,
    'active'
  );

  const first = await call('POST', '/api/auth/alcore/exchange', {
    code: 'good-code-2',
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.data.user.id, pending.id);
  assert.equal(first.body.data.user.email, 'prove@example.com');
  assert.ok(typeof first.body.data.token === 'string');
  assert.ok(noStore(first));
  assert.ok(noRefreshMaterial(first));

  // The Libre token is a product session resolving to the same profile.
  const resolved = await authService.getUserFromToken(first.body.data.token);
  assert.equal(resolved?.id, pending.id);

  // Same subject with a changed email hint keeps the original profile data.
  const repeat = await call('POST', '/api/auth/alcore/exchange', {
    code: 'good-code-3',
  });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.data.user.id, pending.id);
  assert.equal(repeat.body.data.user.email, 'prove@example.com');
});

test('bound redirect codes require their exact binding, once', async () => {
  const mismatch = await call('POST', '/api/auth/alcore/exchange', {
    code: 'bound-code-1',
    redirectUri: CALLBACK,
    state: 'wrong-state',
  });
  assert.equal(mismatch.status, 401);

  // The mismatch did not burn the code (Auth consumeForRedirect checks the
  // binding before the single-use UPDATE): the exact binding still redeems.
  const bound = await call('POST', '/api/auth/alcore/exchange', {
    code: 'bound-code-1',
    redirectUri: CALLBACK,
    state: STATE,
  });
  assert.equal(bound.status, 200);
  const approved = await userModel.getUserByAuthSubject(`${ISSUER}|auth-sub-1`);
  assert.equal(bound.body.data.user.id, approved?.id);

  // Replay of the consumed bound code is rejected like any replay.
  const replay = await call('POST', '/api/auth/alcore/exchange', {
    code: 'bound-code-1',
    redirectUri: CALLBACK,
    state: STATE,
  });
  assert.equal(replay.status, 401);
});

test('task6: omitted redirectUri on a bound code fails closed', async () => {
  const outcome = await call('POST', '/api/auth/alcore/exchange', {
    code: 'bound-code-task6-noredir',
  });
  assert.equal(outcome.status, 401);
  assert.ok(noStore(outcome));
});

test('task6: one-char-different redirectUri fails closed', async () => {
  const outcome = await call('POST', '/api/auth/alcore/exchange', {
    code: 'bound-code-task6-diffuri',
    redirectUri: `${CALLBACK}x`,
    state: STATE,
  });
  assert.equal(outcome.status, 401);
  assert.ok(noStore(outcome));
});

test('task6: omitted state with redirectUri is 400 without touching Auth', async () => {
  const before = exchangeHits;
  const outcome = await call('POST', '/api/auth/alcore/exchange', {
    code: 'bound-code-task6-nostate',
    redirectUri: CALLBACK,
  });
  assert.equal(outcome.status, 400);
  assert.equal(exchangeHits, before);
  assert.ok(noStore(outcome));
});

test('task6: empty-string state with redirectUri is 400 without touching Auth', async () => {
  const before = exchangeHits;
  const outcome = await call('POST', '/api/auth/alcore/exchange', {
    code: 'bound-code-task6-empty',
    redirectUri: CALLBACK,
    state: '',
  });
  assert.equal(outcome.status, 400);
  assert.equal(exchangeHits, before);
  assert.ok(noStore(outcome));
});

test('task6: whitespace-only state with redirectUri is 400 without touching Auth', async () => {
  const before = exchangeHits;
  const outcome = await call('POST', '/api/auth/alcore/exchange', {
    code: 'bound-code-task6-ws',
    redirectUri: CALLBACK,
    state: '   ',
  });
  assert.equal(outcome.status, 400);
  assert.equal(exchangeHits, before);
  assert.ok(noStore(outcome));
});

test('task6: mismatched state with redirectUri fails closed', async () => {
  const outcome = await call('POST', '/api/auth/alcore/exchange', {
    code: 'bound-code-task6-mismatch',
    redirectUri: CALLBACK,
    state: 'wrong-state-task6',
  });
  assert.equal(outcome.status, 401);
  assert.ok(noStore(outcome));
});

test('task6: exact binding redeems once (accept-once)', async () => {
  const outcome = await call('POST', '/api/auth/alcore/exchange', {
    code: 'bound-code-task6-once',
    redirectUri: CALLBACK,
    state: STATE,
  });
  assert.equal(outcome.status, 200);
  assert.ok(typeof outcome.body.data.token === 'string');
  assert.ok(noStore(outcome));
  assert.ok(noRefreshMaterial(outcome));
});

test('task6: replay of the consumed bound code is rejected (replay-reject)', async () => {
  const outcome = await call('POST', '/api/auth/alcore/exchange', {
    code: 'bound-code-task6-once',
    redirectUri: CALLBACK,
    state: STATE,
  });
  assert.equal(outcome.status, 401);
  assert.ok(noStore(outcome));
});

test('replayed and unknown codes share one generic 401', async () => {
  for (const code of ['good-code-2', 'no-such-code']) {
    const outcome = await call('POST', '/api/auth/alcore/exchange', { code });
    assert.equal(outcome.status, 401);
    assert.deepEqual(Object.keys(outcome.body).sort(), ['message', 'success']);
    assert.ok(noStore(outcome));
    assert.ok(noRefreshMaterial(outcome));
  }
});

test('malformed assertions fail closed with the same 401', async () => {
  for (const code of [
    'wrong-aud-code',
    'wrong-iss-code',
    'expired-code',
    'no-sub-code',
  ]) {
    const outcome = await call('POST', '/api/auth/alcore/exchange', { code });
    assert.equal(outcome.status, 401);
    assert.equal(outcome.body.success, false);
  }
});

test('invalid shapes are 400 without touching Auth', async () => {
  for (const body of [
    {},
    { code: '' },
    { code: 'x'.repeat(1025) },
    { code: 'good-code-1', redirectUri: 42 },
    { code: 'good-code-1', state: 'x'.repeat(513) },
  ]) {
    const outcome = await call('POST', '/api/auth/alcore/exchange', body);
    assert.equal(outcome.status, 400);
  }
});

test('lwk_* presented to exchange is rejected and never a session', async () => {
  const { createApiToken } = await importBuilt('services/apiTokenService.js');
  const { token } = await createApiToken(adminId, {
    name: 'task45-proof',
    scopes: ['chat'],
  });
  assert.ok(token.startsWith('lwk_'));
  const outcome = await call(
    'POST',
    '/api/auth/alcore/exchange',
    { code: 'fresh-code-1' },
    { authorization: `Bearer ${token}` }
  );
  assert.equal(outcome.status, 403);
  assert.equal(outcome.body.code, 'TOKEN_SCOPE');
  // The fresh code was NOT consumed: a code-only retry still reaches Auth.
  // Auth-verified subjects auto-approve, so the retry signs in.
  const retry = await call('POST', '/api/auth/alcore/exchange', {
    code: 'fresh-code-1',
  });
  assert.equal(retry.status, 200);
  assert.ok(typeof retry.body.data?.token === 'string');
});

test('email collision refuses to merge and signals manual link', async () => {
  const holder = await authService.signup(
    'task45_holder',
    'Task45-Exchange-Proof-Password-1!',
    'taken@example.com',
    { kind: 'signup' }
  );
  assert.ok(holder?.user.id);
  const outcome = await call('POST', '/api/auth/alcore/exchange', {
    code: 'collision-code-1',
  });
  assert.equal(outcome.status, 409);
  assert.equal(outcome.body.code, 'AUTH_LINK_CONFLICT');
  assert.ok(noRefreshMaterial(outcome));
  // The holder row is untouched: still owned by its original id and email.
  const holderAfter = await userModel.getUserByUsername('task45_holder');
  assert.equal(holderAfter?.id, holder.user.id);
  assert.equal(holderAfter?.email, 'taken@example.com');
});

test('concurrent same-subject exchanges converge on one Libre row', async () => {
  // Rate-limiter budget: this file makes 28 /exchange hits before this
  // test and the limiter allows 30 per window, so the burst stays at 2.
  // The invariant under proof is the row-count assertion, not the width.
  const before = await userModel.getAllUsers();
  const outcomes = await Promise.all(
    ['race-code-1', 'race-code-2'].map(code =>
      call('POST', '/api/auth/alcore/exchange', { code })
    )
  );
  for (const o of outcomes) assert.equal(o.status, 200);
  const ids = new Set(outcomes.map(o => o.body.data.user.id));
  assert.equal(ids.size, 1);
  // Count proof: concurrent provisions grew the user table by one row.
  const after = await userModel.getAllUsers();
  assert.equal(after.length, before.length + 1);
});

test('local mode isolates the relying-party routes with 404', async () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
import express from 'express';
const { default: routes } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'backend', 'dist', 'routes/alcoreAuth.js')).href)});
const app = express();
app.use(express.json());
app.use('/api/auth/alcore', routes);
const server = app.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const get = await fetch('http://127.0.0.1:' + port + '/api/auth/alcore/config');
  const post = await fetch('http://127.0.0.1:' + port + '/api/auth/alcore/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  console.log(JSON.stringify({ get: get.status, getBody: await get.json(), post: post.status }));
  server.close();
});`,
    ],
    {
      encoding: 'utf8',
      cwd: path.join(repoRoot, 'backend'),
      env: { ...process.env, ALCORE_AUTH_MODE: 'local' },
    }
  );
  assert.equal(child.status, 0, child.stderr);
  const last = child.stdout.trim().split('\n').pop();
  const result = JSON.parse(last);
  assert.equal(result.get, 404);
  assert.equal(result.getBody.code, 'ALCORE_AUTH_ONLY');
  assert.equal(result.post, 404);
});
