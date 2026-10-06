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

let nextBody: unknown = null;
globalThis.fetch = (async () => {
  const body = JSON.stringify(nextBody);
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

const { tokenpanelUsageApi } = await import('./tokenpanelUsageApi');

test('daily unwraps the upstream days envelope into a bare array', async () => {
  nextBody = {
    success: true,
    data: { days: [{ day: '2026-10-06', requests: 1 }] },
  };
  const result = await tokenpanelUsageApi.daily();
  assert.equal(result.success, true);
  assert.deepEqual(result.data, [{ day: '2026-10-06', requests: 1 }]);
});

test('records unwraps the upstream items envelope into a bare array', async () => {
  nextBody = {
    success: true,
    data: { items: [{ id: 'r1' }] },
  };
  const result = await tokenpanelUsageApi.records();
  assert.equal(result.success, true);
  assert.deepEqual(result.data, [{ id: 'r1' }]);
});

test('bare arrays still pass through untouched', async () => {
  nextBody = { success: true, data: [{ day: '2026-10-06' }] };
  const result = await tokenpanelUsageApi.daily();
  assert.deepEqual(result.data, [{ day: '2026-10-06' }]);
});

test('unknown shapes pass through so the panel still fails loud', async () => {
  nextBody = { success: true, data: { unexpected: true } };
  const result = await tokenpanelUsageApi.daily();
  assert.deepEqual(result.data, { unexpected: true });
});

test('failure envelopes pass through with success false', async () => {
  nextBody = { success: false, error: 'daily failed' };
  const result = await tokenpanelUsageApi.daily();
  assert.equal(result.success, false);
});
