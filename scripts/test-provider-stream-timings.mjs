import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const adapter = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'utils', 'pluginStreamAdapter.js')
  ).href
);

/** A clock that returns a pre-programmed time per call. */
const scriptedClock = times => {
  let calls = 0;
  return {
    now: () => times[Math.min(calls++, times.length - 1)],
  };
};

const collect = async iterable => {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
};

test('the raw parser leaves a timing-less provider stream without timings', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hi"}}]}',
    'data: {"usage":{"prompt_tokens":2644,"completion_tokens":186,"total_tokens":2830}}',
    'data: [DONE]',
  ].join('\n\n');
  const chunks = await collect(
    adapter.streamOpenAICompatibleResponse(new Response(sse))
  );
  const usage = chunks.find(chunk => chunk.type === 'usage');
  assert.ok(usage, 'a usage chunk is parsed');
  assert.deepEqual(usage.usage, {
    promptTokens: 2644,
    completionTokens: 186,
    totalTokens: 2830,
  });
  assert.equal(
    usage.timings,
    undefined,
    'no server timings means no timings yet'
  );
});

test('a timing-less usage chunk gains the measured split', async () => {
  const chunks = await collect(
    adapter.withMeasuredStreamTimings(
      (async function* () {
        yield { type: 'content', content: 'Hi' };
        yield { type: 'content', content: ' there' };
        yield {
          type: 'usage',
          usage: { promptTokens: 2644, completionTokens: 186 },
        };
        yield { type: 'done' };
      })(),
      scriptedClock([1000, 1250, 2000])
    )
  );
  const usage = chunks.find(chunk => chunk.type === 'usage');
  assert.deepEqual(usage.usage, {
    promptTokens: 2644,
    completionTokens: 186,
  });
  assert.deepEqual(usage.timings, { promptMs: 250, predictedMs: 750 });
});

test('server-reported timings are never overwritten', async () => {
  const server = { promptMs: 11, predictedMs: 22 };
  const chunks = await collect(
    adapter.withMeasuredStreamTimings(
      (async function* () {
        yield { type: 'content', content: 'Hi' };
        yield { type: 'usage', usage: { promptTokens: 1 }, timings: server };
        yield { type: 'done' };
      })(),
      scriptedClock([1000, 1250, 2000])
    )
  );
  const usage = chunks.find(chunk => chunk.type === 'usage');
  assert.deepEqual(usage.timings, server);
});

test('usage before any content counts everything as prompt time', async () => {
  const chunks = await collect(
    adapter.withMeasuredStreamTimings(
      (async function* () {
        yield { type: 'usage', usage: { promptTokens: 5 } };
        yield { type: 'done' };
      })(),
      scriptedClock([1000, 2000])
    )
  );
  const usage = chunks.find(chunk => chunk.type === 'usage');
  assert.deepEqual(usage.timings, { promptMs: 1000, predictedMs: 0 });
});

test('a streamed provider reply ends with measurable durations', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hi"}}]}',
    'data: {"choices":[{"delta":{"content":" there"}}]}',
    'data: {"usage":{"prompt_tokens":2644,"completion_tokens":186,"total_tokens":2830}}',
    'data: [DONE]',
  ].join('\n\n');
  const chunks = await collect(
    adapter.withMeasuredStreamTimings(
      adapter.streamOpenAICompatibleResponse(new Response(sse))
    )
  );
  const usage = chunks.find(chunk => chunk.type === 'usage');
  assert.deepEqual(usage.usage, {
    promptTokens: 2644,
    completionTokens: 186,
    totalTokens: 2830,
  });
  assert.ok(usage.timings, 'wall-clock timings are attached');
  assert.ok(
    typeof usage.timings.promptMs === 'number' && usage.timings.promptMs >= 0
  );
  assert.ok(
    typeof usage.timings.predictedMs === 'number' &&
      usage.timings.predictedMs >= 0
  );
});
