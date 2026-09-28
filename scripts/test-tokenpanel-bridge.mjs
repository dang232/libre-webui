/*
 * TokenPanel single-login bridge, fail-closed (todo 13).
 *
 * Covers: resolving a Libre session to a portal token through the
 * server-side bridge-resolve endpoint (exact identity, collision → 409),
 * first-resolve create vs existing/linked mapping, Idempotency-Key forward,
 * fail-closed 503 without a management key, 503 on rejected management key,
 * 401 unknown account, 400 missing email / bad idempotency key, parallel
 * identical exchanges converging on one customer, and a grep-gate proving
 * no `limit=1` silent-pick remains on the bridge path.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'libre-tokenpanel-bridge-')
);
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = '1'.repeat(64);
process.env.JWT_SECRET = 'tokenpanel-bridge-test-secret-that-is-long-enough';
process.env.ENABLE_SIGNUP = 'true';
process.env.TOKENPANEL_API_URL = 'http://tokenpanel.test';
process.env.TOKENPANEL_MGMT_KEY = 'tp_mgmt_testkey';

const importBuilt = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);
const [{ authService }, bridge, database] = await Promise.all([
  importBuilt('services/authService.js'),
  importBuilt('services/tokenpanelBridgeService.js'),
  importBuilt('db.js'),
]);

test.after(() => {
  database.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const calls = [];
const stubFetch = responder => {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  };
};
const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** In-memory TokenPanel stub with atomic find-or-create resolve semantics. */
const makeResolveStub = ({ onResolve } = {}) => {
  const rows = [];
  return {
    rows,
    responder: (url, init) => {
      if (url.endsWith('/api/management/customers/bridge-resolve')) {
        const body = JSON.parse(init.body);
        if (onResolve) return onResolve(body, init);
        let row = rows.find(r => r.authUserId === body.authUserId);
        let linked = 'existing';
        if (!row) {
          row = {
            _id: `cust-${rows.length + 1}`,
            authUserId: body.authUserId,
            email: body.email,
          };
          rows.push(row);
          linked = 'created';
        }
        return jsonResponse(200, {
          customer: row,
          customerId: row._id,
          linked,
        });
      }
      const mint = url.match(
        /\/api\/management\/customers\/([^/]+)\/portal-token$/
      );
      if (mint && init.method === 'POST') {
        return jsonResponse(200, {
          token: 'aaa.bbb.ccc',
          expiresAt: '2030-01-01T00:02:00.000Z',
        });
      }
      throw new Error(`unexpected TokenPanel call ${url}`);
    },
  };
};

const signup = (username, email) =>
  authService.signup(username, 'Bridge-Test-123!x', email, {
    kind: 'signup',
    ip: '203.0.113.9',
    userAgent: 'node-test',
  });

test('bridge resolves through bridge-resolve with identity + idempotency key', async () => {
  const created = await signup('bridge_user', 'bridge@example.test');
  const userId = created.user.id;
  const stub = makeResolveStub();
  let resolveInit;
  const inner = stub.responder;
  stubFetch((url, init) => {
    if (url.endsWith('/bridge-resolve')) resolveInit = init;
    return inner(url, init);
  });

  const grant = await bridge.exchangePortalToken(userId, {
    idempotencyKey: 'client-key-1',
  });
  assert.equal(grant.linked, 'created');
  assert.equal(grant.customerId, 'cust-1');
  assert.equal(grant.token, 'aaa.bbb.ccc');
  assert.equal(typeof grant.expiresAt, 'string');
  const sent = JSON.parse(resolveInit.body);
  assert.equal(sent.authUserId, userId);
  assert.equal(sent.email, 'bridge@example.test');
  assert.equal(resolveInit.headers['Idempotency-Key'], 'client-key-1');
  assert.ok(
    !calls.some(c => c.url.includes('limit=1')),
    'no limit=1 lookup on the bridge path'
  );
  assert.ok(
    !calls.some(c => c.url.endsWith('/public/customers/register')),
    'client never calls public register anymore'
  );

  // Second exchange: server reports linked → client maps to existing.
  const linked = await bridge.exchangePortalToken(userId);
  assert.equal(linked.linked, 'existing');
  assert.equal(linked.customerId, 'cust-1');
  assert.equal(stub.rows.length, 1);
});

test('bridge collision denies with 409 and is auditable by status', async () => {
  const created = await signup('bridge_dup', 'dup@example.test');
  stubFetch(() => jsonResponse(409, { error: 'bridge_email_collision' }));
  await assert.rejects(
    () => bridge.exchangePortalToken(created.user.id),
    error => {
      assert.equal(error.status, 409);
      return true;
    }
  );
});

test('bridge rejects a bad management key as 503 without leaking', async () => {
  const created = await signup('bridge_badkey', 'badkey@example.test');
  stubFetch(url => {
    if (url.endsWith('/bridge-resolve'))
      return jsonResponse(401, { error: 'unauthorized' });
    throw new Error(`unexpected TokenPanel call ${url}`);
  });
  await assert.rejects(
    () => bridge.exchangePortalToken(created.user.id),
    error => {
      assert.equal(error.status, 503);
      return true;
    }
  );
});

test('bridge fails closed without a management key or email', async () => {
  const created = await signup('bridge_nomail2', 'nomail2@example.test');
  calls.length = 0;
  delete process.env.TOKENPANEL_MGMT_KEY;
  await assert.rejects(
    () => bridge.exchangePortalToken(created.user.id),
    error => {
      assert.equal(error.status, 503);
      return true;
    }
  );
  assert.equal(calls.length, 0);
  process.env.TOKENPANEL_MGMT_KEY = 'tp_mgmt_testkey';

  const noMail = await signup('bridge_nomail', null);
  calls.length = 0;
  await assert.rejects(
    () => bridge.exchangePortalToken(noMail.user.id),
    error => {
      assert.equal(error.status, 400);
      return true;
    }
  );
  assert.equal(calls.length, 0);

  await assert.rejects(
    () => bridge.exchangePortalToken('missing-user-id'),
    error => {
      assert.equal(error.status, 401);
      return true;
    }
  );

  await assert.rejects(
    () =>
      bridge.exchangePortalToken(created.user.id, {
        idempotencyKey: 'x'.repeat(129),
      }),
    error => {
      assert.equal(error.status, 400);
      return true;
    }
  );
});

test('parallel identical exchanges converge on one customer', async () => {
  const created = await signup('bridge_race', 'racer@example.test');
  const stub = makeResolveStub();
  stubFetch(stub.responder);
  const grants = await Promise.all(
    Array.from({ length: 10 }, () =>
      bridge.exchangePortalToken(created.user.id)
    )
  );
  assert.equal(stub.rows.length, 1);
  assert.ok(grants.every(g => g.customerId === 'cust-1'));
  assert.equal(grants.filter(g => g.linked === 'created').length, 1);
});

test('built bridge service has no limit=1 silent-pick', async () => {
  const built = fs.readFileSync(
    path.resolve('backend/dist/services/tokenpanelBridgeService.js'),
    'utf8'
  );
  const code = built
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
  assert.ok(
    !code.includes('limit=1'),
    'limit=1 must not appear in the bridge client'
  );
  assert.ok(
    !code.includes('limit%3D1'),
    'encoded limit=1 must not appear either'
  );
  assert.ok(
    built.includes('bridge-resolve'),
    'client resolves through the fail-closed endpoint'
  );
});
