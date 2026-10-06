import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const detection = await import(
  pathToFileURL(path.resolve('backend/dist/services/providerDetection.js'))
    .href
);

const {
  detectCredential,
  validateCredential,
  resolveProvider,
  listKnownProviders,
  scoreInstalledPlugins,
  ProviderDetectionError,
} = detection;

const statusImpl = status => async () => ({ status });

test('a bare base URL yields no vendor candidate without a credential', async () => {
  const candidates = await detectCredential({
    baseUrl: 'https://alcore.io.vn/v1',
  });
  assert.deepEqual(candidates, []);
});

test('generic compatible URL with mocked /models yields model_discovery', async () => {
  let seenUrl = '';
  let seenAuth = '';
  const fetchImpl = async (url, init) => {
    seenUrl = url;
    seenAuth = init.headers.Authorization;
    return { status: 200 };
  };
  const candidates = await detectCredential(
    { apiKey: 'test-key-1', baseUrl: 'https://models.example.com/v1' },
    { fetchImpl }
  );
  assert.equal(candidates[0].providerId, 'openai-compatible');
  assert.equal(candidates[0].method, 'model_discovery');
  assert.ok(seenUrl.endsWith('/models'), seenUrl);
  assert.equal(seenAuth, 'Bearer test-key-1');
});

test('unknown URL against a refused port reports unreachable, fast', async () => {
  const started = Date.now();
  const result = await validateCredential(
    { apiKey: 'test-key-1', baseUrl: 'http://127.0.0.1:9' },
    'http://127.0.0.1:9',
    { timeoutMs: 2000 }
  );
  const elapsed = Date.now() - started;
  assert.equal(result.status, 'unreachable');
  assert.ok(elapsed < 2000, `took ${elapsed}ms`);
});

test('a bare key with an unknown URL resolves only the generic fallback', async () => {
  const candidates = await detectCredential(
    {
      apiKey: 'sk-fake-key-without-vendor-signal',
      baseUrl: 'https://credentials.example.com/v1',
    },
    { fetchImpl: statusImpl(404) }
  );
  // The 404 proves reachability, so the only candidate is the generic
  // fallback — never a forced vendor fit.
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].providerId, 'openai-compatible');
  assert.equal(candidates[0].method, 'model_discovery');
});

test('a reachable credential resolves to the generic compatible candidate', async () => {
  const candidates = await detectCredential(
    {
      apiKey: 'test-key-1',
      baseUrl: 'https://alcore.io.vn/v1',
    },
    { fetchImpl: statusImpl(200) }
  );
  assert.ok(candidates.length >= 1, JSON.stringify(candidates));
  for (let i = 1; i < candidates.length; i += 1) {
    assert.ok(candidates[i - 1].confidence >= candidates[i].confidence);
  }
  assert.equal(candidates[0].providerId, 'openai-compatible');
});

test('validation taxonomy maps 401/403/429/timeout distinctly', async () => {
  const base = { apiKey: 'k', baseUrl: 'https://auth.example.com/v1' };
  const badAuth = await validateCredential(base, base.baseUrl, {
    fetchImpl: statusImpl(401),
  });
  assert.equal(badAuth.status, 'invalid');
  assert.equal(badAuth.reason, 'authentication_failed');

  const forbidden = await validateCredential(base, base.baseUrl, {
    fetchImpl: statusImpl(403),
  });
  assert.equal(forbidden.status, 'invalid');
  assert.equal(forbidden.reason, 'authorization_failed');

  const limited = await validateCredential(base, base.baseUrl, {
    fetchImpl: statusImpl(429),
  });
  assert.equal(limited.status, 'rate_limited');

  const timeoutImpl = async () => {
    const error = new Error('timeout of 50ms exceeded');
    error.code = 'ECONNABORTED';
    throw error;
  };
  const timedOut = await validateCredential(base, base.baseUrl, {
    fetchImpl: timeoutImpl,
  });
  assert.equal(timedOut.status, 'timeout');

  const valid = await validateCredential(base, base.baseUrl, {
    fetchImpl: statusImpl(200),
  });
  assert.equal(valid.status, 'valid');
  assert.equal(typeof valid.latencyMs, 'number');
});

test('results never carry secret material', async () => {
  const fakeKey = 'sk-fake-redaction-abcdef123456';
  const fetchImpl = statusImpl(200);
  const candidates = await detectCredential(
    { apiKey: fakeKey, baseUrl: 'https://alcore.io.vn/v1' },
    { fetchImpl }
  );
  const validation = await validateCredential(
    { apiKey: fakeKey, baseUrl: 'https://alcore.io.vn/v1' },
    'https://alcore.io.vn/v1',
    { fetchImpl }
  );
  const serialized = JSON.stringify({ candidates, validation });
  assert.ok(!serialized.includes(fakeKey));
  assert.ok(!serialized.includes('abcdef123456'));
});

test('registry facade lists an empty table and scores fixtures by URL', async () => {
  const known = listKnownProviders();
  assert.deepEqual(known, []);

  const fixtures = [
    {
      id: 'alcore',
      endpoint: 'https://alcore.io.vn/v1/chat/completions',
      base_url: 'https://alcore.io.vn/v1',
    },
    {
      id: 'custom',
      endpoint: 'https://custom.example.com/v1/chat/completions',
    },
  ];
  const scored = await scoreInstalledPlugins(
    { baseUrl: 'https://alcore.io.vn/v1' },
    { plugins: fixtures }
  );
  assert.equal(scored[0].pluginId, 'alcore');
  assert.equal(scored[0].score, 1);
  assert.equal(scored[scored.length - 1].pluginId, 'custom');
  assert.equal(scored[scored.length - 1].score, 0);
});

test('resolveProvider returns the top candidate plus validation', async () => {
  const resolved = await resolveProvider(
    { apiKey: 'k', baseUrl: 'https://alcore.io.vn/v1' },
    { fetchImpl: statusImpl(200) }
  );
  assert.equal(resolved.provider.providerId, 'openai-compatible');
  assert.equal(resolved.validation.status, 'valid');

  await assert.rejects(
    resolveProvider(
      { apiKey: 'k', baseUrl: 'http://127.0.0.1:9' },
      { timeoutMs: 1000 }
    ),
    error => {
      assert.ok(error instanceof ProviderDetectionError);
      assert.equal(error.code, 'no_candidate');
      return true;
    }
  );
});
