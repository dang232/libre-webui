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
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import express from 'express';

const repoRoot = path.resolve(import.meta.dirname, '..');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-admin-prov-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'admin-providers-route-test-secret';
process.env.ENCRYPTION_KEY ||= '6a'.repeat(32);

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
const [{ authService }, adminProvidersModule] = await Promise.all([
  distModule('services/authService.js'),
  distModule('routes/adminProviders.js'),
]);
const adminProvidersRouter = adminProvidersModule.default;
const { parseCredentialBody, checkProviderEgress } = adminProvidersModule;

const now = Date.now();
const userRecords = [
  { id: 'admin-prov-user', username: 'admin-prov-user', role: 'user' },
  { id: 'admin-prov-admin', username: 'admin-prov-admin', role: 'admin' },
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

const app = express();
// The test harness pins a distinct client per request via X-Forwarded-For
// so rate-limit accounting stays deterministic across tests.
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
  await coordinationModule.closeCoordinator();
  await persistenceModule.closePersistence();
  await rm(dataDir, { recursive: true, force: true });
});

let clientSeq = 0;
const post = (subpath, body, options = {}) => {
  const clientIp = options.ip ?? `10.200.0.${(clientSeq++ % 200) + 1}`;
  return fetch(`${baseUrl}${subpath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': clientIp,
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
};

test('admin provider routes reject callers without administrator rights', async () => {
  const unauthenticated = await post('/detect', {
    baseUrl: 'https://alcore.io.vn/v1',
  });
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), {
    success: false,
    message: 'No authorization token provided',
  });

  const forbidden = await post(
    '/detect',
    { baseUrl: 'https://alcore.io.vn/v1' },
    { token: userToken }
  );
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), {
    success: false,
    message: 'Admin access required',
  });

  const adminEmpty = await post('/detect', {}, { token: adminToken });
  assert.equal(adminEmpty.status, 400);
});

test('admin provider detect reports no vendor candidate without a credential', async () => {
  const response = await post(
    '/detect',
    { baseUrl: 'https://alcore.io.vn/v1' },
    { token: adminToken }
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.deepEqual(body.data.candidates, []);
  assert.equal(body.data.resolved, undefined);
  assert.ok(!JSON.stringify(body).includes('sk-'));
});

test('admin provider validate refuses unsafe targets and redacts secrets', async () => {
  const metadata = await post(
    '/validate',
    { baseUrl: 'http://169.254.169.254/' },
    { token: adminToken }
  );
  assert.equal(metadata.status, 400);
  assert.equal((await metadata.json()).reason, 'private_network_blocked');

  const loopback = await post(
    '/validate',
    { baseUrl: 'http://localhost:8080/v1' },
    { token: adminToken }
  );
  assert.equal(loopback.status, 400);
  assert.equal((await loopback.json()).reason, 'private_network_blocked');

  const fakeKey = 'sk-admin-test-abcdef123456';
  process.env.ALLOW_PRIVATE_PROVIDER_ENDPOINTS = 'true';
  try {
    const refused = await post(
      '/validate',
      { apiKey: fakeKey, baseUrl: 'http://127.0.0.1:9' },
      { token: adminToken }
    );
    assert.equal(refused.status, 200);
    const refusedBody = await refused.json();
    assert.equal(refusedBody.data.status, 'unreachable');
    assert.equal(refusedBody.data.reason, 'host_unreachable');
    assert.ok(!JSON.stringify(refusedBody).includes(fakeKey));
    assert.ok(!JSON.stringify(refusedBody).includes('abcdef123456'));
  } finally {
    delete process.env.ALLOW_PRIVATE_PROVIDER_ENDPOINTS;
  }

  const malformed = await post(
    '/validate',
    { baseUrl: 'not a url' },
    { token: adminToken }
  );
  assert.equal(malformed.status, 400);
});

test('admin provider inputs are bounded before any outbound call', async () => {
  const empty = await post('/detect', {}, { token: adminToken });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).reason, 'missing_credential');

  const scheme = await post(
    '/detect',
    { baseUrl: 'ftp://files.example.com/v1' },
    { token: adminToken }
  );
  assert.equal(scheme.status, 400);
  assert.equal((await scheme.json()).reason, 'unsupported_protocol');

  const oversized = await post(
    '/detect',
    { apiKey: 'x'.repeat(2001) },
    { token: adminToken }
  );
  assert.equal(oversized.status, 400);
  assert.equal((await oversized.json()).reason, 'api_key_too_long');

  const headers = {};
  for (let index = 0; index < 11; index += 1) {
    headers[`x-test-${index}`] = 'v';
  }
  const crowded = await post(
    '/detect',
    { baseUrl: 'https://alcore.io.vn/v1', headers },
    { token: adminToken }
  );
  assert.equal(crowded.status, 400);
  assert.equal((await crowded.json()).reason, 'too_many_headers');
});

test('admin provider validation throttles repeated callers', async () => {
  const sharedIp = '10.99.0.7';
  const burst = [];
  for (let index = 0; index < 11; index += 1) {
    burst.push(
      await post('/validate', {}, { token: adminToken, ip: sharedIp })
    );
  }
  for (const response of burst.slice(0, 10)) {
    assert.equal(response.status, 400);
  }
  assert.equal(burst[10].status, 429);
  assert.ok(burst[10].headers.get('Retry-After'));
});

test('provider credential parsing drops sensitive headers', async () => {
  const parsed = parseCredentialBody(
    {
      baseUrl: 'https://alcore.io.vn/v1',
      headers: {
        Authorization: 'Bearer dropped',
        Cookie: 'session=dropped',
        'X-Custom': 'kept',
      },
    },
    { allowProviderId: false }
  );
  assert.deepEqual(parsed.input.headers, { 'X-Custom': 'kept' });

  const crowded = {};
  for (let index = 0; index < 11; index += 1) {
    crowded[`x-test-${index}`] = 'v';
  }
  try {
    parseCredentialBody(
      { apiKey: 'k', headers: crowded },
      { allowProviderId: false }
    );
    assert.fail('expected too_many_headers');
  } catch (error) {
    assert.equal(error.reason, 'too_many_headers');
  }

  // IP literals classify without DNS, so these assertions send no packets.
  assert.deepEqual(await checkProviderEgress('http://10.0.0.5/v1'), {
    allowed: false,
    reason: 'private_network_blocked',
  });
  assert.deepEqual(await checkProviderEgress('https://93.184.216.1/v1'), {
    allowed: true,
  });
  const embedded = await checkProviderEgress(
    'https://user:pass@93.184.216.1/v1'
  );
  assert.equal(embedded.reason, 'credentials_in_url');
});
