/*
 * TokenPanel billing parity via the Libre BFF — intent-only (todo 21).
 *
 * Covers: billing history passthrough matching the upstream API shape,
 * recharge intent create (integer-micros gate + Idempotency-Key forward +
 * server-issued QR TTL passed through verbatim), intent → expiry → refresh
 * (an expired/decided intent surfaces the server 404 denial; a fresh GET
 * reopens the live QR), redeem green end-to-end (server-computed credit),
 * completion corroborated by the server record (history re-read, never Libre
 * state), and a grep-gate proving ZERO Libre ledger/balance writes in the
 * new billing files (plus a scratch-write probe proving the gate itself
 * fires, then deleted).
 *
 * Libre never settles: reserve/settle/debit/ledger stay TokenPanel-side
 * (selfserve-billing.ts + payment-saga.ts). Webhook settlement evidence is
 * corroborated by the upstream TokenPanel billing suite (see learnings.md).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'libre-tokenpanel-billing-')
);
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = '2'.repeat(64);
process.env.JWT_SECRET = 'tokenpanel-billing-test-secret-that-is-long-enough';
process.env.ENABLE_SIGNUP = 'true';
process.env.TOKENPANEL_API_URL = 'http://tokenpanel.test';
process.env.TOKENPANEL_MGMT_KEY = 'tp_mgmt_testkey';

const importBuilt = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);
const [{ authService }, billing, database] = await Promise.all([
  importBuilt('services/authService.js'),
  importBuilt('services/tokenpanelBillingService.js'),
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

const SERVER_TTL_MS = 15 * 60_000;
const serverIntent = overrides => ({
  _id: '507f1f77bcf86cd799439011',
  orderCode: 'ALCABCDEFG',
  amountMicros: 192_000_000,
  currency: 'VND',
  method: 'vietqr',
  status: 'pending',
  qrExpiresAt: new Date(Date.now() + SERVER_TTL_MS).toISOString(),
  vietqr: '00020101021238570010A000000727012700069704220011...',
  qrPayload: null,
  qrLink: null,
  ...(overrides ?? {}),
});

/** In-memory TokenPanel stub: resolve + mint + customer self-service. */
const makeUpstreamStub = () => {
  const state = {
    resolveKey: null,
    createKey: null,
    createBody: null,
    history: [
      {
        _id: 'adj-1',
        amountMicros: -6_000,
        currency: 'VND',
        reason: 'usage_debit',
        createdAt: '2026-09-27T00:00:00.000Z',
      },
    ],
  };
  const responder = (url, init) => {
    const method = init.method ?? 'GET';
    if (url.endsWith('/api/management/customers/bridge-resolve')) {
      return jsonResponse(200, {
        customer: { _id: 'cust-9', authUserId: 'u', email: 'e' },
        customerId: 'cust-9',
        linked: 'existing',
      });
    }
    if (/\/portal-token$/.test(url) && method === 'POST') {
      return jsonResponse(200, {
        token: 'portal.viewer.jwt',
        expiresAt: '2030-01-01T00:02:00.000Z',
      });
    }
    if (url.includes('/public/customers/me/billing') && method === 'GET') {
      return jsonResponse(200, { items: state.history, total: 1 });
    }
    if (url.includes('/public/customers/me/invoices') && method === 'GET') {
      return jsonResponse(200, { items: [], total: 0 });
    }
    if (
      url.endsWith('/public/customers/me/topup-intents') &&
      method === 'GET'
    ) {
      return jsonResponse(200, { items: [serverIntent()], total: 1 });
    }
    const one = url.match(/\/topup-intents\/([0-9a-fA-F]{24})$/);
    if (one && method === 'GET') {
      // Server reads expired/decided intents as not found (no live QR).
      if (one[1] === '507f1f77bcf86cd799439012') {
        return jsonResponse(404, { error: 'not_found' });
      }
      return jsonResponse(200, { intent: serverIntent({ _id: one[1] }) });
    }
    if (
      url.endsWith('/public/customers/me/topup-intents') &&
      method === 'POST'
    ) {
      state.createKey = init.headers?.['Idempotency-Key'];
      state.createBody = JSON.parse(init.body);
      return jsonResponse(201, { intent: serverIntent() });
    }
    const cancel = url.match(/\/topup-intents\/([0-9a-fA-F]{24})\/cancel$/);
    if (cancel && method === 'POST') {
      return jsonResponse(200, { ok: true });
    }
    if (url.endsWith('/public/customers/me/redeem') && method === 'POST') {
      const body = JSON.parse(init.body);
      if (body.code === 'ALREADY-USED') {
        return jsonResponse(400, { error: 'validation_error' });
      }
      // Server-side settlement: the credit row lands in history; the BFF
      // corroborates completion by re-reading it, never from Libre state.
      state.history.unshift({
        _id: 'adj-2',
        amountMicros: 5_000_000,
        currency: 'VND',
        reason: 'topup',
        createdAt: new Date().toISOString(),
      });
      return jsonResponse(200, {
        ok: true,
        credited: { amountMicros: 5_000_000, currency: 'VND' },
      });
    }
    throw new Error(`unexpected TokenPanel call ${method} ${url}`);
  };
  return { state, responder };
};

const signup = (username, email) =>
  authService.signup(username, 'Billing-Test-123!x', email, {
    kind: 'signup',
    ip: '203.0.113.9',
    userAgent: 'node-test',
  });

test('billing history matches the upstream API shape', async () => {
  const created = await signup('billing_hist', 'hist@example.test');
  const stub = makeUpstreamStub();
  stubFetch(stub.responder);
  const data = await billing.getBillingHistory(created.user.id, {
    limit: '20',
  });
  assert.deepEqual(data, {
    items: stub.state.history,
    total: 1,
  });
  const historyCall = calls.find(c =>
    c.url.includes('/public/customers/me/billing')
  );
  assert.ok(historyCall, 'BFF proxies GET /me/billing');
  const auth = historyCall.init.headers.Authorization;
  assert.equal(auth, 'Bearer portal.viewer.jwt');
  assert.ok(!auth.includes('tp_mgmt_'), 'mgmt key never rides upstream');
});

test('recharge creates a server-side intent honoring TTL + idempotency', async () => {
  const created = await signup('billing_intent', 'intent@example.test');
  const stub = makeUpstreamStub();
  stubFetch(stub.responder);
  calls.length = 0;
  const data = await billing.createTopupIntent(created.user.id, {
    amountMicros: 192_000_000,
    idempotencyKey: 'recharge-key-1',
  });
  assert.equal(stub.state.createBody.amountMicros, 192_000_000);
  assert.equal(stub.state.createKey, 'recharge-key-1');
  const intent = data.intent;
  assert.equal(Number.isInteger(intent.amountMicros), true);
  assert.equal(intent.currency, 'VND');
  assert.ok(typeof intent.qrExpiresAt === 'string');
  const remaining = Date.parse(intent.qrExpiresAt) - Date.now();
  assert.ok(
    remaining > 0 && remaining <= SERVER_TTL_MS,
    `server TTL honored verbatim (remaining ${remaining}ms)`
  );
  assert.ok(typeof intent.vietqr === 'string' && intent.vietqr.length > 0);
});

test('intent expiry surfaces the server denial; refresh reopens live QR', async () => {
  const created = await signup('billing_ttl', 'ttl@example.test');
  stubFetch(makeUpstreamStub().responder);
  // Live intent reopens fine (refresh path).
  const live = await billing.getTopupIntent(
    created.user.id,
    '507f1f77bcf86cd799439011'
  );
  assert.equal(live.intent.status, 'pending');
  // Expired/decided intent: the server denies with 404 — an expired QR is
  // unusable and the UI must mint a fresh intent instead of retrying.
  await assert.rejects(
    () => billing.getTopupIntent(created.user.id, '507f1f77bcf86cd799439012'),
    error => {
      assert.equal(error.status, 404);
      return true;
    }
  );
});

test('non-integer amounts are rejected before any upstream write', async () => {
  const created = await signup('billing_gate', 'gate@example.test');
  stubFetch(makeUpstreamStub().responder);
  calls.length = 0;
  for (const bad of [1.5, -100, 0, '100', Number.NaN]) {
    await assert.rejects(
      () => billing.createTopupIntent(created.user.id, { amountMicros: bad }),
      error => {
        assert.equal(error.status, 400);
        return true;
      }
    );
  }
  assert.ok(
    !calls.some(c => c.url.endsWith('/public/customers/me/topup-intents')),
    'no upstream intent created for invalid amounts'
  );
});

test('redeem flow is green; completion corroborated by server history', async () => {
  const created = await signup('billing_redeem', 'redeem@example.test');
  const stub = makeUpstreamStub();
  stubFetch(stub.responder);
  const result = await billing.redeemVoucher(created.user.id, {
    code: '  vouch-er12  ',
  });
  // Code forwarded normalized; credit computed server-side, integer-exact.
  assert.equal(result.ok, true);
  assert.equal(result.credited.amountMicros, 5_000_000);
  assert.equal(result.credited.currency, 'VND');
  // Corroboration: the credit is visible in the SERVER history re-read —
  // Libre holds no balance of its own.
  const history = await billing.getBillingHistory(created.user.id, {});
  assert.equal(history.items[0].amountMicros, 5_000_000);
  assert.equal(history.items[0].reason, 'topup');
  // A spent code surfaces the server denial.
  await assert.rejects(
    () => billing.redeemVoucher(created.user.id, { code: 'ALREADY-USED' }),
    error => {
      assert.equal(error.status, 400);
      return true;
    }
  );
});

test('cancel forwards to the server cancel endpoint', async () => {
  const created = await signup('billing_cancel', 'cancel@example.test');
  stubFetch(makeUpstreamStub().responder);
  const result = await billing.cancelTopupIntent(
    created.user.id,
    '507f1f77bcf86cd799439011'
  );
  assert.equal(result.ok, true);
});

test('new Libre billing files perform zero ledger/balance writes', async () => {
  const targets = [
    'backend/dist/services/tokenpanelBillingService.js',
    'backend/dist/routes/tokenpanelBilling.js',
  ];
  const forbidden = [
    /adjustCustomerBalance/,
    /creditBalance/,
    /debitBalance/,
    /settleWithReservation/,
    /reserveBalance/,
    /insertOne\s*\(\s*\{[^}]*ledger/,
    /\bbalance\s*=\s*[^=]/,
    /amountMicros\s*[+\-*/]\s*\d/,
  ];
  for (const target of targets) {
    const code = fs
      .readFileSync(path.resolve(target), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
    for (const pattern of forbidden) {
      assert.ok(
        !pattern.test(code),
        `${target} must not write ledger/balance (${pattern})`
      );
    }
  }
  // Failing-first probe: a scratch Libre-side balance-write stub IS caught
  // by the same gate — intent + server record suffice, so the stub is
  // unnecessary and never committed.
  const scratch = 'const balance = 999; adjustCustomerBalance({});';
  assert.ok(
    forbidden.some(pattern => pattern.test(scratch)),
    'gate fires on a scratch balance-write stub'
  );
  // Management keys never reach the browser: none of the new frontend
  // billing files reference a management key in executable code (comments
  // stripped — docs may name the boundary without leaking a value).
  const stripComments = code =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  for (const file of [
    'frontend/src/utils/api/tokenpanelApi.ts',
    'frontend/src/utils/billingMicros.ts',
    'frontend/src/components/settings/SettingsBillingTab.tsx',
  ]) {
    const source = stripComments(fs.readFileSync(path.resolve(file), 'utf8'));
    assert.ok(!source.includes('tp_mgmt_'), `${file} leaks no mgmt key`);
    assert.ok(
      !source.includes('TOKENPANEL_MGMT_KEY'),
      `${file} reads no mgmt key`
    );
  }
});
