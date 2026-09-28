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
import test from 'node:test';

// The api client reads browser globals at module load; stub the minimum.
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    location: {
      protocol: 'http:',
      origin: 'http://localhost:5173',
      hostname: 'localhost',
    },
  },
});
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'node-test' },
});
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});

const calls: Array<{ url: string; method: string; headers: unknown }> = [];
globalThis.fetch = (async (
  url: unknown,
  init?: {
    method?: string;
    headers?: unknown;
    body?: string;
  }
) => {
  calls.push({
    url: String(url),
    method: init?.method ?? 'GET',
    headers: init?.headers,
  });
  const body = JSON.stringify({ success: true, data: {} });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

const { tokenpanelKeysApi, tokenpanelProjectsApi } =
  await import('./tokenpanelApi');

test('keys/projects BFF calls carry the session only, never mgmt creds', async () => {
  await tokenpanelKeysApi.list();
  await tokenpanelKeysApi.create({ name: 'n', quotaMicros: 5 });
  await tokenpanelKeysApi.reveal('6532d9f8e8a3b2c1d4e5f607');
  await tokenpanelKeysApi.update('6532d9f8e8a3b2c1d4e5f607', {
    status: 'revoked',
  });
  await tokenpanelKeysApi.revoke('6532d9f8e8a3b2c1d4e5f607');
  await tokenpanelKeysApi.rotate('6532d9f8e8a3b2c1d4e5f607');
  await tokenpanelProjectsApi.list();

  const urls = calls.map(call => `${call.method} ${call.url}`);
  assert.deepEqual(urls, [
    'GET http://localhost:5173/api/tokenpanel/keys?limit=100',
    'POST http://localhost:5173/api/tokenpanel/keys',
    'POST http://localhost:5173/api/tokenpanel/keys/6532d9f8e8a3b2c1d4e5f607/reveal',
    'PATCH http://localhost:5173/api/tokenpanel/keys/6532d9f8e8a3b2c1d4e5f607',
    'DELETE http://localhost:5173/api/tokenpanel/keys/6532d9f8e8a3b2c1d4e5f607',
    'POST http://localhost:5173/api/tokenpanel/keys/6532d9f8e8a3b2c1d4e5f607/rotate',
    'GET http://localhost:5173/api/tokenpanel/projects',
  ]);
  for (const call of calls) {
    assert.ok(
      !JSON.stringify(call.headers ?? {}).includes('tp_mgmt_'),
      'mgmt credential must never leave the browser'
    );
  }
});
