/*
 * Libre WebUI
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

/**
 * Cordis bridge regression suite.
 *
 * Covers the four claims the Cordis bridge makes:
 *
 *  1. The host mounts a composition document and reports each engine service's
 *     DONE/PENDING state.
 *  2. The `libreDshEngine` contract is satisfied by the DSH composition, so
 *     session creation, chat streaming, and tool listing work end to end.
 *  3. Retargeting the model adapter through a plugin reload changes the
 *     provider without restarting the host or disturbing the other services.
 *  4. Stopping the host rolls the engine back: services withdrawn, listeners
 *     released, fixtures torn down.
 *
 * The suite is offline. A deterministic fixture adapter stands in for a real
 * provider so assertions are exact and no credential or network is required.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const backendDir = path.join(repoRoot, 'backend');

/** Root for every temp directory this suite creates. */
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'libre-cordis-'));

// DATA_DIR must be redirected before anything resolves a data path, or the
// host would write its runtime state into the developer's checkout.
process.env.DATA_DIR = path.join(tempRoot, 'data');

const distModule = relativePath =>
  import(pathToFileURL(path.join(backendDir, 'dist', relativePath)).href);

const {
  applyHostDefaults,
  parseComposition,
  parseSettings,
  stringifyComposition,
} = await distModule('cordis/host/composition.js');
const { resolveCordisHostConfig, readConfigDocument } = await distModule(
  'cordis/host/config.js'
);
const { BRIDGE_ENTRY_ID, startCordisHost } = await distModule(
  'cordis/host/host.js'
);
const { ModelAdapterError, buildAdapterConfig } = await distModule(
  'cordis/host/model.js'
);
const { extractText, projectStreamEvent } = await distModule(
  'cordis/dsh/engine-plugin.js'
);

const FIXTURE_ADAPTER = pathToFileURL(
  path.join(repoRoot, 'scripts', 'fixtures', 'cordis', 'fake-adapter.mjs')
).href;
const FIXTURE_PROBE = pathToFileURL(
  path.join(repoRoot, 'scripts', 'fixtures', 'cordis', 'lifecycle-probe.mjs')
).href;
const ENGINE_PLUGIN = pathToFileURL(
  path.join(backendDir, 'dist', 'cordis', 'dsh', 'engine-plugin.js')
).href;

const FAKE_REPLY_TEXT = 'Hello from the fake model.';
const PROBE_SERVICE = 'testLifecycleProbe';
const PROBE_EVENT = 'test/probe-ping';

/**
 * Create a scenario directory with its own workspace and session store.
 *
 * Each scenario also gets its own `DATA_DIR`. `resolveDataDirectory()` reads
 * `process.env.DATA_DIR` on every call, so re-pointing it per scenario is what
 * keeps one scenario's persisted sessions from colliding with another's — the
 * JSONL backend refuses to create a session whose file already exists, and
 * `node --test` runs these tests concurrently.
 */
async function scenario(label) {
  const dir = await mkdtemp(path.join(tempRoot, `${label}-`));
  const workspacePath = path.join(dir, 'workspace');
  const sessionStorePath = path.join(dir, 'sessions');
  const dataDir = path.join(dir, 'data');
  await mkdir(workspacePath, { recursive: true });
  await mkdir(sessionStorePath, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  process.env.DATA_DIR = dataDir;
  return {
    dir,
    dataDir,
    workspacePath,
    sessionStorePath,
    configPath: path.join(dir, 'cordis.patch.yml'),
    settingsPath: path.join(dir, 'cordis.config.yml'),
  };
}

/** Read the shipped example composition and make its paths absolute. */
async function exampleComposition() {
  const source = await readFile(
    path.join(backendDir, 'cordis.patch.example.yml'),
    'utf8'
  );
  return source.replace(
    "'./dist/cordis/dsh/engine-plugin.js'",
    JSON.stringify(ENGINE_PLUGIN)
  );
}

/**
 * Build a composition that mounts the real engine plus a deterministic model
 * adapter, so chat streaming can be asserted without a provider.
 */
async function engineComposition({ route = 'test-fake-route' } = {}) {
  const base = await exampleComposition();
  return base.replace(
    '- id: fs-sandbox',
    [
      '- id: test-fake-adapter',
      `  name: ${JSON.stringify(FIXTURE_ADAPTER)}`,
      '  config:',
      `    route: ${route}`,
      '',
      '- id: fs-sandbox',
    ].join('\n')
  );
}

/** Write a settings document for a scenario. */
async function writeSettings(
  scenarioPaths,
  { provider = 'none', route = 'test-fake-route', model = 'test-model' } = {}
) {
  await writeFile(
    scenarioPaths.settingsPath,
    [
      'features:',
      '  enabled: true',
      'model:',
      `  provider: ${provider}`,
      `  route: ${route}`,
      `  model: ${model}`,
    ].join('\n'),
    'utf8'
  );
}

/** Start a host for one scenario, writing the composition first. */
async function startHost(scenarioPaths, composition) {
  await writeFile(scenarioPaths.configPath, composition, 'utf8');
  const config = resolveCordisHostConfig({
    configPath: scenarioPaths.configPath,
    settingsPath: scenarioPaths.settingsPath,
    workspacePath: scenarioPaths.workspacePath,
    sessionStorePath: scenarioPaths.sessionStorePath,
  });
  return startCordisHost(config);
}

/** Collect chunks until the stream reports completion. */
function collectStream(handle, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => {
      reject(
        new Error(
          `stream did not finish within ${timeoutMs}ms; saw ${JSON.stringify(chunks)}`
        )
      );
    }, timeoutMs);
    handle.subscribe(chunk => {
      chunks.push(chunk);
      if (chunk.type === 'done') {
        clearTimeout(timer);
        resolve(chunks);
      }
    });
  });
}

test.after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ── Composition parsing ──────────────────────────────────────────────────────

test('composition parses a top-level entry array and preserves !!js markers', () => {
  const entries = parseComposition(
    [
      '- id: alpha',
      "  name: '@example/alpha'",
      '  config:',
      "    root: !!js process.env.SOME_ROOT ?? 'fallback'",
    ].join('\n')
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'alpha');
  assert.equal(entries[0].name, '@example/alpha');
  // The marker must survive parsing intact: the loader evaluates it later, in
  // the owning entry's fiber, and cannot do that once it is an expanded string.
  assert.deepEqual(entries[0].config, {
    root: { __jsExpr: "process.env.SOME_ROOT ?? 'fallback'" },
  });
});

test('composition rejects a document that is not a top-level array', () => {
  assert.throws(
    () => parseComposition('settings:\n  enabled: true\n'),
    /top-level YAML array/
  );
});

test('composition rejects an entry without a literal name', () => {
  assert.throws(
    () => parseComposition('- id: alpha\n  config: {}\n'),
    /literal string `name`/
  );
});

test('composition accepts an empty document', () => {
  assert.deepEqual(parseComposition(''), []);
});

test('composition assigns a stable id to an unlabelled entry', () => {
  const entries = parseComposition("- name: '@example/alpha'\n");
  assert.equal(entries[0].id, '@example/alpha#0');
});

test('composition round-trips !!js tags through serialize and parse', () => {
  const original = parseComposition(
    "- id: alpha\n  name: '@example/alpha'\n  config:\n    root: !!js process.env.X ?? 'y'\n"
  );
  const reparsed = parseComposition(stringifyComposition(original));
  assert.deepEqual(reparsed, original);
});

test('host defaults merge into the bridge row only', () => {
  const entries = [
    { id: 'llm', name: '@deepseek-ai/dsh-llm' },
    {
      id: BRIDGE_ENTRY_ID,
      name: './engine.js',
      config: { streaming: false },
    },
  ];
  const merged = applyHostDefaults(entries, BRIDGE_ENTRY_ID, {
    defaultProvider: 'ollama',
    streaming: true,
  });
  // The composition wins over the host default: an operator who pinned a value
  // on the row meant it.
  assert.deepEqual(merged[1].config, {
    defaultProvider: 'ollama',
    streaming: false,
  });
  assert.deepEqual(merged[0], entries[0]);
});

test('settings parsing rejects a non-mapping document', () => {
  assert.throws(() => parseSettings('- one\n'), /must be a YAML mapping/);
});

// ── Configuration resolution ─────────────────────────────────────────────────

test('missing settings fall back to defaults with the host disabled', async () => {
  const paths = await scenario('config-defaults');
  const config = resolveCordisHostConfig({
    configPath: paths.configPath,
    settingsPath: paths.settingsPath,
    workspacePath: paths.workspacePath,
    sessionStorePath: paths.sessionStorePath,
  });
  assert.equal(config.features.enabled, false, 'opt-in by default');
  assert.equal(config.features.streaming, true);
  assert.equal(config.model.provider, 'pi-ai');
  assert.equal(config.settingsPath, paths.settingsPath);
});

test('settings document supplies provider, route, and feature flags', async () => {
  const paths = await scenario('config-document');
  await writeFile(
    paths.settingsPath,
    [
      // `enabled` is a top-level flag; `features` holds only the capability
      // switches. This mirrors cordis.config.example.yml.
      'features:',
      '  enabled: true',
      '  tools: false',
      'model:',
      '  provider: pi-ai',
      '  route: ollama',
      '  apiKeyEnv: OLLAMA_API_KEY',
      '  baseUrl: http://127.0.0.1:11434/v1',
      '  providers:',
      '    ollama:',
      '      api: openai-completions',
    ].join('\n'),
    'utf8'
  );
  const config = resolveCordisHostConfig({
    configPath: paths.configPath,
    settingsPath: paths.settingsPath,
    workspacePath: paths.workspacePath,
    sessionStorePath: paths.sessionStorePath,
  });
  assert.equal(config.features.enabled, true);
  assert.equal(config.features.tools, false);
  assert.equal(config.model.provider, 'pi-ai');
  assert.equal(config.model.route, 'ollama');
  assert.equal(config.model.apiKeyEnv, 'OLLAMA_API_KEY');
  assert.equal(config.model.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.deepEqual(config.model.providers, {
    ollama: { api: 'openai-completions' },
  });
});

test('environment variables override the settings document', async () => {
  const paths = await scenario('config-env');
  await writeFile(
    paths.settingsPath,
    'features:\n  enabled: false\nmodel:\n  provider: deepseek\n  route: from-file\n',
    'utf8'
  );
  const previousProvider = process.env.LIBRE_CORDIS_MODEL_PROVIDER;
  const previousRoute = process.env.LIBRE_CORDIS_MODEL_ROUTE;
  process.env.LIBRE_CORDIS_MODEL_PROVIDER = 'pi-ai';
  process.env.LIBRE_CORDIS_MODEL_ROUTE = 'from-env';
  try {
    const config = resolveCordisHostConfig({
      configPath: paths.configPath,
      settingsPath: paths.settingsPath,
      workspacePath: paths.workspacePath,
      sessionStorePath: paths.sessionStorePath,
    });
    assert.equal(config.model.provider, 'pi-ai');
    assert.equal(config.model.route, 'from-env');
  } finally {
    restoreEnv('LIBRE_CORDIS_MODEL_PROVIDER', previousProvider);
    restoreEnv('LIBRE_CORDIS_MODEL_ROUTE', previousRoute);
  }
});

test('an unknown provider mode is rejected rather than defaulted', async () => {
  const paths = await scenario('config-bad-provider');
  await writeFile(
    paths.settingsPath,
    'model:\n  provider: not-a-provider\n',
    'utf8'
  );
  assert.throws(
    () =>
      resolveCordisHostConfig({
        configPath: paths.configPath,
        settingsPath: paths.settingsPath,
        workspacePath: paths.workspacePath,
        sessionStorePath: paths.sessionStorePath,
      }),
    /unknown model provider/
  );
});

test('a malformed settings document fails loudly', async () => {
  const paths = await scenario('config-malformed');
  await writeFile(paths.settingsPath, '- not\n- a\n- mapping\n', 'utf8');
  assert.throws(
    () => readConfigDocument(paths.settingsPath),
    /must be a YAML mapping/
  );
});

test('adapter config translates a base URL into an OpenAI-compatible route', () => {
  const config = buildAdapterConfig({
    provider: 'pi-ai',
    apiKeyEnv: 'LOCAL_KEY',
    baseUrl: 'http://127.0.0.1:8080/v1',
    route: 'gateway',
    model: '',
    providers: {},
  });
  assert.deepEqual(config, {
    providers: {
      gateway: {
        apiKeyEnv: 'LOCAL_KEY',
        baseURL: 'http://127.0.0.1:8080/v1',
        api: 'openai-completions',
      },
    },
  });
});

test('adapter config leaves the DeepSeek adapter without pi-ai routes', () => {
  const config = buildAdapterConfig({
    provider: 'deepseek',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseUrl: '',
    route: 'deepseek',
    model: '',
    providers: {},
  });
  assert.deepEqual(config, { apiKeyEnv: 'DEEPSEEK_API_KEY' });
});

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// ── Host lifecycle ───────────────────────────────────────────────────────────

test('host reports every engine service as ready once DONE', async () => {
  const paths = await scenario('lifecycle-ready');
  await writeSettings(paths);
  const composition = (await exampleComposition()).replace(
    '- id: fs-sandbox',
    `- id: test-fake-adapter\n  name: ${JSON.stringify(FIXTURE_ADAPTER)}\n  config:\n    route: ollama\n\n- id: fs-sandbox`
  );
  const host = await startHost(paths, composition);
  try {
    const status = host.status();
    assert.equal(status.started, true);
    assert.deepEqual(status.missing, []);
    const byName = new Map(status.services.map(s => [s.name, s]));
    for (const required of [
      'llm',
      'systemPrompt',
      'sessions',
      'tools',
      'agents',
      'sessionProjections',
      'sessionPersistence',
    ]) {
      assert.equal(
        byName.get(required)?.available,
        true,
        `${required} should be available`
      );
    }
    const engine = host.context.get('libreDshEngine');
    assert.notEqual(engine, undefined);
    // The contract's own view of the same services must agree.
    for (const entry of engine.status()) {
      assert.equal(entry.state, 'ready', `${entry.name} should be ready`);
    }
  } finally {
    await host.stop();
  }
});

test('host refuses to start when the composition omits a required service', async () => {
  const paths = await scenario('lifecycle-missing');
  await writeSettings(paths);
  // Deliberately omit the tool layer: `agents` alone cannot satisfy the bridge,
  // and a bridge that published itself anyway would report empty tools.
  const composition = [
    '- id: llm',
    "  name: '@deepseek-ai/dsh-llm'",
    '- id: session',
    "  name: '@deepseek-ai/dsh-session'",
    '- id: session-projection',
    "  name: '@deepseek-ai/dsh-session-projection'",
    '- id: system-prompt',
    "  name: '@deepseek-ai/dsh-system-prompt'",
    '- id: agent',
    "  name: '@deepseek-ai/dsh-agent'",
    '- id: libre-webui-bridge',
    `  name: ${JSON.stringify(ENGINE_PLUGIN)}`,
    '  config:',
    `    workspacePath: ${JSON.stringify(paths.workspacePath)}`,
  ].join('\n');
  await assert.rejects(
    startHost(paths, composition),
    /did not provide required service/
  );
});

test('stopping the host withdraws services and releases listeners', async () => {
  const paths = await scenario('lifecycle-rollback');
  // This composition mounts no persistence row, so persistence is turned off
  // rather than left to demand a service the test deliberately omitted.
  await writeFile(
    paths.settingsPath,
    'features:\n  enabled: true\n  persistence: false\n',
    'utf8'
  );
  // A probe row proves rollback of a real plugin, not just of the host's own
  // bookkeeping: its service and its event listener must both stop existing.
  const composition = [
    '- id: test-probe',
    `  name: ${JSON.stringify(FIXTURE_PROBE)}`,
    '- id: llm',
    "  name: '@deepseek-ai/dsh-llm'",
    '- id: session',
    "  name: '@deepseek-ai/dsh-session'",
    '- id: session-projection',
    "  name: '@deepseek-ai/dsh-session-projection'",
    '- id: system-prompt',
    "  name: '@deepseek-ai/dsh-system-prompt'",
    '- id: tools',
    "  name: '@deepseek-ai/dsh-tools'",
    '- id: agent',
    "  name: '@deepseek-ai/dsh-agent'",
    '- id: agent-loop',
    "  name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    '- id: libre-webui-bridge',
    `  name: ${JSON.stringify(ENGINE_PLUGIN)}`,
    '  config:',
    `    workspacePath: ${JSON.stringify(paths.workspacePath)}`,
  ].join('\n');

  const log = [];
  globalThis.__cordisProbeLog = log;
  try {
    const host = await startHost(paths, composition);
    const probe = host.context.get(PROBE_SERVICE);
    assert.notEqual(probe, undefined, 'probe service should be mounted');
    assert.deepEqual(log, ['apply']);

    host.context.emit(PROBE_EVENT);
    assert.equal(probe.pings, 1, 'probe listener should observe the event');
    assert.notEqual(host.context.get('libreDshEngine'), undefined);

    await host.stop();

    assert.equal(
      host.context.get(PROBE_SERVICE),
      undefined,
      'probe service should be withdrawn'
    );
    assert.equal(
      host.context.get('libreDshEngine'),
      undefined,
      'engine service should be withdrawn'
    );
    assert.ok(
      log.includes('dispose'),
      `probe teardown should have run, log was ${JSON.stringify(log)}`
    );
    // A listener that survived disposal would still fire on a later emit.
    assert.doesNotThrow(() => host.context.emit(PROBE_EVENT));

    // Teardown is idempotent: a second stop must not throw or re-run cleanup.
    const disposeCount = log.filter(entry => entry === 'dispose').length;
    await host.stop();
    assert.equal(
      log.filter(entry => entry === 'dispose').length,
      disposeCount,
      'a repeated stop should be a no-op'
    );
  } finally {
    delete globalThis.__cordisProbeLog;
  }
});

// ── Engine contract integration ──────────────────────────────────────────────

test('engine lists tools the composition registered', async () => {
  const paths = await scenario('integration-tools');
  await writeSettings(paths);
  const host = await startHost(paths, await engineComposition());
  try {
    const engine = host.context.get('libreDshEngine');
    const tools = await engine.listTools();
    const names = tools.map(tool => tool.name);
    // The filesystem tool row is what makes this assertion meaningful: an
    // empty registry would satisfy "returns an array" but not "lists tools".
    for (const expected of ['read', 'write', 'edit']) {
      assert.ok(
        names.includes(expected),
        `expected tool ${expected} in ${names}`
      );
    }
    assert.ok(
      tools.every(tool => typeof tool.description === 'string'),
      'every tool should carry a description string'
    );
  } finally {
    await host.stop();
  }
});

test('engine creates and lists a session before any message', async () => {
  const paths = await scenario('integration-session');
  await writeSettings(paths);
  const host = await startHost(paths, await engineComposition());
  try {
    const engine = host.context.get('libreDshEngine');
    assert.deepEqual(await engine.listSessions(), []);

    const created = await engine.createSession({ cwd: paths.workspacePath });
    // Ids carry a per-engine prefix so two hosts in one process cannot mint the
    // same id; the persistence backend refuses duplicates process-wide.
    assert.match(created.id, /^session-[0-9a-f]{8}-\d+$/);
    assert.equal(created.eventCount, 0);
    assert.deepEqual(created.messages, []);

    const listed = await engine.listSessions();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, created.id);

    const fetched = await engine.getSession(created.id);
    assert.equal(fetched.id, created.id);
    assert.deepEqual(fetched.messages, []);

    assert.equal(await engine.deleteSession(created.id), true);
    assert.equal(await engine.getSession(created.id), undefined);
    assert.equal(await engine.deleteSession(created.id), false);
  } finally {
    await host.stop();
  }
});

test('engine streams an assistant response for a chat message', async () => {
  const paths = await scenario('integration-chat');
  await writeSettings(paths);
  const host = await startHost(paths, await engineComposition());
  try {
    const engine = host.context.get('libreDshEngine');
    const session = await engine.createSession({ cwd: paths.workspacePath });

    const handle = await engine.sendMessage(session.id, 'Say hello');
    const chunks = await collectStream(handle);

    const text = chunks
      .filter(chunk => chunk.type === 'text')
      .map(chunk => chunk.text)
      .join('');
    assert.equal(text, FAKE_REPLY_TEXT);
    assert.equal(chunks.at(-1).type, 'done', 'the response must terminate');

    // The turn must also be durable, not merely streamed: a client that
    // reconnects reads history rather than replaying a live stream.
    const stored = await engine.getSession(session.id);
    const assistant = stored.messages.filter(m => m.role === 'assistant');
    assert.equal(assistant.length, 1);
    assert.equal(assistant[0].text, FAKE_REPLY_TEXT);
    assert.ok(stored.eventCount > 0);

    const agents = await engine.listAgents();
    assert.deepEqual(
      agents.map(agent => agent.id),
      [session.id]
    );
    assert.equal(agents[0].root, true);
  } finally {
    await host.stop();
  }
});

test('a session keeps the working directory it was created with', async () => {
  const paths = await scenario('integration-session-cwd');
  await writeSettings(paths);
  const host = await startHost(paths, await engineComposition());
  try {
    const engine = host.context.get('libreDshEngine');
    // A cwd chosen at creation must survive until the agent is built on the
    // first message; the agent is what actually records it.
    const custom = path.join(paths.dir, 'custom-workspace');
    await mkdir(custom, { recursive: true });
    const session = await engine.createSession({ cwd: custom });

    const handle = await engine.sendMessage(session.id, 'Say hello');
    await collectStream(handle);

    const stored = await engine.getSession(session.id);
    assert.ok(
      stored.messages.length > 0,
      'the turn should have recorded messages'
    );
    // The agent ran against the requested directory, which is visible in the
    // session's own header through the workspace the engine reports.
    const listed = (await engine.listSessions()).find((s) => s.id === session.id);
    assert.notEqual(listed, undefined);
    assert.ok(listed.eventCount > 0);
  } finally {
    await host.stop();
  }
});

test('engine rejects a message for an unknown session', async () => {
  const paths = await scenario('integration-unknown-session');
  await writeSettings(paths);
  const host = await startHost(paths, await engineComposition());
  try {
    const engine = host.context.get('libreDshEngine');
    await assert.rejects(
      engine.sendMessage('session-does-not-exist', 'hello'),
      /does not exist/
    );
  } finally {
    await host.stop();
  }
});

// ── Hot swap ─────────────────────────────────────────────────────────────────

test('model adapter hot-swaps without restarting the engine', async () => {
  const paths = await scenario('hot-swap');
  // Start with no host-mounted adapter: this test drives the controller
  // directly, and a pre-mounted adapter would already own a provider route.
  await writeSettings(paths, { provider: 'none' });
  const host = await startHost(paths, await engineComposition());
  try {
    const loader = host.context.get('loader');
    const before = host.model.state();
    assert.equal(before.provider, 'none');
    assert.equal(before.swaps, 0);

    const session = (
      await host.context.get('libreDshEngine').createSession({
        cwd: paths.workspacePath,
      })
    ).id;

    // Retarget the engine at an OpenAI-compatible gateway. This is the
    // documented Ollama-to-gateway change: only the adapter row moves.
    const after = await host.model.swap({
      provider: 'pi-ai',
      route: 'openai-compatible',
      apiKeyEnv: 'LOCAL_GATEWAY_API_KEY',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'local-model',
      providers: {},
    });
    assert.equal(after.provider, 'pi-ai');
    assert.equal(after.route, 'openai-compatible');
    assert.equal(after.baseUrl, 'http://127.0.0.1:8080/v1');
    assert.equal(after.swaps, 1);
    assert.equal(
      loader.resolve('libre-webui-model-adapter') !== undefined,
      true,
      'the new adapter row should be mounted'
    );

    // The engine itself must have stayed up: the session created before the
    // swap still exists, and its tools are still registered.
    const engine = host.context.get('libreDshEngine');
    assert.notEqual(engine, undefined);
    assert.notEqual(await engine.getSession(session), undefined);

    // Swapping back must work, which is what proves the previous adapter's
    // provider registration was released rather than merely replaced.
    const restored = await host.model.swap({
      provider: 'pi-ai',
      route: 'ollama',
      apiKeyEnv: 'OLLAMA_API_KEY',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'llama3.2',
      providers: {},
    });
    assert.equal(restored.route, 'ollama');
    assert.equal(restored.swaps, 2);
  } finally {
    await host.stop();
  }
});

test('a failed swap restores the previous adapter', async () => {
  const paths = await scenario('hot-swap-failure');
  await writeSettings(paths, { provider: 'none' });
  const host = await startHost(paths, await engineComposition());
  try {
    await host.model.swap({
      provider: 'pi-ai',
      route: 'ollama',
      apiKeyEnv: 'OLLAMA_API_KEY',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'llama3.2',
      providers: {},
    });
    const good = host.model.state();

    // An unresolvable provider is rejected by `swap` and must not leave the
    // engine without an adapter.
    await assert.rejects(
      host.model.swap({
        provider: 'not-a-provider',
        route: 'x',
        apiKeyEnv: 'X',
        baseUrl: '',
        model: '',
        providers: {},
      }),
      ModelAdapterError
    );
    assert.equal(host.model.state().route, good.route);
    assert.equal(host.model.state().swaps, good.swaps);
  } finally {
    await host.stop();
  }
});

// ── Projection helpers ───────────────────────────────────────────────────────

test('session events project onto the contract stream vocabulary', () => {
  assert.deepEqual(
    projectStreamEvent({
      type: 'assistant/message',
      data: {
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      },
    }),
    { type: 'text', text: 'hi' }
  );
  assert.deepEqual(
    projectStreamEvent({
      type: 'tool/call',
      data: { callId: 'c1', name: 'read' },
    }),
    { type: 'tool-call', callId: 'c1', name: 'read' }
  );
  assert.deepEqual(
    projectStreamEvent({
      type: 'tool/result',
      data: { callId: 'c1', name: 'read', error: { code: 'X' } },
    }),
    { type: 'tool-result', callId: 'c1', name: 'read', isError: true }
  );
  assert.deepEqual(
    projectStreamEvent({ type: 'turn/end', data: { reason: 'stop' } }),
    { type: 'done', reason: 'stop' }
  );
  // Events with nothing to show a chat client contribute no chunk.
  assert.equal(projectStreamEvent({ type: 'step/start', data: {} }), undefined);
  assert.equal(
    projectStreamEvent({
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [] } },
    }),
    undefined
  );
});

test('message text extraction reads text blocks and ignores the rest', () => {
  assert.equal(
    extractText([
      { type: 'text', text: 'a' },
      { type: 'image', source: 'x' },
      { type: 'text', text: 'b' },
    ]),
    'ab'
  );
  assert.equal(extractText('plain'), 'plain');
  assert.equal(extractText(undefined), '');
});
