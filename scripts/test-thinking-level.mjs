import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
const testDataDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'libre-thinking-level-')
);
process.env.DATA_DIR = testDataDirectory;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const backendImport = segments =>
  import(pathToFileURL(path.join(repoRoot, 'backend', 'dist', ...segments)).href);

const thinking = await backendImport(['utils', 'thinkingOptions.js']);
const chatAdapter = await backendImport(['utils', 'pluginChatAdapter.js']);

after(() => {
  fs.rmSync(testDataDirectory, { recursive: true, force: true });
});

const message = content => [
  { id: 'm1', role: 'user', content, timestamp: 1 },
];


test('a thinking setting is read only in the forms a provider can use', () => {
  assert.equal(thinking.normalizeThinkingPreference('high'), 'high');
  assert.equal(thinking.normalizeThinkingPreference(true), true);
  assert.equal(thinking.normalizeThinkingPreference(false), false);
  assert.equal(thinking.normalizeThinkingPreference(null), undefined);
  assert.equal(thinking.normalizeThinkingPreference('maximum'), undefined);

  assert.equal(thinking.thinkingEffort(true), 'medium');
  assert.equal(thinking.thinkingEffort('low'), 'low');
  assert.equal(thinking.thinkingEffort(false), undefined);
  assert.equal(thinking.thinkingEffort(null), undefined);

  assert.equal(thinking.thinkingBudgetTokens('low'), 2048);
  assert.equal(thinking.thinkingBudgetTokens(false), undefined);
  // A reply has to fit beside the reasoning that produced it.
  assert.ok(thinking.maxTokensForBudget(1024, 8192) > 8192);
  assert.equal(thinking.maxTokensForBudget(64000, 8192), 64000);
});

test('OpenAI-compatible providers receive a reasoning effort', () => {
  const { payload } = chatAdapter.buildPluginChatPayload(
    { id: 'openai', name: 'OpenAI' },
    'gpt-5',
    message('hello'),
    { think: 'high' }
  );
  assert.equal(payload.reasoning_effort, 'high');

  const { payload: quiet } = chatAdapter.buildPluginChatPayload(
    { id: 'openai', name: 'OpenAI' },
    'gpt-5',
    message('hello'),
    {}
  );
  assert.ok(
    !('reasoning_effort' in quiet),
    'a model that was never asked to reason should not carry the field'
  );
});

test('the Responses API receives the effort in its own shape', () => {
  const { payload } = chatAdapter.buildPluginChatPayload(
    { id: 'openai', name: 'OpenAI' },
    'gpt-5',
    message('hello'),
    { think: true },
    {},
    undefined,
    'responses'
  );
  assert.deepEqual(payload.reasoning, { effort: 'medium', summary: 'auto' });
});

test('Anthropic receives a budget, and no sampling beside it', () => {
  const { payload } = chatAdapter.buildPluginChatPayload(
    { id: 'anthropic', name: 'Anthropic' },
    'claude-sonnet-4-5',
    message('hello'),
    { think: 'medium' }
  );
  assert.deepEqual(payload.thinking, {
    type: 'enabled',
    budget_tokens: 8192,
  });
  assert.ok(
    payload.max_tokens > 8192,
    'the answer needs room beyond the reasoning budget'
  );
  assert.ok(!('temperature' in payload));
  assert.ok(!('top_p' in payload));

  // An explicit answer cap is respected: the budget shrinks into it rather
  // than the cap being silently raised past what the user asked for.
  const { payload: capped } = chatAdapter.buildPluginChatPayload(
    { id: 'anthropic', name: 'Anthropic' },
    'claude-sonnet-4-5',
    message('hello'),
    { think: 'medium', num_predict: 4096 }
  );
  assert.equal(capped.max_tokens, 4096);
  assert.equal(capped.thinking.budget_tokens, 4096 - 1024);

  // The model's documented output ceiling bounds max_tokens and the budget:
  // high thinking on an 8192-ceiling model must not ask for 17408.
  const { payload: ceilinged } = chatAdapter.buildPluginChatPayload(
    { id: 'anthropic', name: 'Anthropic' },
    'claude-3-5-haiku-20241022',
    message('hello'),
    { think: 'high' }
  );
  assert.equal(ceilinged.max_tokens, 8192);
  assert.equal(ceilinged.thinking.budget_tokens, 8192 - 1024);

  // Without a thinking setting the sampling behaviour is unchanged.
  const { payload: sampled } = chatAdapter.buildPluginChatPayload(
    { id: 'anthropic', name: 'Anthropic' },
    'claude-sonnet-4-5',
    message('hello'),
    { num_predict: 1024 }
  );
  assert.ok(!('thinking' in sampled));
  assert.equal(sampled.max_tokens, 1024);
  assert.equal(typeof sampled.temperature, 'number');
});

test('Gemini receives a thinking budget in its generation config', () => {
  const { payload } = chatAdapter.buildPluginChatPayload(
    { id: 'gemini', name: 'Gemini' },
    'gemini-2.5-flash',
    message('hello'),
    { think: 'low' }
  );
  assert.deepEqual(payload.generationConfig.thinkingConfig, {
    thinkingBudget: 2048,
    includeThoughts: true,
  });
  assert.ok(
    payload.generationConfig.maxOutputTokens >= 2048 + 1024,
    'thinking counts against maxOutputTokens, so the ceiling must hold both'
  );

  const { payload: quiet } = chatAdapter.buildPluginChatPayload(
    { id: 'gemini', name: 'Gemini' },
    'gemini-2.5-flash',
    message('hello'),
    {}
  );
  assert.ok(!('thinkingConfig' in quiet.generationConfig));
});
