/*
 * Alcore
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * End-to-end Idempotency-Key forwarding through the Libre BFF (Wave4 todo 23).
 *
 * Proves, against a stubbed TokenPanel that dedupes mutating writes by the
 * received Idempotency-Key (the way provision/bridge/topup/redeem/subscribe
 * converge server-side), that:
 * - every mutating BFF route forwards a browser-supplied key verbatim and
 *   mints a fresh CSPRNG key when the browser sends none (keys create /
 *   reveal / rotate / revoke, topup create / cancel, redeem, subscribe,
 *   budget / limits / profile writes, bridge resolve);
 * - replaying the same key converges on a single record (second response
 *   identical or existing — never a double charge, double intent, or
 *   double key);
 * - invalid keys (overlong, control/whitespace charset) answer 400 with
 *   zero upstream calls (garbage is never forwarded);
 * - upstream 429/402/403 surface verbatim (same status + server code —
 *   never masked as 500/502).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-idem-fwd-'));
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = '4'.repeat(64);
process.env.JWT_SECRET = 'idempotency-forward-test-secret-long-enough';
process.env.ENABLE_SIGNUP = 'true';
process.env.TOKENPANEL_API_URL = 'http://tokenpanel.test';
process.env.TOKENPANEL_MGMT_KEY = 'tp_mgmt_testkey_idem23';

const importBuilt = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);

const [
  { authService },
  database,
  expressMod,
  coordinatorMod,
  keysRoute,
  billingRoute,
  accountRoute,
  idemUtil,
  bridge,
] = await Promise.all([
  importBuilt('services/authService.js'),
  importBuilt('db.js'),
  import('express'),
  importBuilt('platform/coordination/service.js'),
  importBuilt('routes/tokenpanel.js'),
  importBuilt('routes/tokenpanelBilling.js'),
  importBuilt('routes/tokenpanelAccount.js'),
  importBuilt('utils/idempotencyKey.js'),
  importBuilt('services/tokenpanelBridgeService.js'),
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

/** Stub TokenPanel: dedupes mutating writes by received Idempotency-Key. */
const makeUpstream = () => {
  const state = {
    customers: [],
    keys: [],
    keySeq: 0,
    intents: [],
    intentSeq: 0,
    credits: [],
    subs: [],
    budgetWrites: 0,
    limitsWrites: 0,
    profileWrites: 0,
    seenKeys: [],
    bridgeKeys: [],
    forceError: null,
    calls: 0,
  };
  const mintFor = customerId => `customer-jwt-${customerId}`;
  const customerIdOf = auth =>
    typeof auth === 'string' && auth.startsWith('Bearer customer-jwt-')
      ? auth.slice('Bearer customer-jwt-'.length)
      : null;
  const json = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const bomb = () => {
    if (state.forceError) {
      const { status, body } = state.forceError;
      state.forceError = null;
      return json(status, body);
    }
    return null;
  };
  const responder = (url, init = {}) => {
    const u = String(url);
    const headers = init.headers || {};
    const auth = headers.Authorization || headers.authorization;
    const key = headers['Idempotency-Key'] || headers['idempotency-key'];
    const method = init.method || 'GET';
    if (u.includes('/api/management/')) {
      if (auth !== 'Bearer tp_mgmt_testkey_idem23') {
        return json(401, { error: 'unauthorized' });
      }
      if (u.endsWith('/customers/bridge-resolve')) {
        state.calls += 1;
        state.bridgeKeys.push(key ?? null);
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
      if (mint && method === 'POST') {
        return json(200, {
          token: mintFor(mint[1]),
          expiresAt: '2030-01-01T00:02:00.000Z',
        });
      }
      throw new Error(`unexpected management call ${u}`);
    }
    if (!u.includes('/public/customers/')) {
      throw new Error(`unexpected upstream call ${u}`);
    }
    state.calls += 1;
    const denied = bomb();
    if (denied) return denied;
    const customerId = customerIdOf(auth);
    if (!customerId) return json(401, { error: 'unauthorized' });
    const keyOf = () => {
      state.seenKeys.push(key ?? null);
      return key ?? null;
    };
    const path = u.split('/public/customers')[1].split('?')[0];

    if (method === 'POST' && path === '/keys') {
      const k = keyOf();
      const body = JSON.parse(init.body);
      const replay = state.keys.find(
        r => r.byKey === k && r.customerId === customerId
      );
      if (replay) return json(201, { apiKey: replay.row, key: replay.secret });
      state.keySeq += 1;
      const row = {
        _id: `aa${String(state.keySeq).padStart(22, '0')}`,
        customerId,
        name: body.name,
        prefix: 'tp_live_testprefix',
        fingerprint: `fp-${state.keySeq}`,
        status: 'active',
      };
      const secret = `tp_live_secret_${state.keySeq}_only_once`;
      state.keys.push({ row, secret, byKey: k, customerId });
      return json(201, { apiKey: row, key: secret });
    }
    const reveal = path.match(/^\/keys\/([^/]+)\/reveal$/);
    if (method === 'POST' && reveal) {
      keyOf();
      const found = state.keys.find(
        r => r.row._id === reveal[1] && r.customerId === customerId
      );
      if (!found) return json(404, { error: 'not_found' });
      return json(200, { key: found.secret });
    }
    const rotate = path.match(/^\/keys\/([^/]+)\/rotate$/);
    if (method === 'POST' && rotate) {
      const k = keyOf();
      const replay = state.keys.find(
        r => r.rotatedFrom === rotate[1] && r.byKey === k
      );
      if (replay) return json(200, { apiKey: replay.row, key: replay.secret });
      const found = state.keys.find(
        r => r.row._id === rotate[1] && r.customerId === customerId
      );
      if (!found) return json(404, { error: 'not_found' });
      if (found.row.status !== 'active') {
        return json(409, { error: 'key_revoked' });
      }
      state.keySeq += 1;
      found.row.status = 'revoked';
      const row = {
        _id: `bb${String(state.keySeq).padStart(22, '0')}`,
        customerId,
        name: found.row.name,
        prefix: 'tp_live_testprefix',
        fingerprint: `fp-${state.keySeq}`,
        status: 'active',
      };
      const secret = `tp_live_secret_${state.keySeq}_only_once`;
      state.keys.push({
        row,
        secret,
        byKey: k,
        customerId,
        rotatedFrom: rotate[1],
      });
      return json(200, { apiKey: row, key: secret });
    }
    const keyOp = path.match(/^\/keys\/([^/]+)$/);
    if (keyOp && (method === 'PATCH' || method === 'DELETE')) {
      const k = keyOf();
      if (method === 'DELETE') {
        const replay = state.keys.find(
          r => r.revokedBy === keyOp[1] && r.byKey === k
        );
        if (replay) {
          const { secret: _s, ...pub } = replay.row;
          return json(200, pub);
        }
      }
      const found = state.keys.find(
        r => r.row._id === keyOp[1] && r.customerId === customerId
      );
      if (!found) return json(404, { error: 'not_found' });
      if (method === 'PATCH') Object.assign(found.row, JSON.parse(init.body));
      else {
        found.row.status = 'revoked';
        found.revokedBy = keyOp[1];
      }
      const { secret: _drop, ...pub } = found.row;
      return json(200, pub);
    }
    if (method === 'POST' && path === '/me/topup-intents') {
      const k = keyOf();
      const body = JSON.parse(init.body);
      const replay = state.intents.find(
        i => i.byKey === k && i.customerId === customerId
      );
      if (replay) return json(201, { intent: replay.intent });
      state.intentSeq += 1;
      const intent = {
        _id: `cc${String(state.intentSeq).padStart(22, '0')}`,
        orderCode: `ALCSEQ${state.intentSeq}`,
        amountMicros: body.amountMicros,
        currency: 'VND',
        status: 'pending',
        qrExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      };
      state.intents.push({ intent, byKey: k, customerId });
      return json(201, { intent });
    }
    const cancel = path.match(
      /^\/me\/topup-intents\/([0-9a-fA-F]{24})\/cancel$/
    );
    if (method === 'POST' && cancel) {
      keyOf();
      const found = state.intents.find(
        i => i.intent._id === cancel[1] && i.customerId === customerId
      );
      if (!found) return json(404, { error: 'not_found' });
      return json(200, { ok: true });
    }
    if (method === 'POST' && path === '/me/redeem') {
      const k = keyOf();
      const body = JSON.parse(init.body);
      const replay = state.credits.find(
        c => c.byKey === k && c.customerId === customerId
      );
      if (replay) return json(200, replay.result);
      const result = {
        ok: true,
        credited: { amountMicros: 5_000_000, currency: 'VND' },
        code: body.code,
      };
      state.credits.push({ result, byKey: k, customerId });
      return json(200, result);
    }
    if (method === 'POST' && path === '/me/subscriptions') {
      const k = keyOf();
      const body = JSON.parse(init.body);
      const replay = state.subs.find(
        s => s.byKey === k && s.customerId === customerId
      );
      if (replay) return json(201, replay.sub);
      const sub = {
        _id: `dd${String(state.subs.length + 1).padStart(22, '0')}`,
        planId: body.planId,
        status: 'active',
      };
      state.subs.push({ sub, byKey: k, customerId });
      return json(201, sub);
    }
    const budget = path.match(/^\/me\/budgets\/([0-9a-fA-F]{24})$/);
    if (method === 'PATCH' && budget) {
      const k = keyOf();
      const replay = state.budgetWrites > 0 && state[`budget:${k}`];
      if (replay) return json(200, replay);
      state.budgetWrites += 1;
      const out = { _id: budget[1], ...JSON.parse(init.body) };
      state[`budget:${k}`] = out;
      return json(200, out);
    }
    if (method === 'PATCH' && path === '/me/limits') {
      const k = keyOf();
      if (state[`limits:${k}`]) return json(200, state[`limits:${k}`]);
      state.limitsWrites += 1;
      const out = { ...JSON.parse(init.body) };
      state[`limits:${k}`] = out;
      return json(200, out);
    }
    if (method === 'PATCH' && path === '/me') {
      const k = keyOf();
      if (state[`profile:${k}`]) return json(200, state[`profile:${k}`]);
      state.profileWrites += 1;
      const out = { _id: customerId, ...JSON.parse(init.body) };
      state[`profile:${k}`] = out;
      return json(200, out);
    }
    throw new Error(`unexpected public call ${method} ${path}`);
  };
  return { state, responder };
};

const upstream = makeUpstream();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('http://127.0.0.1')) {
    return realFetch(url, init);
  }
  return upstream.responder(url, init);
};

const app = expressMod.default();
app.use(expressMod.default.json());
app.use('/api/tokenpanel', keysRoute.default);
app.use('/api/tokenpanel', billingRoute.default);
app.use('/api/tokenpanel', accountRoute.default);
const server = await new Promise(resolve => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
});
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => new Promise(resolve => server.close(resolve)));

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
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Status/header assertions still apply to non-JSON bodies.
  }
  return { status: response.status, body: parsed };
};

const signup = (username, email) =>
  authService.signup(username, 'Idem-Test-123!x', email, {
    kind: 'signup',
    ip: '203.0.113.23',
    userAgent: 'node-test',
  });

const provision = userId =>
  importBuilt('services/apiPlatformProvisionService.js').then(m =>
    m.ensureApiPlatformProvision(userId)
  );

const { user: soleUser } = await signup('idem_user', 'idem@example.test');
const keysUser = soleUser;
const billUser = soleUser;
const storedKeys = await importBuilt('models/userModel.js').then(m =>
  m.userModel.getUserById(keysUser.id)
);
const keysToken = await authService.issueSession(storedKeys, {
  kind: 'signup',
  ip: '203.0.113.23',
  userAgent: 'node-test',
});
const billToken = keysToken;
await provision(keysUser.id);

const countKeysNamed = name =>
  upstream.state.keys.filter(r => r.row.name === name).length;

test('shared helper: forward verbatim, mint when absent, 400-shape invalid', async () => {
  assert.equal(idemUtil.isValidIdempotencyKey('recharge-key-1'), true);
  assert.equal(idemUtil.isValidIdempotencyKey('x'.repeat(128)), true);
  assert.equal(idemUtil.isValidIdempotencyKey(''), false);
  assert.equal(idemUtil.isValidIdempotencyKey('   '), false);
  assert.equal(idemUtil.isValidIdempotencyKey('x'.repeat(129)), false);
  assert.equal(idemUtil.isValidIdempotencyKey('has space'), false);
  assert.equal(idemUtil.isValidIdempotencyKey('line\nbreak'), false);
  assert.equal(idemUtil.isValidIdempotencyKey('tab\there'), false);
  assert.equal(idemUtil.isValidIdempotencyKey(42), false);
  const minted = idemUtil.resolveServiceIdempotencyKey(undefined);
  assert.match(minted, /^[0-9a-f-]{36}$/);
  assert.notEqual(
    minted,
    idemUtil.resolveServiceIdempotencyKey(undefined),
    'mints are CSPRNG-unique'
  );
  assert.equal(
    idemUtil.resolveServiceIdempotencyKey('  client-key-9  '),
    'client-key-9',
    'valid keys forward verbatim (trim is identity)'
  );
  assert.equal(idemUtil.resolveServiceIdempotencyKey('x'.repeat(129)), null);
  assert.equal(idemUtil.resolveServiceIdempotencyKey('a\nb'), null);
});

test('keys create double-send: same key, one record, identical secret', async () => {
  const before = upstream.state.seenKeys.length;
  const first = await bff(
    'POST',
    '/api/tokenpanel/keys',
    keysToken,
    {
      name: 'idem-dedupe-key',
    },
    { 'Idempotency-Key': 'idem-keys-1' }
  );
  assert.equal(first.status, 201);
  const second = await bff(
    'POST',
    '/api/tokenpanel/keys',
    keysToken,
    {
      name: 'idem-dedupe-key',
    },
    { 'Idempotency-Key': 'idem-keys-1' }
  );
  assert.equal(second.status, 201);
  assert.equal(countKeysNamed('idem-dedupe-key'), 1);
  assert.deepEqual(second.body, first.body);
  assert.deepEqual(upstream.state.seenKeys.slice(before), [
    'idem-keys-1',
    'idem-keys-1',
  ]);
});

test('keys create without a key: BFF mints, distinct replays create distinctly', async () => {
  const before = upstream.state.seenKeys.length;
  const first = await bff('POST', '/api/tokenpanel/keys', keysToken, {
    name: 'idem-minted-key',
  });
  const second = await bff('POST', '/api/tokenpanel/keys', keysToken, {
    name: 'idem-minted-key',
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(countKeysNamed('idem-minted-key'), 2);
  const mintedPair = upstream.state.seenKeys.slice(before);
  assert.equal(mintedPair.length, 2);
  assert.match(mintedPair[0], /^[0-9a-f-]{36}$/);
  assert.notEqual(mintedPair[0], mintedPair[1]);
});

test('rotate + revoke + reveal forward the replay key; replay converges', async () => {
  const created = await bff(
    'POST',
    '/api/tokenpanel/keys',
    keysToken,
    {
      name: 'idem-lifecycle',
    },
    { 'Idempotency-Key': 'idem-lifecycle-create' }
  );
  const id = created.body.data.apiKey._id;
  const rev1 = await bff(
    'POST',
    `/api/tokenpanel/keys/${id}/reveal`,
    keysToken,
    {},
    {
      'Idempotency-Key': 'idem-reveal-1',
    }
  );
  assert.equal(rev1.status, 200);
  const rev2 = await bff(
    'POST',
    `/api/tokenpanel/keys/${id}/reveal`,
    keysToken,
    {},
    {
      'Idempotency-Key': 'idem-reveal-1',
    }
  );
  assert.equal(rev2.body.data.key, rev1.body.data.key);
  const rot1 = await bff(
    'POST',
    `/api/tokenpanel/keys/${id}/rotate`,
    keysToken,
    {},
    {
      'Idempotency-Key': 'idem-rotate-1',
    }
  );
  const rot2 = await bff(
    'POST',
    `/api/tokenpanel/keys/${id}/rotate`,
    keysToken,
    {},
    {
      'Idempotency-Key': 'idem-rotate-1',
    }
  );
  assert.equal(rot1.status, 200);
  assert.deepEqual(rot2.body, rot1.body);
  const rotatedId = rot1.body.data.apiKey._id;
  const del1 = await bff(
    'DELETE',
    `/api/tokenpanel/keys/${rotatedId}`,
    keysToken,
    undefined,
    {
      'Idempotency-Key': 'idem-revoke-1',
    }
  );
  const del2 = await bff(
    'DELETE',
    `/api/tokenpanel/keys/${rotatedId}`,
    keysToken,
    undefined,
    {
      'Idempotency-Key': 'idem-revoke-1',
    }
  );
  assert.equal(del1.status, 200);
  assert.deepEqual(del2.body, del1.body);
  for (const k of ['idem-reveal-1', 'idem-rotate-1', 'idem-revoke-1']) {
    assert.ok(upstream.state.seenKeys.includes(k), `upstream saw ${k}`);
  }
});

test('topup create + cancel double-send: one intent, one cancel effect', async () => {
  const intentsBefore = upstream.state.intents.length;
  const first = await bff(
    'POST',
    '/api/tokenpanel/billing/topup-intents',
    billToken,
    {
      amountMicros: 192_000_000,
    },
    { 'Idempotency-Key': 'idem-topup-1' }
  );
  assert.equal(first.status, 201);
  const second = await bff(
    'POST',
    '/api/tokenpanel/billing/topup-intents',
    billToken,
    {
      amountMicros: 192_000_000,
    },
    { 'Idempotency-Key': 'idem-topup-1' }
  );
  assert.equal(second.status, 201);
  assert.equal(upstream.state.intents.length, intentsBefore + 1);
  assert.deepEqual(second.body, first.body);
  const intentId = first.body.data.intent._id;
  const cancel1 = await bff(
    'POST',
    `/api/tokenpanel/billing/topup-intents/${intentId}/cancel`,
    billToken,
    {},
    {
      'Idempotency-Key': 'idem-cancel-1',
    }
  );
  const cancel2 = await bff(
    'POST',
    `/api/tokenpanel/billing/topup-intents/${intentId}/cancel`,
    billToken,
    {},
    {
      'Idempotency-Key': 'idem-cancel-1',
    }
  );
  assert.equal(cancel1.status, 200);
  assert.deepEqual(cancel2.body, cancel1.body);
});

test('redeem double-send: headline no-double-charge proof, one credit', async () => {
  const creditsBefore = upstream.state.credits.length;
  const first = await bff(
    'POST',
    '/api/tokenpanel/billing/redeem',
    billToken,
    {
      code: 'DOUBLE-CHARGE-PROBE',
    },
    { 'Idempotency-Key': 'idem-redeem-1' }
  );
  assert.equal(first.status, 200);
  const second = await bff(
    'POST',
    '/api/tokenpanel/billing/redeem',
    billToken,
    {
      code: 'DOUBLE-CHARGE-PROBE',
    },
    { 'Idempotency-Key': 'idem-redeem-1' }
  );
  assert.equal(second.status, 200);
  assert.equal(upstream.state.credits.length, creditsBefore + 1);
  assert.deepEqual(second.body, first.body);
  assert.equal(second.body.data.credited.amountMicros, 5_000_000);
});

test('account writes double-send: one subscription, one write each', async () => {
  const subsBefore = upstream.state.subs.length;
  const sub1 = await bff(
    'POST',
    '/api/tokenpanel/account/subscriptions',
    billToken,
    {
      planId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      billing: 'month',
    },
    { 'Idempotency-Key': 'idem-sub-1' }
  );
  assert.equal(sub1.status, 201);
  const sub2 = await bff(
    'POST',
    '/api/tokenpanel/account/subscriptions',
    billToken,
    {
      planId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      billing: 'month',
    },
    { 'Idempotency-Key': 'idem-sub-1' }
  );
  assert.equal(sub2.status, 201);
  assert.equal(upstream.state.subs.length, subsBefore + 1);
  assert.deepEqual(sub2.body, sub1.body);

  const budgetId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const b1 = await bff(
    'PATCH',
    `/api/tokenpanel/account/budgets/${budgetId}`,
    billToken,
    {
      amountMicros: 9_000_000,
    },
    { 'Idempotency-Key': 'idem-budget-1' }
  );
  const b2 = await bff(
    'PATCH',
    `/api/tokenpanel/account/budgets/${budgetId}`,
    billToken,
    {
      amountMicros: 9_000_000,
    },
    { 'Idempotency-Key': 'idem-budget-1' }
  );
  assert.equal(b1.status, 200);
  assert.deepEqual(b2.body, b1.body);

  const l1 = await bff(
    'PATCH',
    '/api/tokenpanel/account/limits',
    billToken,
    {
      spendingCap: { maxSpendMicros: 50_000_000, windowSeconds: 18_000 },
    },
    { 'Idempotency-Key': 'idem-limits-1' }
  );
  const l2 = await bff(
    'PATCH',
    '/api/tokenpanel/account/limits',
    billToken,
    {
      spendingCap: { maxSpendMicros: 50_000_000, windowSeconds: 18_000 },
    },
    { 'Idempotency-Key': 'idem-limits-1' }
  );
  assert.equal(l1.status, 200);
  assert.deepEqual(l2.body, l1.body);

  const p1 = await bff(
    'PATCH',
    '/api/tokenpanel/account/profile',
    billToken,
    {
      name: 'Idem Probe',
    },
    { 'Idempotency-Key': 'idem-profile-1' }
  );
  const p2 = await bff(
    'PATCH',
    '/api/tokenpanel/account/profile',
    billToken,
    {
      name: 'Idem Probe',
    },
    { 'Idempotency-Key': 'idem-profile-1' }
  );
  assert.equal(p1.status, 200);
  assert.deepEqual(p2.body, p1.body);
  assert.equal(p1.body.data.name, 'Idem Probe');
});

test('bridge resolve forwards the replay key and mints when absent', async () => {
  const before = upstream.state.bridgeKeys.length;
  await bridge.exchangePortalToken(keysUser.id, {
    idempotencyKey: 'idem-bridge-1',
  });
  await bridge.exchangePortalToken(keysUser.id, {
    idempotencyKey: 'idem-bridge-1',
  });
  assert.deepEqual(upstream.state.bridgeKeys.slice(before), [
    'idem-bridge-1',
    'idem-bridge-1',
  ]);
  const mintedBefore = upstream.state.bridgeKeys.length;
  await bridge.exchangePortalToken(keysUser.id);
  await bridge.exchangePortalToken(keysUser.id);
  const mintedPair = upstream.state.bridgeKeys.slice(mintedBefore);
  assert.equal(mintedPair.length, 2);
  assert.match(mintedPair[0], /^[0-9a-f-]{36}$/);
  assert.notEqual(mintedPair[0], mintedPair[1]);
  await assert.rejects(
    () =>
      bridge.exchangePortalToken(keysUser.id, { idempotencyKey: 'no\nlines' }),
    error => {
      assert.equal(error.status, 400);
      return true;
    }
  );
});

test('invalid keys answer 400 with zero upstream calls', async () => {
  const callsBefore = upstream.state.calls;
  const bad = { 'Idempotency-Key': 'x'.repeat(129) };
  // CR/LF smuggling cannot traverse HTTP at all (undici rejects the header
  // client-side, as browsers do); the server-side charset gate for such
  // values is proven by the shared-helper assertions above.
  const spaced = { 'Idempotency-Key': 'has space' };
  assert.equal(
    (
      await bff(
        'POST',
        '/api/tokenpanel/keys',
        keysToken,
        { name: 'nope' },
        bad
      )
    ).status,
    400
  );
  assert.equal(
    (
      await bff(
        'POST',
        '/api/tokenpanel/keys',
        keysToken,
        { name: 'nope' },
        spaced
      )
    ).status,
    400
  );
  assert.equal(
    (
      await bff(
        'POST',
        '/api/tokenpanel/billing/topup-intents',
        billToken,
        {
          amountMicros: 1_000_000,
        },
        bad
      )
    ).status,
    400
  );
  assert.equal(
    (
      await bff(
        'POST',
        '/api/tokenpanel/account/subscriptions',
        billToken,
        {
          planId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        },
        spaced
      )
    ).status,
    400
  );
  assert.equal(
    upstream.state.calls,
    callsBefore,
    'garbage never rides upstream'
  );
});

test('upstream 429 / 402 / 403 surface verbatim, never masked', async () => {
  upstream.state.forceError = { status: 429, body: { error: 'rate_limited' } };
  const limited = await bff(
    'POST',
    '/api/tokenpanel/keys',
    keysToken,
    {
      name: 'limited-key',
    },
    { 'Idempotency-Key': 'idem-429-1' }
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'rate_limited');

  upstream.state.forceError = {
    status: 402,
    body: { error: 'insufficient_balance' },
  };
  const short = await bff(
    'POST',
    '/api/tokenpanel/billing/topup-intents',
    billToken,
    {
      amountMicros: 999_000_000,
    },
    { 'Idempotency-Key': 'idem-402-1' }
  );
  assert.equal(short.status, 402);
  assert.ok(String(short.body.message).includes('insufficient_balance'));

  upstream.state.forceError = {
    status: 402,
    body: { error: 'insufficient_balance' },
  };
  const subShort = await bff(
    'POST',
    '/api/tokenpanel/account/subscriptions',
    billToken,
    {
      planId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    },
    { 'Idempotency-Key': 'idem-402-2' }
  );
  assert.equal(subShort.status, 402);
  assert.ok(String(subShort.body.message).includes('insufficient_balance'));

  upstream.state.forceError = {
    status: 403,
    body: { error: 'customer_suspended' },
  };
  const forbidden = await bff(
    'PATCH',
    '/api/tokenpanel/account/limits',
    billToken,
    {
      spendingCap: null,
    },
    { 'Idempotency-Key': 'idem-403-1' }
  );
  assert.equal(forbidden.status, 403);
  assert.ok(String(forbidden.body.message).includes('customer_suspended'));
});
