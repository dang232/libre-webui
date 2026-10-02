/*
 * TokenPanel BFF Auth-session migration proof (gap2-bff, R-BFF1).
 *
 * Proves, in Alcore mode (`ALCORE_AUTH_MODE=alcore`, frozen at import like
 * production boot), against a stubbed TokenPanel:
 * - keys, projects, usage, billing, and account flows work on the caller's
 *   Auth-derived Libre session with the bridge stubbed 401 (bridge JWT no
 *   longer required): zero bridge resolve/mint calls, upstream bearer is the
 *   Auth session, `tp_mgmt_*` never rides a customer endpoint or a response;
 * - POST /api/auth/tokenpanel/portal-token returns the caller Auth session
 *   as the grant with zero bridge calls;
 * - non-Auth sessions (password kind, legacy token, missing) answer 401
 *   AUTH_SESSION_REQUIRED; `lwk_*` API tokens answer 403 (never a session);
 * - bridge fallback keeps flows green when the upstream rejects the Auth
 *   session (stub flips: bridge succeeds, session bearer 401s).
 *
 * Local-mode byte-identical behavior is covered by the existing suites
 * (test-tokenpanel-bridge/account/keys-projects/usage/billing), re-run
 * alongside this file for the gap2-bff lane.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

process.env.ALCORE_AUTH_MODE = 'alcore';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-gap2-bff-'));
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = '7'.repeat(64);
process.env.JWT_SECRET = 'gap2-bff-auth-session-secret-long-enough';
process.env.ENABLE_SIGNUP = 'true';
process.env.TOKENPANEL_API_URL = 'http://tokenpanel.test';
process.env.TOKENPANEL_MGMT_KEY = 'tp_mgmt_gap2_testkey';

const importBuilt = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);

const [
  { authService },
  { createApiToken },
  database,
  expressMod,
  coordinatorMod,
  keysRoute,
  usageRoute,
  billingRoute,
  accountRoute,
  authRoute,
] = await Promise.all([
  importBuilt('services/authService.js'),
  importBuilt('services/apiTokenService.js'),
  importBuilt('db.js'),
  import('express'),
  importBuilt('platform/coordination/service.js'),
  importBuilt('routes/tokenpanel.js'),
  importBuilt('routes/tokenpanelUsage.js'),
  importBuilt('routes/tokenpanelBilling.js'),
  importBuilt('routes/tokenpanelAccount.js'),
  importBuilt('routes/auth.js'),
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

/**
 * Stub TokenPanel. Bridge endpoints 401 while `bridgeDown` (the migration
 * proof); customer endpoints accept ONLY the Auth-derived Libre session
 * bearer while `sessionUp` (direct Auth-session validation stand-in).
 * Flipping both proves the flag-gated bridge fallback.
 */
const calls = { bridge: [], customer: [] };
const stub = {
  bridgeDown: true,
  sessionUp: true,
  sessionBearer: null,
  fallbackBearer: 'customer-jwt-fallback-cust-9',
};
const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  json: async () => body,
});
const responder = (url, init = {}) => {
  const u = String(url);
  const headers = init.headers || {};
  const auth = headers.Authorization || headers.authorization;
  if (u.includes('/api/management/')) {
    calls.bridge.push({ url: u, auth });
    if (stub.bridgeDown) return json(401, { error: 'unauthorized' });
    if (auth !== 'Bearer tp_mgmt_gap2_testkey') {
      return json(401, { error: 'unauthorized' });
    }
    if (u.endsWith('/customers/bridge-resolve')) {
      return json(200, {
        customer: { _id: 'cust-9' },
        customerId: 'cust-9',
        linked: 'existing',
      });
    }
    if (/\/customers\/[^/]+\/portal-token$/.test(u)) {
      return json(200, {
        token: stub.fallbackBearer,
        expiresAt: '2030-01-01T00:02:00.000Z',
      });
    }
    throw new Error(`unexpected management call ${u}`);
  }
  if (u.includes('/public/customers/')) {
    calls.customer.push({ url: u, auth });
    const sessionOk =
      stub.sessionUp &&
      stub.sessionBearer !== null &&
      auth === `Bearer ${stub.sessionBearer}`;
    if (!sessionOk && auth !== `Bearer ${stub.fallbackBearer}`) {
      return json(401, { error: 'unauthorized' });
    }
    if (u.endsWith('/public/customers/keys')) {
      return json(200, {
        items: [{ _id: '68d7a1b2c3d4e5f60718293b', name: 'stub-key' }],
        total: 1,
      });
    }
    if (u.endsWith('/public/customers/me/projects')) {
      return json(200, {
        projects: [{ _id: 'p1', name: 'stub', keyCount: 1 }],
      });
    }
    if (u.endsWith('/public/customers/me/usage')) {
      return json(200, { totals: { costMicros: 1000 }, currency: 'USD' });
    }
    if (u.endsWith('/public/customers/me/billing')) {
      return json(200, { history: [] });
    }
    if (u.endsWith('/public/customers/me/subscription')) {
      return json(200, { plan: 'free', status: 'active' });
    }
    if (u.endsWith('/public/customers/me')) {
      return json(200, {
        _id: 'cust-9',
        name: 'Stub',
        email: 'gap2@example.test',
      });
    }
    return json(404, { error: 'not_found' });
  }
  throw new Error(`unexpected TokenPanel call ${u}`);
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('http://127.0.0.1')) {
    return realFetch(url, init);
  }
  return responder(url, init);
};

const app = expressMod.default();
app.use(expressMod.default.json());
app.use('/api/tokenpanel', keysRoute.default);
app.use('/api/tokenpanel', usageRoute.default);
app.use('/api/tokenpanel', billingRoute.default);
app.use('/api/tokenpanel', accountRoute.default);
app.use('/api/auth', authRoute.default);
const server = await new Promise(resolve => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
});
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => new Promise(resolve => server.close(resolve)));

const bffResponses = [];
const bff = async (method, path, token, body) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
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

const { user: createdUser } = await authService.signup(
  'gap2_user',
  'Gap2-Test-123!x',
  'gap2@example.test',
  { kind: 'signup', ip: '203.0.113.7', userAgent: 'node-test' }
);
const userModel = await importBuilt('models/userModel.js').then(
  m => m.userModel
);
const stored = await userModel.getUserById(createdUser.id);
// Auth-derived session: exactly what POST /api/auth/alcore/exchange mints
// after the S2S Auth code exchange (kind alcore-auth, Auth subject linked).
const authSessionToken = await authService.issueSession(stored, {
  kind: 'alcore-auth',
  ip: '203.0.113.7',
  userAgent: 'node-test',
});
const localSessionToken = await authService.issueSession(stored, {
  kind: 'password',
  ip: '203.0.113.7',
  userAgent: 'node-test',
});
const legacyToken = authService.generateToken(stored);
const { token: apiToken } = await createApiToken(stored.id, {
  name: 'gap2-panel-probe',
  scopes: ['admin'],
});
stub.sessionBearer = authSessionToken;

// Drain the fire-and-forget provision hook (bridge path, no session token),
// then reset the call logs so per-site assertions measure only the flow.
await importBuilt('services/apiPlatformProvisionService.js').then(m =>
  m.ensureApiPlatformProvision(stored.id)
);
calls.bridge.length = 0;
calls.customer.length = 0;
bffResponses.length = 0;

const customerBearers = () =>
  calls.customer.map(call => String(call.auth || ''));

test('keys list works on the Auth session with the bridge down', async () => {
  const res = await bff('GET', '/api/tokenpanel/keys', authSessionToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.total, 1);
  assert.equal(calls.bridge.length, 0, 'zero bridge calls on the Auth path');
  assert.ok(
    customerBearers().every(h => h === `Bearer ${authSessionToken}`),
    'upstream rides the Auth session only'
  );
});

test('projects list works on the Auth session with the bridge down', async () => {
  const res = await bff('GET', '/api/tokenpanel/projects', authSessionToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.projects.length, 1);
  assert.equal(calls.bridge.length, 0, 'zero bridge calls on the Auth path');
});

test('usage summary works on the Auth session with the bridge down', async () => {
  const res = await bff(
    'GET',
    '/api/tokenpanel/usage/summary',
    authSessionToken
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.data.currency, 'USD');
  assert.equal(calls.bridge.length, 0, 'zero bridge calls on the Auth path');
});

test('billing history works on the Auth session with the bridge down', async () => {
  const res = await bff(
    'GET',
    '/api/tokenpanel/billing/history',
    authSessionToken
  );
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.history, []);
  assert.equal(calls.bridge.length, 0, 'zero bridge calls on the Auth path');
});

test('account subscription works on the Auth session with the bridge down', async () => {
  const res = await bff(
    'GET',
    '/api/tokenpanel/account/subscription',
    authSessionToken
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.data.plan, 'free');
  assert.equal(calls.bridge.length, 0, 'zero bridge calls on the Auth path');
});

test('portal-token returns the Auth session grant with the bridge down', async () => {
  const res = await bff(
    'POST',
    '/api/auth/tokenpanel/portal-token',
    authSessionToken
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.data.token, authSessionToken);
  assert.ok(
    !Number.isNaN(Date.parse(res.body.data.expiresAt)),
    'grant carries a valid expiry'
  );
  assert.equal(calls.bridge.length, 0, 'zero bridge calls on the Auth path');
});

test('password-kind session is rejected on BFF routes in Alcore mode', async () => {
  const res = await bff('GET', '/api/tokenpanel/keys', localSessionToken);
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'AUTH_SESSION_REQUIRED');
});

test('legacy session-less token is rejected on BFF routes in Alcore mode', async () => {
  const res = await bff('GET', '/api/tokenpanel/usage/summary', legacyToken);
  assert.equal(res.status, 401);
});

test('lwk_ API token is never a session on BFF routes', async () => {
  assert.ok(apiToken.startsWith('lwk_'), 'probe uses a real lwk_ token');
  const res = await bff('GET', '/api/tokenpanel/keys', apiToken);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'TOKEN_SCOPE');
});

test('lwk_ API token is rejected on the portal-token route', async () => {
  const res = await bff('POST', '/api/auth/tokenpanel/portal-token', apiToken);
  assert.equal(res.status, 403);
});

test('bridge fallback keeps the flow green when the Auth session is refused upstream', async () => {
  stub.sessionUp = false;
  stub.bridgeDown = false;
  calls.bridge.length = 0;
  const res = await bff('GET', '/api/tokenpanel/keys', authSessionToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.total, 1);
  assert.ok(calls.bridge.length > 0, 'fallback minted through the bridge');
  assert.ok(
    customerBearers().includes(`Bearer ${stub.fallbackBearer}`),
    'retry rode the bridge-minted grant'
  );
  stub.sessionUp = true;
  stub.bridgeDown = true;
});

test('credential boundaries: no management key anywhere it must not be', async () => {
  for (const header of customerBearers()) {
    assert.ok(!header.includes('tp_mgmt_'), 'mgmt key never rides upstream');
  }
  for (const text of bffResponses) {
    assert.ok(!text.includes('tp_mgmt_'), 'mgmt key never reaches the browser');
    assert.ok(
      !text.includes('tp_mgmt_gap2_testkey'),
      'mgmt key value never reaches the browser'
    );
  }
  assert.ok(
    !customerBearers().some(h => h.startsWith('Bearer lwk_')),
    'lwk_ never rides upstream'
  );
});
