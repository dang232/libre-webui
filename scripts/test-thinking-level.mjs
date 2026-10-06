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
    { id: 'alcore', name: 'ALcore' },
    'gpt-5',
    message('hello'),
    { think: 'high' }
  );
  assert.equal(payload.reasoning_effort, 'high');

  const { payload: quiet } = chatAdapter.buildPluginChatPayload(
    { id: 'alcore', name: 'ALcore' },
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
    { id: 'alcore', name: 'ALcore' },
    'gpt-5',
    message('hello'),
    { think: true },
    {},
    undefined,
    'responses'
  );
  assert.deepEqual(payload.reasoning, { effort: 'medium', summary: 'auto' });
});

