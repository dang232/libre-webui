/*
 * Libre BFF keys + projects via TokenPanel (Wave4 todo 19).
 *
 * Proves, against a stubbed TokenPanel that enforces the real upstream
 * auth rules (public surface: customer JWT only; management: tp_mgmt_*
 * only), that:
 * - a Libre browser session presented DIRECTLY upstream fails 401
 *   (failing-first: the browser can never talk to TokenPanel itself),
 * - the same flow through the BFF (session only in, management creds
 *   attached server-side) succeeds end-to-end:
 *   create -> list (fingerprint only) -> reveal-once -> rotate (new
 *   secret, old revoked) -> revoke -> rotate-revoked 409,
 * - projects list works and carries per-project key counts,
 * - secret-bearing BFF responses carry `Cache-Control: no-store`,
 * - no BFF response, and no upstream public call, carries `tp_mgmt_*`,
 * - upstream 401 (invalid grant) surfaces as BFF 401 so the browser
 *   invalidates the session (shared contract with todo 22),
 * - validation is fail-closed (400 bad payload/key, 404 bad id,
 *   401 no session).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-task19-keys-'));
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = '3'.repeat(64);
process.env.JWT_SECRET = 'task19-keys-projects-secret-long-enough-12';
process.env.ENABLE_SIGNUP = 'true';
process.env.TOKENPANEL_API_URL = 'http://tokenpanel.test';
process.env.TOKENPANEL_MGMT_KEY = 'tp_mgmt_testkey_tasks19';

const importBuilt = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);

const [{ authService }, database, expressMod, coordinatorMod, routeMod] =
  await Promise.all([
    importBuilt('services/authService.js'),
    importBuilt('db.js'),
    import('express'),
    importBuilt('platform/coordination/service.js'),
    importBuilt('routes/tokenpanel.js'),
  ]);

await coordinatorMod.initializeCoordinator();

test.after(async () => {
  try {
    await coordinatorMod.closeCoordinator();
  } catch {
    // Local coordinator teardown is best-effort in the harness.
  }
  database.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** In-memory TokenPanel enforcing the real auth boundary. */
const upstreamAuthHeaders = [];
const makeUpstream = () => {
  const state = {
    customers: [],
    keys: [],
    seq: 0,
    rejectGrants: false,
  };
  const mintFor = customerId => `customer-jwt-${customerId}`;
  const customerIdOf = auth =>
    typeof auth === 'string' && auth.startsWith('Bearer customer-jwt-')
      ? auth.slice('Bearer customer-jwt-'.length)
      : null;

  const responder = (url, init = {}) => {
    const u = String(url);
    const headers = init.headers || {};
    const auth = headers.Authorization || headers.authorization;
    const json = (status, body) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      json: async () => body,
    });

    if (u.includes('/api/management/')) {
      if (auth !== 'Bearer tp_mgmt_testkey_tasks19') {
        return json(401, { error: 'unauthorized' });
      }
      if (u.endsWith('/customers/bridge-resolve')) {
        const body = JSON.parse(init.body);
        let row = state.customers.find(c => c.authUserId === body.authUserId);
        let linked = 'existing';
        if (!row) {
          row = {
            _id: `cust-${state.customers.length + 1}`,
            authUserId: body.authUserId,
            email: body.email,
          };
          state.customers.push(row);
          linked = 'created';
        }
        return json(200, { customer: row, customerId: row._id, linked });
      }
      const mint = u.match(/\/customers\/([^/]+)\/portal-token$/);
      if (mint && init.method === 'POST') {
        return json(200, {
          token: mintFor(mint[1]),
          expiresAt: '2030-01-01T00:02:00.000Z',
        });
      }
      throw new Error(`unexpected management call ${u}`);
    }

    if (u.includes('/public/customers/')) {
      upstreamAuthHeaders.push(auth);
      if (state.rejectGrants) return json(401, { error: 'unauthorized' });
      const customerId = customerIdOf(auth);
      if (!customerId) return json(401, { error: 'unauthorized' });
      const method = init.method || 'GET';
      const path = u.split('/public/customers')[1].split('?')[0];

      if (method === 'GET' && path === '/keys') {
        const items = state.keys
          .filter(k => k.customerId === customerId)
          .map(({ secret, ...publicPart }) => publicPart);
        return json(200, { items, total: items.length });
      }
      if (method === 'POST' && path === '/keys') {
        const body = JSON.parse(init.body);
        state.seq += 1;
        const row = {
          _id: `aaaaaaaaaaaaaaaaaaaaaaaa${state.seq}`.slice(-24),
          customerId,
          name: body.name,
          prefix: 'tp_live_testprefix',
          fingerprint: `fp-${state.seq}`,
          status: 'active',
          quotaMicros: body.quotaMicros ?? null,
        };
        const secret = `tp_live_secret_${state.seq}_only_once`;
        state.keys.push({ ...row, secret });
        return json(201, { apiKey: row, key: secret });
      }
      const reveal = path.match(/^\/keys\/([^/]+)\/reveal$/);
      if (method === 'POST' && reveal) {
        const row = state.keys.find(
          k => k._id === reveal[1] && k.customerId === customerId
        );
        if (!row) return json(404, { error: 'not_found' });
        return json(200, { key: row.secret });
      }
      const rotate = path.match(/^\/keys\/([^/]+)\/rotate$/);
      if (method === 'POST' && rotate) {
        const row = state.keys.find(
          k => k._id === rotate[1] && k.customerId === customerId
        );
        if (!row) return json(404, { error: 'not_found' });
        if (row.status !== 'active') {
          return json(409, { error: 'key_revoked' });
        }
        state.seq += 1;
        row.status = 'revoked';
        row.rotatedTo = `new-${state.seq}`;
        const next = {
          _id: `bbbbbbbbbbbbbbbbbbbbbbbb${state.seq}`.slice(-24),
          customerId,
          name: row.name,
          prefix: 'tp_live_testprefix',
          fingerprint: `fp-${state.seq}`,
          status: 'active',
          quotaMicros: row.quotaMicros,
        };
        const secret = `tp_live_secret_${state.seq}_only_once`;
        state.keys.push({ ...next, secret });
        return json(200, { apiKey: next, key: secret, graceExpiresAt: null });
      }
      const keyOp = path.match(/^\/keys\/([^/]+)$/);
      if (keyOp) {
        const row = state.keys.find(
          k => k._id === keyOp[1] && k.customerId === customerId
        );
        if (!row) return json(404, { error: 'not_found' });
        if (method === 'PATCH') {
          Object.assign(row, JSON.parse(init.body));
          const { secret, ...publicPart } = row;
          return json(200, publicPart);
        }
        if (method === 'DELETE') {
          if (u.includes('purge=true')) {
            state.keys = state.keys.filter(k => k !== row);
          } else {
            row.status = 'revoked';
          }
          const { secret, ...publicPart } = row;
          return json(200, publicPart);
        }
      }
      if (method === 'GET' && path === '/me/projects') {
        const counts = new Map();
        for (const k of state.keys) {
          if (k.customerId !== customerId) continue;
          const pid = k.projectId ?? 'proj-shared';
          counts.set(pid, (counts.get(pid) ?? 0) + 1);
        }
        return json(200, {
          items: [
            {
              id: 'proj-shared',
              name: 'Shared',
              slug: 'shared',
              status: 'active',
              keyCount: counts.get('proj-shared') ?? 0,
            },
          ],
        });
      }
      throw new Error(`unexpected public call ${method} ${path}`);
    }
    throw new Error(`unexpected upstream call ${u}`);
  };

  return { state, responder };
};

const upstream = makeUpstream();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  // The harness drives the BFF over loopback HTTP; only TokenPanel hosts
  // are stubbed. Everything else passes through to the real fetch.
  if (String(url).startsWith('http://127.0.0.1')) {
    return realFetch(url, init);
  }
  return upstream.responder(url, init);
};

// --- Harness: real Libre session + real BFF router over HTTP ---

const app = expressMod.default();
app.use(expressMod.default.json());
app.use('/api/tokenpanel', routeMod.default);
const server = await new Promise(resolve => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
});
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => new Promise(resolve => server.close(resolve)));

const bffResponses = [];
const bff = async (method, path, token, body, extraHeaders) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(extraHeaders || {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  bffResponses.push(text);
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON bodies stay null; status/header assertions still apply.
  }
  return { status: response.status, headers: response.headers, body: parsed };
};

const signup = (username, email) =>
  authService.signup(username, 'Keys-Test-123!x', email, {
    kind: 'signup',
    ip: '203.0.113.9',
    userAgent: 'node-test',
  });

const { user: createdUser } = await signup('keys_user', 'keys@example.test');
const stored = await importBuilt('models/userModel.js').then(m =>
  m.userModel.getUserById(createdUser.id)
);
const libreToken = await authService.issueSession(stored, {
  kind: 'signup',
  ip: '203.0.113.9',
  userAgent: 'node-test',
});

// Auto base-usage (todo 19 flowfix) mints a `libre-auto` platform key for
// every fresh session via a fire-and-forget hook. Drain it deterministically
// (idempotent) so the stub customer below starts from the intended state:
// exactly one fingerprint-only auto key, never a secret.
await importBuilt('services/apiPlatformProvisionService.js').then(m =>
  m.ensureApiPlatformProvision(createdUser.id)
);

test('direct upstream call with the Libre session fails 401 (browser can never go direct)', async () => {
  const direct = await fetch('http://tokenpanel.test/public/customers/keys', {
    headers: { Authorization: `Bearer ${libreToken}` },
  });
  assert.equal(direct.status, 401);
});

test('keys create -> list (no secret) -> reveal-once -> rotate -> revoke', async () => {
  const empty = await bff('GET', '/api/tokenpanel/keys', libreToken);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.data.total, 1);
  assert.equal(empty.body.data.items.length, 1);
  assert.equal(empty.body.data.items[0].name, 'libre-auto');
  assert.ok(
    !('key' in empty.body.data.items[0]),
    'auto key list carries fingerprint only, never the secret'
  );

  const created = await bff('POST', '/api/tokenpanel/keys', libreToken, {
    name: 'libre-e2e',
    quotaMicros: 5000000,
  });
  assert.equal(created.status, 201);
  assert.equal(
    created.headers.get('cache-control'),
    'no-store',
    'create must be no-store'
  );
  const firstSecret = created.body.data.key;
  assert.match(firstSecret, /^tp_live_/);
  const firstId = created.body.data.apiKey._id;

  const listed = await bff('GET', '/api/tokenpanel/keys', libreToken);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.total, 2);
  assert.ok(
    !JSON.stringify(listed.body).includes(firstSecret),
    'list must carry fingerprint only, never the secret'
  );
  for (const item of listed.body.data.items) {
    assert.ok(!('key' in item), 'no list row carries a secret');
  }

  const revealed = await bff(
    'POST',
    `/api/tokenpanel/keys/${firstId}/reveal`,
    libreToken
  );
  assert.equal(revealed.status, 200);
  assert.equal(
    revealed.headers.get('cache-control'),
    'no-store',
    'reveal must be no-store'
  );
  assert.equal(revealed.body.data.key, firstSecret);

  const rotated = await bff(
    'POST',
    `/api/tokenpanel/keys/${firstId}/rotate`,
    libreToken
  );
  assert.equal(rotated.status, 200);
  assert.equal(rotated.headers.get('cache-control'), 'no-store');
  assert.notEqual(rotated.body.data.key, firstSecret);
  const secondId = rotated.body.data.apiKey._id;
  assert.notEqual(secondId, firstId);

  const afterRotate = await bff('GET', '/api/tokenpanel/keys', libreToken);
  const oldRow = afterRotate.body.data.items.find(k => k._id === firstId);
  assert.equal(oldRow.status, 'revoked', 'rotate revokes the old row');

  const revoked = await bff(
    'DELETE',
    `/api/tokenpanel/keys/${secondId}`,
    libreToken
  );
  assert.equal(revoked.status, 200);

  const rotateRevoked = await bff(
    'POST',
    `/api/tokenpanel/keys/${secondId}/rotate`,
    libreToken
  );
  assert.equal(rotateRevoked.status, 409);
  assert.equal(rotateRevoked.body.code, 'key_revoked');
});

test('projects list works with per-project key counts', async () => {
  const projects = await bff('GET', '/api/tokenpanel/projects', libreToken);
  assert.equal(projects.status, 200);
  assert.equal(projects.body.data.items.length, 1);
  assert.equal(projects.body.data.items[0].slug, 'shared');
  // libre-auto (base usage) + libre-e2e (revoked) + its rotation (revoked).
  assert.equal(projects.body.data.items[0].keyCount, 3);
});

test('boundary is fail-closed: 401/400/404, float quota rejected', async () => {
  const noSession = await bff('GET', '/api/tokenpanel/keys', null);
  assert.equal(noSession.status, 401);

  const noName = await bff('POST', '/api/tokenpanel/keys', libreToken, {});
  assert.equal(noName.status, 400);

  const floatQuota = await bff('POST', '/api/tokenpanel/keys', libreToken, {
    name: 'float-quota',
    quotaMicros: 19.99,
  });
  assert.equal(floatQuota.status, 400);

  const badId = await bff(
    'POST',
    '/api/tokenpanel/keys/not-an-id/reveal',
    libreToken
  );
  assert.equal(badId.status, 404);

  const badKey = await bff(
    'POST',
    '/api/tokenpanel/keys',
    libreToken,
    { name: 'bad-idempotency' },
    { 'Idempotency-Key': 'x'.repeat(129) }
  );
  assert.equal(badKey.status, 400);
});

test('upstream 401 maps to BFF 401 (session-invalid contract)', async () => {
  upstream.state.rejectGrants = true;
  try {
    const res = await bff('GET', '/api/tokenpanel/keys', libreToken);
    assert.equal(res.status, 401);
  } finally {
    upstream.state.rejectGrants = false;
  }
});

test('mgmt key never appears in BFF responses or upstream public calls', async () => {
  const blob = bffResponses.join('\n');
  assert.ok(!blob.includes('tp_mgmt_'), 'BFF response leaked tp_mgmt_*');
  for (const header of upstreamAuthHeaders) {
    assert.ok(
      !String(header || '').includes('tp_mgmt_'),
      'public upstream call carried the management key'
    );
  }
});
