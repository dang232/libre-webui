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

test('openai base URL resolves to the explicit openai candidate', async () => {
  const candidates = await detectCredential({
    baseUrl: 'https://api.openai.com/v1',
  });
  assert.equal(candidates[0].providerId, 'openai');
  assert.equal(candidates[0].method, 'explicit');
  assert.equal(candidates[0].confidence, 1);
});

test('anthropic endpoint resolves to the explicit anthropic candidate', async () => {
  const candidates = await detectCredential({
    baseUrl: 'https://api.anthropic.com/v1/messages',
  });
  assert.equal(candidates[0].providerId, 'anthropic');
  assert.equal(candidates[0].method, 'explicit');
});

test('google endpoint resolves to gemini via host match', async () => {
  const candidates = await detectCredential({
    baseUrl:
      'https://generativelanguage.googleapis.com/v1beta/' +
      'models/gemini-2.5-flash:generateContent',
  });
  assert.equal(candidates[0].providerId, 'gemini');
  assert.equal(candidates[0].method, 'base_url');
  assert.equal(candidates[0].confidence, 0.9);
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

test('a bare sk- key with an unknown URL never resolves openai', async () => {
  const candidates = await detectCredential(
    {
      apiKey: 'sk-fake-key-without-vendor-signal',
      baseUrl: 'https://credentials.example.com/v1',
    },
    { fetchImpl: statusImpl(404) }
  );
  assert.equal(
    candidates.filter(c => c.providerId === 'openai').length,
    0
  );
  // The 404 proves reachability, so the only candidate is the generic
  // fallback — never a forced vendor fit.
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].providerId, 'openai-compatible');
  assert.equal(candidates[0].method, 'model_discovery');
});

test('ambiguous input yields sorted candidates', async () => {
  const candidates = await detectCredential(
    {
      apiKey: 'sk-test-ambiguous',
      baseUrl: 'https://api.openai.com/v1',
    },
    { fetchImpl: statusImpl(200) }
  );
  assert.ok(candidates.length >= 2, JSON.stringify(candidates));
  for (let i = 1; i < candidates.length; i += 1) {
    assert.ok(candidates[i - 1].confidence >= candidates[i].confidence);
  }
  assert.equal(candidates[0].providerId, 'openai');
  assert.equal(candidates[0].method, 'explicit');
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
    { apiKey: fakeKey, baseUrl: 'https://api.openai.com/v1' },
    { fetchImpl }
  );
  const validation = await validateCredential(
    { apiKey: fakeKey, baseUrl: 'https://api.openai.com/v1' },
    'https://api.openai.com/v1',
    { fetchImpl }
  );
  const serialized = JSON.stringify({ candidates, validation });
  assert.ok(!serialized.includes(fakeKey));
  assert.ok(!serialized.includes('abcdef123456'));
});

test('registry facade lists the table and scores fixtures', async () => {
  const known = listKnownProviders();
  assert.equal(known.length, 7);
  const ids = known.map(p => p.providerId).sort();
  assert.deepEqual(ids, [
    'anthropic',
    'deepseek',
    'gemini',
    'groq',
    'mistral',
    'openai',
    'openrouter',
  ]);

  const fixtures = [
    {
      id: 'openai',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      base_url: 'https://api.openai.com/v1',
    },
    {
      id: 'custom',
      endpoint: 'https://custom.example.com/v1/chat/completions',
    },
  ];
  const scored = await scoreInstalledPlugins(
    { baseUrl: 'https://api.openai.com/v1' },
    { plugins: fixtures }
  );
  assert.equal(scored[0].pluginId, 'openai');
  assert.equal(scored[0].score, 1);
  assert.equal(scored[scored.length - 1].pluginId, 'custom');
  assert.equal(scored[scored.length - 1].score, 0);
});

test('resolveProvider returns the top candidate plus validation', async () => {
  const resolved = await resolveProvider(
    { apiKey: 'k', baseUrl: 'https://api.openai.com/v1' },
    { fetchImpl: statusImpl(200) }
  );
  assert.equal(resolved.provider.providerId, 'openai');
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
