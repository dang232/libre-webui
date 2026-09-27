/*
 * Libre BFF usage + requests parity via TokenPanel (Wave4 todo 20).
 *
 * Proves, against a stubbed TokenPanel that enforces the real upstream
 * auth rules (public surface: customer JWT only; management: tp_mgmt_*
 * only), that:
 * - a Libre browser session presented DIRECTLY upstream fails 401
 *   (failing-first: the browser can never talk to TokenPanel itself),
 * - the same window through the BFF (session only in, management creds
 *   attached server-side) returns byte-identical totals: page JSON equals
 *   direct API JSON field-by-field (requests, input/output/total tokens,
 *   spend micros), deltas all zero,
 * - window/param mapping is 1:1 (from/to/limit/model/key forwarded
 *   verbatim when present, omitted when absent — no silent BFF defaults;
 *   bad date/limit/key surfaces the API 422),
 * - usage BFF responses carry `Cache-Control: no-store`,
 * - no BFF response, and no upstream public call, carries `tp_mgmt_*`,
 * - the display path is float-free (grep-gate over the new files), and a
 *   float-formatted variant is shown to drift (failing-first) while the
 *   integer path stays exact.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-task20-usage-'));
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = '4'.repeat(64);
process.env.JWT_SECRET = 'task20-usage-requests-secret-long-enough';
process.env.ENABLE_SIGNUP = 'true';
process.env.TOKENPANEL_API_URL = 'http://tokenpanel.test';
process.env.TOKENPANEL_MGMT_KEY = 'tp_mgmt_testkey_task20';

const importBuilt = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);

const [{ authService }, database, expressMod, coordinatorMod, routeMod] =
  await Promise.all([
    importBuilt('services/authService.js'),
    importBuilt('db.js'),
    import('express'),
    importBuilt('platform/coordination/service.js'),
    importBuilt('routes/tokenpanelUsage.js'),
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

// --- Direct-API fixtures: integer micros, pinned currency ---------------

const API_SUMMARY = {
  totalRequests: 42,
  totalTokens: 1234567,
  totalCostMicros: 98765432,
  totalPriceMicros: 192000000,
  currency: 'VND',
  byModel: [
    {
      modelAliasId: 'default-chat',
      requests: 30,
      tokens: 1000000,
      costMicros: 80000000,
      priceMicros: 150000000,
    },
    {
      modelAliasId: 'helper',
      requests: 12,
      tokens: 234567,
      costMicros: 18765432,
      priceMicros: 42000000,
    },
  ],
};

const API_DAILY = [
  {
    day: '2026-09-26',
    requests: 20,
    tokens: 700000,
    promptTokens: 500000,
    completionTokens: 200000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    avgDurationMs: 1234,
    costMicros: 50000000,
    priceMicros: 100000000,
    currency: 'VND',
  },
  {
    day: '2026-09-27',
    requests: 22,
    tokens: 534567,
    promptTokens: 400000,
    completionTokens: 134567,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    avgDurationMs: 987,
    costMicros: 48765432,
    priceMicros: 92000000,
    currency: 'VND',
  },
];

const API_RECORDS = [
  {
    id: '68d7a1b2c3d4e5f60718293a',
    modelAliasId: 'default-chat',
    apiKeyId: '68d7a1b2c3d4e5f60718293b',
    promptTokens: 500000,
    completionTokens: 200000,
    tokens: 700000,
    costMicros: 50000000,
    priceMicros: 100000000,
    currency: 'VND',
    status: 200,
    durationMs: 1234,
    occurredAt: '2026-09-27T10:00:00.000Z',
  },
  {
    id: '68d7a1b2c3d4e5f60718293c',
    modelAliasId: 'helper',
    apiKeyId: null,
    promptTokens: 400000,
    completionTokens: 134567,
    tokens: 534567,
    costMicros: 48765432,
    priceMicros: 92000000,
    currency: 'VND',
    status: 200,
    durationMs: 987,
    occurredAt: '2026-09-27T11:00:00.000Z',
  },
];

/** In-memory TokenPanel enforcing the real auth boundary. */
const upstreamQueries = [];
const upstreamAuthHeaders = [];
const makeUpstream = () => {
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
      if (auth !== 'Bearer tp_mgmt_testkey_task20') {
        return json(401, { error: 'unauthorized' });
      }
      if (u.endsWith('/customers/bridge-resolve')) {
        const body = JSON.parse(init.body);
        return json(200, {
          customer: { _id: 'cust-1', authUserId: body.authUserId },
          customerId: 'cust-1',
          linked: 'existing',
        });
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
      const customerId = customerIdOf(auth);
      if (!customerId) return json(401, { error: 'unauthorized' });
      const method = init.method || 'GET';
      const [rawPath, rawQuery] = u.split('/public/customers')[1].split('?');
      upstreamQueries.push({ method, path: rawPath, query: rawQuery || '' });

      // Validation mirrors customers-public.ts:984-1002/:1446-1464/:1490-1522.
      const params = new URLSearchParams(rawQuery || '');
      for (const name of ['from', 'to']) {
        const value = params.get(name);
        if (value !== null && Number.isNaN(Date.parse(value))) {
          return json(422, { error: 'validation_error' });
        }
      }
      if (method === 'GET' && rawPath === '/me/usage') {
        return json(200, API_SUMMARY);
      }
      if (method === 'GET' && rawPath === '/me/usage/daily') {
        return json(200, { days: API_DAILY });
      }
      if (method === 'GET' && rawPath === '/me/usage/records') {
        const limitRaw = params.get('limit');
        const limit = limitRaw === null ? 50 : Number(limitRaw);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          return json(422, { error: 'validation_error' });
        }
        const key = params.get('key');
        if (key !== null && !/^[0-9a-fA-F]{24}$/.test(key)) {
          return json(422, { error: 'validation_error' });
        }
        return json(200, { items: API_RECORDS.slice(0, limit) });
      }
      throw new Error(`unexpected public call ${method} ${rawPath}`);
    }
    throw new Error(`unexpected upstream call ${u}`);
  };

  return { responder };
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
const bff = async (method, path, token) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
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
  authService.signup(username, 'Usage-Test-123!x', email, {
    kind: 'signup',
    ip: '203.0.113.9',
    userAgent: 'node-test',
  });

const { user: createdUser } = await signup('usage_user', 'usage@example.test');
const stored = await importBuilt('models/userModel.js').then(m =>
  m.userModel.getUserById(createdUser.id)
);
const libreToken = await authService.issueSession(stored, {
  kind: 'signup',
  ip: '203.0.113.9',
  userAgent: 'node-test',
});

test('direct upstream call with the Libre session fails 401 (browser can never go direct)', async () => {
  const direct = await fetch(
    'http://tokenpanel.test/public/customers/me/usage',
    {
      headers: { Authorization: `Bearer ${libreToken}` },
    }
  );
  assert.equal(direct.status, 401);
});

test('BFF summary equals the direct API totals (requests/tokens/spend micros)', async () => {
  const res = await bff('GET', '/api/tokenpanel/usage/summary', libreToken);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(res.body.data, API_SUMMARY);
  assert.equal(res.body.data.totalRequests, 42);
  assert.equal(res.body.data.totalTokens, 1234567);
  assert.equal(res.body.data.totalPriceMicros, 192000000);
  assert.equal(res.body.data.currency, 'VND');
});

test('BFF daily buckets equal the direct API buckets', async () => {
  const res = await bff('GET', '/api/tokenpanel/usage/daily', libreToken);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(res.body.data, { days: API_DAILY });
  const input = res.body.data.days.reduce((s, d) => s + d.promptTokens, 0);
  const output = res.body.data.days.reduce((s, d) => s + d.completionTokens, 0);
  assert.equal(input, 900000);
  assert.equal(output, 334567);
});

test('BFF records equal the direct API records', async () => {
  const res = await bff('GET', '/api/tokenpanel/usage/records', libreToken);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(res.body.data, { items: API_RECORDS });
});

test('window/param mapping is 1:1 (verbatim forward, no BFF defaults)', async () => {
  upstreamQueries.length = 0;
  const res = await bff(
    'GET',
    '/api/tokenpanel/usage/records?limit=1&model=helper&key=68d7a1b2c3d4e5f60718293b&from=2026-09-27T00:00:00.000Z&to=2026-09-27T23:59:59.000Z',
    libreToken
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.data.items.length, 1);
  const seen = upstreamQueries[upstreamQueries.length - 1];
  assert.equal(seen.path, '/me/usage/records');
  const params = new URLSearchParams(seen.query);
  assert.equal(params.get('limit'), '1');
  assert.equal(params.get('model'), 'helper');
  assert.equal(params.get('key'), '68d7a1b2c3d4e5f60718293b');
  assert.equal(params.get('from'), '2026-09-27T00:00:00.000Z');
  assert.equal(params.get('to'), '2026-09-27T23:59:59.000Z');

  upstreamQueries.length = 0;
  const bare = await bff('GET', '/api/tokenpanel/usage/summary', libreToken);
  assert.equal(bare.status, 200);
  assert.equal(upstreamQueries[upstreamQueries.length - 1].query, '');
});

test('boundary is fail-closed: 401/422, API validation mirrored', async () => {
  const noSession = await bff('GET', '/api/tokenpanel/usage/summary', null);
  assert.equal(noSession.status, 401);

  const badDate = await bff(
    'GET',
    '/api/tokenpanel/usage/summary?from=not-a-date',
    libreToken
  );
  assert.equal(badDate.status, 422);

  const badLimit = await bff(
    'GET',
    '/api/tokenpanel/usage/records?limit=201',
    libreToken
  );
  assert.equal(badLimit.status, 422);

  const badKey = await bff(
    'GET',
    '/api/tokenpanel/usage/records?key=nope',
    libreToken
  );
  assert.equal(badKey.status, 422);
});

test('mgmt key never appears in BFF responses or upstream public calls', async () => {
  const blob = bffResponses.join('\n');
  assert.ok(!blob.includes('tp_mgmt_'), 'BFF response leaked tp_mgmt_*');
  for (const auth of upstreamAuthHeaders) {
    assert.ok(
      !String(auth || '').includes('tp_mgmt_'),
      'upstream public call carried tp_mgmt_*'
    );
  }
  // The failing-first direct test above contributes the Libre session token;
  // every BFF-driven upstream call must carry the customer JWT only.
  const customerCalls = upstreamAuthHeaders.filter(auth =>
    String(auth || '').startsWith('Bearer customer-jwt-')
  );
  assert.ok(
    customerCalls.length >= 3,
    'expected BFF-driven customer-JWT upstream calls'
  );
});

test('display path is float-free (grep-gate over the new files)', async () => {
  const files = [
    'backend/src/services/tokenpanelUsageService.ts',
    'backend/src/routes/tokenpanelUsage.ts',
    'frontend/src/utils/usageMicros.ts',
    'frontend/src/utils/api/tokenpanelUsageApi.ts',
    'frontend/src/components/settings/TokenpanelUsagePanel.tsx',
  ];
  const banned = [
    'parseFloat',
    'toFixed',
    'Math.round(',
    '* 0.',
    '/ 1000000',
    '/1000000',
    '/ 1_000_000',
    '/1_000_000',
  ];
  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(path.resolve(file), 'utf8');
    for (const pattern of banned) {
      if (text.includes(pattern)) hits.push(`${file}: ${pattern}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('failing-first: a float formatter drifts where the integer path is exact', async () => {
  // 2_675_000 micros is exactly 2.675 major — binary float cannot say so:
  // (2675000 / 1000000).toFixed(2) === '2.67', a full 0.005-major lie.
  const floatTwoDp = (2675000 / 1000000).toFixed(2);
  assert.equal(floatTwoDp, '2.67');
  assert.notEqual(floatTwoDp, '2.68');
  // The integer path keeps every micro: '2.675' — asserted again in
  // usageMicros.test.ts against the real formatter.
  const micros = 2675000;
  const digits = String(micros);
  const exact = `${digits.slice(0, digits.length - 6)}.${digits.slice(digits.length - 6).replace(/0+$/, '')}`;
  assert.equal(exact, '2.675');
});

// --- Totals proof artifacts (page-vs-API JSON pair + diff log) ---

test('totals proof artifacts land under .omo/research/task20', async () => {
  const dir = path.resolve('../.omo/research/task20');
  fs.mkdirSync(dir, { recursive: true });
  const summary = await bff('GET', '/api/tokenpanel/usage/summary', libreToken);
  const daily = await bff('GET', '/api/tokenpanel/usage/daily', libreToken);
  const records = await bff('GET', '/api/tokenpanel/usage/records', libreToken);
  const pair = {
    window: 'server-default (no from/to on either side)',
    directApi: { summary: API_SUMMARY, daily: API_DAILY, records: API_RECORDS },
    bffConsumed: {
      summary: summary.body.data,
      daily: daily.body.data.days,
      records: records.body.data.items,
    },
  };
  fs.writeFileSync(
    path.join(dir, 'bff-vs-api-pair.json'),
    `${JSON.stringify(pair, null, 2)}\n`
  );
  const deltas = [];
  const check = (name, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) deltas.push(name);
  };
  check('summary', API_SUMMARY, summary.body.data);
  check('daily', API_DAILY, daily.body.data.days);
  check('records', API_RECORDS, records.body.data.items);
  fs.writeFileSync(
    path.join(dir, 'bff-vs-api-diff.log'),
    deltas.length === 0
      ? 'ALL-ZERO: summary, daily, records identical BFF vs direct API\n'
      : `DRIFT: ${deltas.join(', ')}\n`
  );
  assert.deepEqual(deltas, []);
});
