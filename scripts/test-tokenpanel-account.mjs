/*
 * TokenPanel account BFF parity — subs/budgets/limits/profile (todo 22).
 *
 * Covers, against an in-memory TokenPanel stub with upstream-shaped
 * validation: subscription subscribe→re-read round-trip, budget
 * update→re-read round-trip, spending-cap set→re-read and clear→re-read
 * round-trips, profile update→re-read round-trip (all integer-micros exact,
 * currency server-pinned), boundary validation parity (bad planId/billing,
 * float micros, out-of-range thresholds/window, empty name, bad email,
 * unknown budget id), upstream-401 mapping to BFF 401 with zero retries
 * (stale tokens never continue), and grep-gates proving the management key
 * only ever authorizes the server-side resolve/mint calls.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-tokenpanel-account-'));
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = '2'.repeat(64);
process.env.JWT_SECRET = 'tokenpanel-account-test-secret-that-is-long-enough';
process.env.ENABLE_SIGNUP = 'true';
process.env.TOKENPANEL_API_URL = 'http://tokenpanel.test';
process.env.TOKENPANEL_MGMT_KEY = 'tp_mgmt_testkey';

const importBuilt = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);
const [{ authService }, bridge, account, database] = await Promise.all([
  importBuilt('services/authService.js'),
  importBuilt('services/tokenpanelBridgeService.js'),
  importBuilt('services/tokenpanelAccountService.js'),
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

const PLAN_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const PLAN_PRICE = 192000000;
const CURRENCY = 'VND';

/** In-memory TokenPanel stub with upstream-shaped validation. */
const makeUpstreamStub = ({ customerAuth = 'cust-token-cust-1', mintToken = customerAuth } = {}) => {
  const customers = [];
  const state = {
    subscription: null,
    budgets: [
      {
        _id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
        periodStart: '2026-09-01T00:00:00.000Z',
        periodEnd: '2026-10-01T00:00:00.000Z',
        amountMicros: 5000000,
        currency: CURRENCY,
        alertThresholds: [50, 80],
      },
    ],
    limits: [
      { _id: 'cccccccccccccccccccccccc', projectId: null, rules: [], spendingCap: null },
    ],
    profile: { _id: 'cust-1', name: 'Bridge User', email: 'account@example.test', status: 'active' },
  };
  const authed = init => {
    const header = init?.headers?.Authorization ?? init?.headers?.authorization;
    return header === `Bearer ${customerAuth}`;
  };
  const responder = (url, init) => {
    if (url.endsWith('/api/management/customers/bridge-resolve')) {
      const body = JSON.parse(init.body);
      let row = customers.find(r => r.authUserId === body.authUserId);
      let linked = 'existing';
      if (!row) {
        row = { _id: 'cust-1', authUserId: body.authUserId, email: body.email };
        customers.push(row);
        linked = 'created';
      }
      return jsonResponse(200, { customer: row, customerId: row._id, linked });
    }
    if (/\/api\/management\/customers\/[^/]+\/portal-token$/.test(url)) {
      return jsonResponse(200, { token: mintToken, expiresAt: '2030-01-01T00:02:00.000Z' });
    }
    if (url.endsWith('/public/customers/plans')) {
      return jsonResponse(200, {
        items: [{ _id: PLAN_ID, name: 'Pro', price: { amountMicros: PLAN_PRICE, currency: CURRENCY } }],
      });
    }
    if (!authed(init)) return jsonResponse(401, { error: 'unauthorized' });
    if (url.endsWith('/public/customers/me/subscription')) {
      return jsonResponse(200, {
        subscription: state.subscription,
        plan: state.subscription ? { _id: PLAN_ID, name: 'Pro' } : null,
      });
    }
    if (url.endsWith('/public/customers/me/subscriptions')) {
      const body = JSON.parse(init.body);
      if (!/^[0-9a-fA-F]{24}$/.test(body.planId ?? '')) {
        return jsonResponse(400, { error: 'validation_error' });
      }
      if (body.billing !== undefined && !['month', 'quarter', 'year'].includes(body.billing)) {
        return jsonResponse(400, { error: 'validation_error' });
      }
      if (body.planId !== PLAN_ID) return jsonResponse(404, { error: 'not_found' });
      if (state.subscription) {
        return jsonResponse(409, { error: 'subscription_already_active' });
      }
      state.subscription = { _id: 'dddddddddddddddddddddddd', planId: body.planId, status: 'active' };
      return jsonResponse(201, {
        subscription: state.subscription,
        debited: { amountMicros: PLAN_PRICE, currency: CURRENCY, adjustmentId: 'eeeeeeeeeeeeeeeeeeeeeeee' },
      });
    }
    const budgetMatch = url.match(/\/public\/customers\/me\/budgets\/([^/?]+)$/);
    if (budgetMatch && init.method === 'PATCH') {
      const row = state.budgets.find(b => b._id === budgetMatch[1]);
      if (!row) return jsonResponse(404, { error: 'not_found' });
      const body = JSON.parse(init.body);
      if (body.amountMicros !== undefined) Object.assign(row, { amountMicros: body.amountMicros });
      if (body.alertThresholds !== undefined) Object.assign(row, { alertThresholds: body.alertThresholds });
      return jsonResponse(200, row);
    }
    if (url.endsWith('/public/customers/me/budgets')) {
      return jsonResponse(200, { items: state.budgets });
    }
    if (url.endsWith('/public/customers/me/limits') && init.method === 'PATCH') {
      const body = JSON.parse(init.body);
      state.limits[0].spendingCap = body.spendingCap ?? null;
      return jsonResponse(200, state.limits[0]);
    }
    if (url.endsWith('/public/customers/me/limits')) {
      return jsonResponse(200, { items: state.limits });
    }
    if (url.endsWith('/public/customers/me') && init.method === 'PATCH') {
      const body = JSON.parse(init.body);
      Object.assign(state.profile, body);
      return jsonResponse(200, state.profile);
    }
    if (url.endsWith('/public/customers/me')) {
      return jsonResponse(200, state.profile);
    }
    throw new Error(`unexpected TokenPanel call ${init.method} ${url}`);
  };
  return { state, responder };
};

const signup = (username, email) =>
  authService.signup(username, 'Account-Test-123!x', email, {
    kind: 'signup',
    ip: '203.0.113.10',
    userAgent: 'node-test',
  });

test('subscription subscribe round-trips: write then re-read equal', async () => {
  const created = await signup('account_sub', 'account@example.test');
  const stub = makeUpstreamStub();
  stubFetch(stub.responder);
  calls.length = 0;

  const before = await account.getSubscription(created.user.id);
  assert.equal(before.subscription, null);

  const bought = await account.subscribePlan(
    created.user.id,
    { planId: PLAN_ID, billing: 'year' },
    'sub-key-1'
  );
  assert.equal(bought.subscription.planId, PLAN_ID);
  assert.equal(bought.debited.amountMicros, PLAN_PRICE);
  assert.equal(bought.debited.currency, CURRENCY);
  assert.ok(Number.isSafeInteger(bought.debited.amountMicros));

  const after = await account.getSubscription(created.user.id);
  assert.deepEqual(after.subscription, bought.subscription);

  const plans = await account.listPlans();
  assert.equal(plans.items[0]._id, PLAN_ID);
  assert.equal(plans.items[0].price.amountMicros, PLAN_PRICE);
});

test('missing subscription reads as nulls instead of failing the section', async () => {
  const created = await signup('account_nosub', 'nosub@example.test');
  const stub = makeUpstreamStub();
  stubFetch((url, init) => {
    if (url.endsWith('/public/customers/me/subscription')) {
      return jsonResponse(404, { error: 'not_found' });
    }
    return stub.responder(url, init);
  });
  calls.length = 0;

  const result = await account.getSubscription(created.user.id);
  assert.equal(result.subscription, null);
  assert.equal(result.plan, null);
});

test('budget update round-trips: write then re-read equal, micros exact', async () => {
  const created = await signup('account_budget', 'budget@example.test');
  const stub = makeUpstreamStub();
  stubFetch(stub.responder);

  const before = await account.getBudgets(created.user.id);
  assert.equal(before.items[0].amountMicros, 5000000);

  const updated = await account.updateBudget(created.user.id, 'bbbbbbbbbbbbbbbbbbbbbbbb', {
    amountMicros: 9000000,
    alertThresholds: [25, 50, 90],
  });
  assert.equal(updated.amountMicros, 9000000);
  assert.deepEqual(updated.alertThresholds, [25, 50, 90]);
  assert.equal(updated.currency, CURRENCY);

  const after = await account.getBudgets(created.user.id);
  assert.deepEqual(after.items[0], updated);
});

test('spending-cap set then clear round-trips, currency pinned', async () => {
  const created = await signup('account_limits', 'limits@example.test');
  const stub = makeUpstreamStub();
  stubFetch(stub.responder);
  calls.length = 0;

  const set = await account.updateLimits(created.user.id, {
    spendingCap: { maxSpendMicros: 12000000, windowSeconds: 2592000 },
  });
  assert.deepEqual(set.spendingCap, { maxSpendMicros: 12000000, windowSeconds: 2592000 });

  const reread = await account.getLimits(created.user.id);
  assert.deepEqual(reread.items[0].spendingCap, { maxSpendMicros: 12000000, windowSeconds: 2592000 });

  const cleared = await account.updateLimits(created.user.id, { spendingCap: null });
  assert.equal(cleared.spendingCap, null);
  const rereadCleared = await account.getLimits(created.user.id);
  assert.equal(rereadCleared.items[0].spendingCap, null);

  const sentBodies = calls
    .filter(c => c.url.endsWith('/public/customers/me/limits') && c.init.method === 'PATCH')
    .map(c => JSON.parse(c.init.body));
  for (const body of sentBodies) {
    assert.ok(!('currency' in body), 'currency must never be sent by the BFF');
    assert.ok(!('amountMicros' in body), 'no stray micros field on the limits path');
  }
});

test('profile update round-trips: write then re-read equal', async () => {
  const created = await signup('account_profile', 'profile@example.test');
  stubFetch(makeUpstreamStub().responder);

  const updated = await account.updateProfile(created.user.id, { name: 'New Name' });
  assert.equal(updated.name, 'New Name');

  const reread = await account.getProfile(created.user.id);
  assert.deepEqual(reread, updated);
  assert.ok(!('passwordHash' in reread), 'profile must never leak passwordHash');
});

test('boundary validation parity mirrors upstream constraints', async () => {
  const created = await signup('account_validation', 'validation@example.test');
  stubFetch(makeUpstreamStub().responder);
  const userId = created.user.id;

  await assert.rejects(() => account.subscribePlan(userId, { planId: 'nope' }), e => e.status === 400);
  await assert.rejects(
    () => account.subscribePlan(userId, { planId: PLAN_ID, billing: 'decade' }),
    e => e.status === 400
  );
  await assert.rejects(
    () => account.updateBudget(userId, 'bbbbbbbbbbbbbbbbbbbbbbbb', { amountMicros: 1.5 }),
    e => e.status === 400
  );
  await assert.rejects(
    () => account.updateBudget(userId, 'bbbbbbbbbbbbbbbbbbbbbbbb', { alertThresholds: [101] }),
    e => e.status === 400
  );
  await assert.rejects(
    () => account.updateBudget(userId, 'not-an-id', { amountMicros: 5 }),
    e => e.status === 404
  );
  await assert.rejects(
    () => account.updateLimits(userId, { spendingCap: { maxSpendMicros: 10, windowSeconds: 0 } }),
    e => e.status === 400
  );
  await assert.rejects(
    () => account.updateLimits(userId, { spendingCap: { maxSpendMicros: 10, windowSeconds: 31536001 } }),
    e => e.status === 400
  );
  await assert.rejects(() => account.updateProfile(userId, { name: '   ' }), e => e.status === 400);
  await assert.rejects(() => account.updateProfile(userId, { email: 'not-an-email' }), e => e.status === 400);
  await assert.rejects(() => account.updateProfile(userId, {}), e => e.status === 400);
});

test('upstream denials surface verbatim with status preserved', async () => {
  const created = await signup('account_denials', 'denials@example.test');
  stubFetch(makeUpstreamStub().responder);
  const userId = created.user.id;

  await account.subscribePlan(userId, { planId: PLAN_ID });
  await assert.rejects(() => account.subscribePlan(userId, { planId: PLAN_ID }), e => {
    assert.equal(e.status, 409);
    assert.match(e.message, /subscription_already_active/);
    return true;
  });
  await assert.rejects(
    () => account.subscribePlan(userId, { planId: 'ffffffffffffffffffffffff' }),
    e => {
      assert.equal(e.status, 404);
      return true;
    }
  );
});

test('upstream 401 maps to BFF 401 with zero retries (stale token dies here)', async () => {
  const created = await signup('account_expired', 'expired@example.test');
  stubFetch(makeUpstreamStub({ mintToken: 'stale-token' }).responder);
  calls.length = 0;

  await assert.rejects(() => account.getSubscription(created.user.id), e => {
    assert.equal(e.status, 401);
    assert.match(e.message, /no longer valid/);
    return true;
  });
  const customerCalls = calls.filter(c => c.url.includes('/public/customers/'));
  assert.equal(customerCalls.length, 1);

  // Bridge-level rejection (bad mgmt key) still fails closed as 503, not 401.
  stubFetch(url => {
    if (url.endsWith('/bridge-resolve')) return jsonResponse(401, { error: 'unauthorized' });
    throw new Error(`unexpected call ${url}`);
  });
  await assert.rejects(() => account.getBudgets(created.user.id), e => e.status === 503);
});

test('management key only authorizes server-side resolve/mint calls', async () => {
  const created = await signup('account_keyscope', 'keyscope@example.test');
  stubFetch(makeUpstreamStub().responder);
  calls.length = 0;

  await account.getSubscription(created.user.id);
  await account.getBudgets(created.user.id);
  const customerCalls = calls.filter(c => c.url.includes('/public/customers/'));
  assert.ok(customerCalls.length > 0);
  for (const call of customerCalls) {
    const auth = call.init.headers.Authorization ?? '';
    assert.ok(!auth.includes('tp_mgmt_'), 'mgmt key must never reach customer endpoints');
    assert.ok(auth.startsWith('Bearer '), 'customer endpoints use the portal token');
  }
  const mgmtCalls = calls.filter(c => c.url.includes('/api/management/'));
  assert.ok(mgmtCalls.length > 0);
  for (const call of mgmtCalls) {
    assert.ok((call.init.headers.Authorization ?? '').includes('tp_mgmt_testkey'));
  }
});

test('built account service proxies the exact upstream self-service paths', async () => {
  const built = fs.readFileSync(
    path.resolve('backend/dist/services/tokenpanelAccountService.js'),
    'utf8'
  );
  const code = built
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
  for (const route of [
    '/public/customers/me/subscription',
    '/public/customers/me/subscriptions',
    '/public/customers/plans',
    '/public/customers/me/budgets',
    '/public/customers/me/limits',
    '/public/customers/me',
  ]) {
    assert.ok(built.includes(route), `service must proxy ${route}`);
  }
  assert.ok(!code.includes('password'), 'service must never touch passwords');
});
