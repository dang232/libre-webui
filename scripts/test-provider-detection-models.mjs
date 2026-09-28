/*
 * Alcore
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

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import express from 'express';

const repoRoot = path.resolve(import.meta.dirname, '..');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-prov-models-'));
const pluginsDir = path.join(dataDir, 'plugins');
fs.mkdirSync(pluginsDir, { recursive: true });
process.env.DATA_DIR = dataDir;
process.env.PLUGINS_DIR = pluginsDir;
process.env.JWT_SECRET = 'provider-models-test-secret';
process.env.ENCRYPTION_KEY ||= '6a'.repeat(32);
const originalWorkingDirectory = process.cwd();
process.chdir(dataDir);

const distModule = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );

const { encryptionService } = await distModule('services/encryptionService.js');
const coordinationModule = await distModule('platform/coordination/service.js');
await coordinationModule.initializeCoordinator();
const persistenceModule = await distModule('persistence/index.js');
const persistence = await persistenceModule.initializePersistence({
  dialect: 'sqlite',
  emailCodec: encryptionService,
  env: process.env,
});
const [
  { authService },
  adminProvidersModule,
  capabilitiesModule,
  pluginServiceModule,
] = await Promise.all([
  distModule('services/authService.js'),
  distModule('routes/adminProviders.js'),
  distModule('services/providerCapabilities.js'),
  distModule('services/pluginService.js'),
]);
const adminProvidersRouter = adminProvidersModule.default;
const pluginService = pluginServiceModule.default;
const {
  deriveProviderHealth,
  diffDisappearedModels,
  getProviderSync,
  normalizeListingEntry,
  normalizeStoredCatalog,
  orderModelCandidates,
  recordProviderSync,
  HEALTH_ERROR_RATE_DEGRADED,
} = capabilitiesModule;

const now = Date.now();
const userRecords = [
  { id: 'prov-models-user', username: 'prov-models-user', role: 'user' },
  { id: 'prov-models-admin', username: 'prov-models-admin', role: 'admin' },
];
for (const user of userRecords) {
  await persistence.repositories.identity.insert({
    ...user,
    email: null,
    password_hash: 'unused',
    account_status: 'active',
    approved_at: now,
    approved_by: null,
    avatar: null,
    created_at: now,
    updated_at: now,
  });
}

const tokenFor = user =>
  authService.generateToken({
    id: user.id,
    username: user.username,
    email: null,
    role: user.role,
    status: 'active',
    approvedAt: new Date(now).toISOString(),
    approvedBy: null,
    avatar: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
const userToken = tokenFor(userRecords[0]);
const adminToken = tokenFor(userRecords[1]);
const adminId = userRecords[1].id;

// A stand-in provider whose catalog the tests rewrite between syncs,
// the way a real provider adds and retires models over time.
const providerState = {
  entries: [
    {
      id: 'model-a',
      context_length: 128000,
      supported_parameters: ['reasoning', 'tools', 'response_format'],
      max_output_tokens: 8192,
    },
  ],
};
const providerServer = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: providerState.entries }));
    return;
  }
  response.statusCode = 404;
  response.end();
});
await new Promise((resolve, reject) => {
  providerServer.once('error', reject);
  providerServer.listen(0, '127.0.0.1', resolve);
});
const providerAddress = providerServer.address();
if (!providerAddress || typeof providerAddress === 'string') {
  throw new Error('Provider fixture has no TCP address');
}
const providerBase = `http://127.0.0.1:${providerAddress.port}`;

const installFixture = (id, endpoint) =>
  pluginService.installPlugin(
    {
      id,
      name: `Provider ${id}`,
      type: 'completion',
      endpoint,
      auth: { header: '', prefix: '', key_env: '' },
      model_map: ['bundled-stale-model'],
    },
    adminId
  );

await installFixture('sync-provider', `${providerBase}/v1/chat/completions`);
await installFixture('idle-provider', 'http://127.0.0.1:9/v1/chat/completions');

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use('/admin/providers', adminProvidersRouter);
const server = createServer(app);
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('Admin providers route test server has no TCP address');
}
const baseUrl = `http://127.0.0.1:${address.port}/admin/providers`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => providerServer.close(resolve));
  await coordinationModule.closeCoordinator();
  await persistenceModule.closePersistence();
  process.chdir(originalWorkingDirectory);
  await rm(dataDir, { recursive: true, force: true });
});

let clientSeq = 0;
const nextIp = () => `10.210.0.${(clientSeq++ % 200) + 1}`;
const request = (method, subpath, options = {}) =>
  fetch(`${baseUrl}${subpath}`, {
    method,
    headers: {
      ...(options.body !== undefined
        ? { 'Content-Type': 'application/json' }
        : {}),
      'X-Forwarded-For': options.ip ?? nextIp(),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });

test('provider capabilities normalize listings without inventing unknowns', () => {
  const full = normalizeListingEntry({
    id: 'model-a',
    context_length: 128000,
    supported_parameters: ['reasoning', 'tools', 'response_format'],
    max_output_tokens: 8192,
  });
  assert.ok(full);
  assert.equal(full.id, 'model-a');
  assert.equal(full.capabilities.reasoning, true);
  assert.equal(full.capabilities.tools, true);
  assert.equal(full.capabilities.structuredOutput, true);
  assert.equal(full.capabilities.chat, 'unknown');
  assert.equal(full.capabilities.streaming, 'unknown');
  assert.equal(full.capabilities.vision, 'unknown');
  assert.equal(full.capabilities.audioInput, 'unknown');
  assert.equal(full.capabilities.audioOutput, 'unknown');
  assert.equal(full.limits.contextWindow, 128000);
  assert.equal(full.limits.maxOutputTokens, 8192);

  // A bare identifier carries no capability evidence at all.
  const partial = normalizeListingEntry({ id: 'model-b' });
  assert.ok(partial);
  assert.deepEqual(Object.values(partial.capabilities), [
    'unknown',
    'unknown',
    'unknown',
    'unknown',
    'unknown',
    'unknown',
    'unknown',
    'unknown',
    'unknown',
  ]);
  assert.deepEqual(partial.limits, {});

  // Malformed entries are dropped, never normalized into guesses.
  for (const malformed of [null, undefined, 42, 'model-a', [], {}]) {
    assert.equal(normalizeListingEntry(malformed), null);
  }
  assert.equal(normalizeListingEntry({ id: 42 }), null);

  // Ollama-style entries map their capability tokens; a missing
  // capabilities array stays unknown rather than becoming false.
  const ollama = normalizeListingEntry({
    name: 'llama-vision',
    capabilities: ['vision', 'tools', 'thinking'],
  });
  assert.ok(ollama);
  assert.equal(ollama.id, 'llama-vision');
  assert.equal(ollama.capabilities.vision, true);
  assert.equal(ollama.capabilities.tools, true);
  assert.equal(ollama.capabilities.reasoning, true);
  assert.equal(ollama.capabilities.chat, 'unknown');
  const bare = normalizeListingEntry({ name: 'llama-bare' });
  assert.ok(bare);
  assert.equal(bare.capabilities.vision, 'unknown');

  // Stored catalogs apply the persisted maps and dedupe identifiers.
  const stored = normalizeStoredCatalog(
    ['model-a', 'model-a', 'model-b', 42, ''],
    { 'model-a': 64000 },
    { 'model-a': false }
  );
  assert.deepEqual(
    stored.map(model => model.id),
    ['model-a', 'model-b']
  );
  assert.equal(stored[0].limits.contextWindow, 64000);
  assert.equal(stored[0].capabilities.reasoning, false);
  assert.equal(stored[1].capabilities.reasoning, 'unknown');
});

test('provider health derives from telemetry and orders resolver candidates', () => {
  assert.deepEqual(deriveProviderHealth({ active: false }), {
    status: 'disabled',
    details: ['plugin is not active'],
  });
  assert.equal(
    deriveProviderHealth({
      active: true,
      lastOutcome: 'unavailable',
      lastReason: 'Could not reach the provider',
    }).status,
    'unavailable'
  );
  assert.equal(
    deriveProviderHealth({
      active: true,
      lastReason: 'The provider responded with HTTP 429',
    }).status,
    'rate_limited'
  );
  // The error share must reach HEALTH_ERROR_RATE_DEGRADED before a
  // reachable provider reads as degraded.
  assert.equal(
    deriveProviderHealth({
      active: true,
      usage: { calls: 10, errors: 1, averageLatencyMs: 200 },
    }).status,
    'healthy'
  );
  const degraded = deriveProviderHealth({
    active: true,
    usage: { calls: 10, errors: 4, averageLatencyMs: 200 },
  });
  assert.equal(degraded.status, 'degraded');
  assert.ok(
    degraded.details[0].includes(String(HEALTH_ERROR_RATE_DEGRADED))
  );
  // Sparse usage never moves health on its own.
  assert.equal(
    deriveProviderHealth({
      active: true,
      usage: { calls: 2, errors: 2, averageLatencyMs: 200 },
    }).status,
    'healthy'
  );
  // Latency only counts against an explicit caller baseline.
  assert.equal(
    deriveProviderHealth({
      active: true,
      usage: { calls: 20, errors: 0, averageLatencyMs: 900 },
      baselineMs: 200,
    }).status,
    'degraded'
  );
  assert.equal(
    deriveProviderHealth({
      active: true,
      usage: { calls: 20, errors: 0, averageLatencyMs: 900 },
    }).status,
    'healthy'
  );

  assert.deepEqual(diffDisappearedModels(['a', 'b'], ['b', 'c']), ['a']);
  assert.deepEqual(diffDisappearedModels(['a'], ['a']), []);

  recordProviderSync('fixture-provider', 'updated');
  assert.equal(getProviderSync('fixture-provider')?.outcome, 'updated');
  assert.equal(getProviderSync('unknown-provider'), undefined);

  const ordered = orderModelCandidates('shared-model', [
    { pluginId: 'slow', models: ['shared-model'], health: 'unavailable' },
    { pluginId: 'flaky', models: ['shared-model'], health: 'degraded' },
    { pluginId: 'steady', models: ['shared-model'], health: 'healthy' },
    { pluginId: 'other', models: ['other-model'], health: 'healthy' },
  ]);
  assert.deepEqual(
    ordered.map(candidate => candidate.pluginId),
    ['steady', 'flaky', 'slow']
  );
  assert.deepEqual(orderModelCandidates('  ', []), []);
});

test('admin providers list reports derived health without secrets', async () => {
  const unauthenticated = await request('GET', '/');
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), {
    success: false,
    message: 'No authorization token provided',
  });

  const forbidden = await request('GET', '/', { token: userToken });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), {
    success: false,
    message: 'Admin access required',
  });

  const response = await request('GET', '/', { token: adminToken });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.data.providers));
  const byId = new Map(
    body.data.providers.map(provider => [provider.id, provider])
  );
  const synced = byId.get('sync-provider');
  assert.ok(synced);
  assert.equal(synced.active, false);
  assert.equal(synced.available, true);
  assert.equal(synced.health, 'disabled');
  assert.ok(Array.isArray(synced.healthDetails));
  assert.equal(synced.lastSync, null);
  const idle = byId.get('idle-provider');
  assert.ok(idle);
  assert.equal(idle.active, false);
  assert.equal(idle.health, 'disabled');
  assert.equal(idle.lastSync, null);
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('apiKey'));
  assert.ok(!serialized.includes('Bearer'));
});

test('admin provider sync reuses discovery and marks disappeared models', async () => {
  const missing = await request('GET', '/missing-provider/models', {
    token: adminToken,
  });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).reason, 'provider_not_found');

  const before = await request('GET', '/sync-provider/models', {
    token: adminToken,
  });
  assert.equal(before.status, 200);
  const beforeBody = await before.json();
  assert.deepEqual(
    beforeBody.data.models.map(model => model.id),
    ['bundled-stale-model']
  );
  assert.equal(
    beforeBody.data.models[0].capabilities.reasoning,
    'unknown'
  );

  const first = await request('POST', '/sync-provider/sync-models', {
    token: adminToken,
    body: {},
  });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.data.outcome, 'updated');
  assert.deepEqual(
    firstBody.data.models.map(model => model.id),
    ['model-a']
  );
  assert.equal(firstBody.data.models[0].limits.contextWindow, 128000);
  assert.equal(firstBody.data.models[0].capabilities.reasoning, true);
  assert.deepEqual(firstBody.data.unavailableMarked, [
    'bundled-stale-model',
  ]);

  // The same catalog twice is unchanged and stores no duplicates.
  const second = await request('POST', '/sync-provider/sync-models', {
    token: adminToken,
    body: {},
  });
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.data.outcome, 'unchanged');
  assert.deepEqual(secondBody.data.unavailableMarked, []);

  // A retired model is named, never deleted by the sync itself.
  providerState.entries = [{ id: 'model-b' }];
  const third = await request('POST', '/sync-provider/sync-models', {
    token: adminToken,
    body: {},
  });
  assert.equal(third.status, 200);
  const thirdBody = await third.json();
  assert.equal(thirdBody.data.outcome, 'updated');
  assert.deepEqual(
    thirdBody.data.models.map(model => model.id),
    ['model-b']
  );
  assert.deepEqual(thirdBody.data.unavailableMarked, ['model-a']);

  const listed = await request('GET', '/', { token: adminToken });
  const listedBody = await listed.json();
  const synced = listedBody.data.providers.find(
    provider => provider.id === 'sync-provider'
  );
  assert.equal(synced.health, 'disabled');
  assert.equal(synced.lastSync.outcome, 'updated');

  // Activation flips derived health without another sync: the stored
  // catalog is already current, so activation discovers 'unchanged'.
  await pluginService.activatePlugin('sync-provider', adminId);
  const relisted = await request('GET', '/', { token: adminToken });
  const relistedBody = await relisted.json();
  const active = relistedBody.data.providers.find(
    provider => provider.id === 'sync-provider'
  );
  assert.equal(active.active, true);
  assert.equal(active.health, 'healthy');
  assert.equal(active.lastSync.outcome, 'updated');

  const serialized = JSON.stringify(thirdBody);
  assert.ok(!serialized.includes('apiKey'));
});
