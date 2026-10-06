import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const catalog = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'utils', 'pluginModelCatalog.js')
  ).href
);

const alcoreEntry = (id, extra = {}) => ({
  id,
  object: 'model',
  created: 1788982289,
  owned_by: 'tokenpanel',
  capabilities: { tools: true, json_mode: true, structured_output: true },
  context_window: 1000000,
  pricing: {
    currency: 'USD',
    input_micros_per_million: 0,
    output_micros_per_million: 0,
  },
  availability: 'preview',
  deprecated: false,
  ...extra,
});

test('object-form capabilities are read as explicit provider statements', () => {
  assert.deepEqual(catalog.readModelDetailsMap([alcoreEntry('al-1-2')]), {
    'al-1-2': {
      tools: true,
      jsonMode: true,
      structuredOutput: true,
      availability: 'preview',
      deprecated: false,
      pricing: {
        currency: 'USD',
        inputMicrosPerMillion: 0,
        outputMicrosPerMillion: 0,
      },
    },
  });
});

test('an explicit false is kept, an absent key stays unknown', () => {
  assert.deepEqual(
    catalog.readModelDetailsMap([
      alcoreEntry('a', { capabilities: { tools: false } }),
    ]),
    {
      a: {
        tools: false,
        availability: 'preview',
        deprecated: false,
        pricing: {
          currency: 'USD',
          inputMicrosPerMillion: 0,
          outputMicrosPerMillion: 0,
        },
      },
    }
  );
  assert.deepEqual(catalog.readModelDetailsMap([{ id: 'quiet' }]), {});
  assert.deepEqual(
    catalog.readModelDetailsMap([
      { id: 'odd', capabilities: ['tools'], pricing: 'free' },
    ]),
    {}
  );
});

test('details round-trip through the stored catalog', () => {
  const stored = catalog.parseDiscoveredCatalog(
    catalog.serializeDiscoveredCatalog({
      models: ['al-1-2', 'quiet'],
      modelDetails: catalog.readModelDetailsMap([
        alcoreEntry('al-1-2'),
        { id: 'quiet' },
      ]),
    })
  );
  assert.deepEqual(stored.models, ['al-1-2', 'quiet']);
  assert.equal(stored.modelDetails['al-1-2'].tools, true);
  assert.equal(stored.modelDetails['al-1-2'].jsonMode, true);
  assert.equal(
    stored.modelDetails['al-1-2'].pricing.inputMicrosPerMillion,
    0
  );
  assert.equal(stored.modelDetails['quiet'], undefined);
  assert.equal(stored.legacy, undefined);
});

test('a catalog written before details still reads as non-legacy', () => {
  const stored = catalog.parseDiscoveredCatalog(
    JSON.stringify({
      version: 1,
      models: ['a'],
      context: {},
      reasoning: {},
    })
  );
  assert.deepEqual(stored.models, ['a']);
  assert.equal(stored.modelDetails, undefined);
  assert.equal(stored.legacy, undefined);
});
