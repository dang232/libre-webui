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

/**
 * R7: the callback auto-retries the S2S exchange exactly once inside the
 * handoff TTL. Same stub harness as canonicalHandoff.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import '../../test/shimImportMetaEnv.mjs';

const stubWindow = {
  location: {
    protocol: 'http:',
    origin: 'http://localhost:5173',
    hostname: 'localhost',
  },
  _goober: undefined,
  __nonce__: undefined,
};
(globalThis as unknown as { window: unknown }).window = stubWindow;
const memStore = new Map<string, string>();
const stubStorage = {
  getItem: (key: string) => memStore.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memStore.set(key, String(value));
  },
  removeItem: (key: string) => {
    memStore.delete(key);
  },
  clear: () => memStore.clear(),
};
(globalThis as unknown as { localStorage: unknown }).localStorage = stubStorage;
(stubWindow as unknown as { localStorage: unknown }).localStorage = stubStorage;
(globalThis as unknown as { document: unknown }).document = {
  createElement: () => ({ innerHTML: ' ', id: '_goober' }),
  querySelector: () => null,
  head: { appendChild: (element: unknown) => element },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  documentElement: {
    lang: '',
    dataset: {},
    style: { setProperty: () => undefined, removeProperty: () => undefined },
    classList: { add: () => undefined, remove: () => undefined },
    removeAttribute: () => undefined,
    setAttribute: () => undefined,
  },
};

const { completeCanonicalCallback, rememberHandoffState } =
  await import('./canonicalHandoff.ts');
const { ALCORE_AUTH_STATE_KEY } = await import('@/components/AlcoreAuthNotice');

const seedState = (state: string): void => {
  memStore.set(
    ALCORE_AUTH_STATE_KEY,
    JSON.stringify({ value: state, createdAt: Date.now() })
  );
};

/** Same-tab binding check against the seeded store (no sessionStorage). */
const fakeConsume = (
  received: string | null
): { ok: boolean; reason?: 'state_mismatch' } => {
  const raw = memStore.get(ALCORE_AUTH_STATE_KEY) ?? null;
  memStore.delete(ALCORE_AUTH_STATE_KEY);
  if (received === null || received === '' || raw === null)
    return { ok: false, reason: 'state_mismatch' };
  const parsed = JSON.parse(raw) as { value?: unknown };
  if (parsed.value !== received) return { ok: false, reason: 'state_mismatch' };
  return { ok: true };
};

describe('R7 single exchange retry', () => {
  it('succeeds when the second attempt succeeds, calling exchange twice', async () => {
    seedState('s1');
    let calls = 0;
    const outcome = await completeCanonicalCallback(
      {
        code: 'code-1',
        state: 's1',
        origin: 'http://localhost:5173',
        consumeState: fakeConsume,
      },
      async () => {
        calls += 1;
        return { success: calls >= 2 };
      },
      { retryExchangeOnce: true }
    );
    assert.equal(outcome.ok, true);
    assert.equal(calls, 2);
  });

  it('reports exchange_failed after two failures, never a third call', async () => {
    seedState('s2');
    let calls = 0;
    const outcome = await completeCanonicalCallback(
      {
        code: 'code-2',
        state: 's2',
        origin: 'http://localhost:5173',
        consumeState: fakeConsume,
      },
      async () => {
        calls += 1;
        return { success: false };
      },
      { retryExchangeOnce: true }
    );
    assert.deepEqual(outcome, { ok: false, reason: 'exchange_failed' });
    assert.equal(calls, 2);
  });

  it('calls exchange exactly once when the option is off', async () => {
    seedState('s3');
    let calls = 0;
    const outcome = await completeCanonicalCallback(
      {
        code: 'code-3',
        state: 's3',
        origin: 'http://localhost:5173',
        consumeState: fakeConsume,
      },
      async () => {
        calls += 1;
        return { success: false };
      }
    );
    assert.deepEqual(outcome, { ok: false, reason: 'exchange_failed' });
    assert.equal(calls, 1);
  });
});
