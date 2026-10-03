/*
 * Alcore
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

/**
 * The handoff's security property is that a callback can only be completed by
 * the same browser tab that started it. That rests entirely on `state`, so the
 * cases below cover both directions: a genuine callback succeeds, and every
 * shape of forged or stale callback fails closed.
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Self-register the env shim that test:unit preloads via --import: sharing the
// state key pulls authApi, which reads `import.meta.env` unguarded at module
// scope and throws under a bare `node --import tsx --test` run. ESM caching
// makes the double registration under test:unit a no-op.
import '../../test/shimImportMetaEnv.mjs';

// The handoff module shares its state key with the sign-in panel, whose
// import chain reads window/localStorage at module load (config, stores).
// Stub the browser surface first, then import dynamically so the stubs are
// already in place — the same harness the sign-in panel test uses.
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
// zustand persist middleware writes through bare localStorage at store
// creation; an in-memory map keeps the server-render harness hermetic.
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
const stubStyle = () => {
  const element: Record<string, unknown> = {
    innerHTML: ' ',
    id: '_goober',
    parentNode: null,
    firstChild: null,
    data: '',
  };
  element.firstChild = element;
  return element;
};
(globalThis as unknown as { document: unknown }).document = {
  createElement: stubStyle,
  querySelector: () => null,
  head: { appendChild: (element: unknown) => element },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  documentElement: {
    lang: '',
    dataset: {},
    style: {
      setProperty: () => undefined,
      removeProperty: () => undefined,
    },
    classList: { add: () => undefined, remove: () => undefined },
    removeAttribute: () => undefined,
    setAttribute: () => undefined,
  },
};

const {
  buildAuthRedirectUrl,
  canonicalCallbackUrl,
  completeCanonicalCallback,
  consumeHandoffState,
  generateState,
  HANDSOFF_STATE_TTL_MS,
  rememberHandoffState,
} = await import('./canonicalHandoff.ts');
const { ALCORE_AUTH_STATE_KEY } = await import('@/components/AlcoreAuthNotice');

/** Minimal in-memory Storage stand-in. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    raw: map,
  };
}

describe('canonical handoff state', () => {
  it('generates 256 bits of hex state', () => {
    const state = generateState();
    assert.equal(state.length, 64);
    assert.match(state, /^[0-9a-f]{64}$/);
  });

  it('generates a distinct state per invocation', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateState()));
    assert.equal(seen.size, 50);
  });

  it('refuses to fall back to insecure randomness', () => {
    assert.throws(() => generateState({}), /secure random unavailable/);
  });

  it('accepts a matching state and consumes it', () => {
    const storage = fakeStorage();
    rememberHandoffState('st-good', storage, 1_000);
    const result = consumeHandoffState('st-good', storage, 1_100);
    assert.equal(result.ok, true);
    assert.equal(result.reason, undefined);
  });

  it('rejects a replayed callback after the state is consumed', () => {
    const storage = fakeStorage();
    rememberHandoffState('st-once', storage, 1_000);
    assert.equal(consumeHandoffState('st-once', storage, 1_100).ok, true);
    const replay = consumeHandoffState('st-once', storage, 1_200);
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, 'state_mismatch');
  });

  it('rejects a missing or empty state', () => {
    const storage = fakeStorage();
    rememberHandoffState('st-x', storage, 1_000);
    assert.equal(
      consumeHandoffState(null, storage, 1_100).reason,
      'missing_state'
    );
    assert.equal(
      consumeHandoffState('', storage, 1_100).reason,
      'missing_state'
    );
  });

  it("rejects an attacker's state when none was stored", () => {
    const storage = fakeStorage();
    assert.equal(
      consumeHandoffState('st-forged', storage, 1_100).reason,
      'state_mismatch'
    );
  });

  it('rejects a forged state when one was stored', () => {
    const storage = fakeStorage();
    rememberHandoffState('st-real', storage, 1_000);
    assert.equal(
      consumeHandoffState('st-forged', storage, 1_100).reason,
      'state_mismatch'
    );
  });

  it('rejects a state older than the browser-side TTL', () => {
    const storage = fakeStorage();
    rememberHandoffState('st-old', storage, 1_000);
    const result = consumeHandoffState(
      'st-old',
      storage,
      1_000 + HANDSOFF_STATE_TTL_MS + 1
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'state_expired');
  });

  it('accepts a state exactly at the TTL boundary', () => {
    const storage = fakeStorage();
    rememberHandoffState('st-edge', storage, 1_000);
    assert.equal(
      consumeHandoffState('st-edge', storage, 1_000 + HANDSOFF_STATE_TTL_MS).ok,
      true
    );
  });

  it('rejects a corrupted stored entry rather than trusting it', () => {
    const storage = fakeStorage();
    storage.setItem(ALCORE_AUTH_STATE_KEY, 'not-json');
    assert.equal(
      consumeHandoffState('st-any', storage, 1_100).reason,
      'state_mismatch'
    );
  });

  it('rejects a stored entry with the wrong shape', () => {
    const storage = fakeStorage();
    storage.setItem(ALCORE_AUTH_STATE_KEY, JSON.stringify({ value: 42 }));
    assert.equal(
      consumeHandoffState('st-any', storage, 1_100).reason,
      'state_mismatch'
    );
  });
});

describe('canonical handoff URLs', () => {
  it('builds the callback URL without a query or fragment', () => {
    assert.equal(
      canonicalCallbackUrl('https://web.alcore.io.vn'),
      'https://web.alcore.io.vn/auth/alcore/callback'
    );
    assert.equal(
      canonicalCallbackUrl('https://web.alcore.io.vn/'),
      'https://web.alcore.io.vn/auth/alcore/callback'
    );
  });

  it('targets the Auth redirect endpoint with audience, redirect_uri and state', () => {
    const url = new URL(
      buildAuthRedirectUrl(
        'https://auth.alcore.io.vn',
        'st-1',
        'https://web.alcore.io.vn/auth/alcore/callback'
      )
    );
    assert.equal(url.origin, 'https://auth.alcore.io.vn');
    assert.equal(url.pathname, '/oidc/exchange/redirect');
    assert.equal(url.searchParams.get('audience'), 'libre');
    assert.equal(
      url.searchParams.get('redirect_uri'),
      'https://web.alcore.io.vn/auth/alcore/callback'
    );
    assert.equal(url.searchParams.get('state'), 'st-1');
  });

  it('tolerates a trailing slash on the Auth base URL', () => {
    const url = new URL(
      buildAuthRedirectUrl(
        'https://auth.alcore.io.vn/',
        'st-2',
        'https://web.alcore.io.vn/auth/alcore/callback'
      )
    );
    assert.equal(url.pathname, '/oidc/exchange/redirect');
  });

  it('escapes a state containing URL-significant characters', () => {
    const hostile = 'a&b=c#d e';
    const url = new URL(
      buildAuthRedirectUrl(
        'https://auth.alcore.io.vn',
        hostile,
        'https://web.alcore.io.vn/auth/alcore/callback'
      )
    );
    assert.equal(url.searchParams.get('state'), hostile);
  });
});

describe('canonical callback completion', () => {
  const ORIGIN = 'https://web.alcore.io.vn';
  const calls: Array<[string, string, string]> = [];
  let exchangeResult: { success: boolean };

  const exchange = async (code: string, redirectUri: string, state: string) => {
    calls.push([code, redirectUri, state]);
    return exchangeResult;
  };

  /** consumeState bound to a storage seeded with `state`. */
  const seeded =
    (state: string, at: number, now = at + 100) =>
    (received: string | null) => {
      const storage = fakeStorage();
      rememberHandoffState(state, storage, at);
      return consumeHandoffState(received, storage, now);
    };

  beforeEach(() => {
    calls.length = 0;
    exchangeResult = { success: true };
  });

  it('redeems the code and reports success when state and code are both valid', async () => {
    const outcome = await completeCanonicalCallback(
      {
        code: 'code-1',
        state: 'st-ok',
        origin: ORIGIN,
        consumeState: seeded('st-ok', 1000),
      },
      exchange
    );
    assert.equal(outcome.ok, true);
    // The success path must hand the exchange payload back so the caller can
    // establish a session from it; it is not enough to report ok.
    assert.deepEqual(outcome.ok && outcome.data, { success: true });
    assert.deepEqual(calls, [
      ['code-1', `${ORIGIN}/auth/alcore/callback`, 'st-ok'],
    ]);
  });

  it('validates state BEFORE redeeming, so a forged callback never reaches the network', async () => {
    const outcome = await completeCanonicalCallback(
      {
        code: 'code-1',
        state: 'st-forged',
        origin: ORIGIN,
        consumeState: seeded('st-real', 1000),
      },
      exchange
    );
    assert.equal(outcome.ok, false);
    assert.equal(calls.length, 0, 'exchange must not be called');
  });

  it('reports missing_code only after state passes', async () => {
    for (const code of [null, '']) {
      const outcome = await completeCanonicalCallback(
        {
          code,
          state: 'st-ok',
          origin: ORIGIN,
          consumeState: seeded('st-ok', 1000),
        },
        exchange
      );
      assert.deepEqual(outcome, { ok: false, reason: 'missing_code' });
    }
    assert.equal(calls.length, 0);
  });

  it('rejects a missing state ahead of any code handling', async () => {
    const outcome = await completeCanonicalCallback(
      {
        code: 'code-1',
        state: null,
        origin: ORIGIN,
        consumeState: seeded('st-ok', 1000),
      },
      exchange
    );
    assert.deepEqual(outcome, { ok: false, reason: 'missing_state' });
    assert.equal(calls.length, 0);
  });

  it('surfaces an expired state distinctly from a mismatch', async () => {
    const outcome = await completeCanonicalCallback(
      {
        code: 'code-1',
        state: 'st-old',
        origin: ORIGIN,
        consumeState: seeded('st-old', 1000, 1000 + HANDSOFF_STATE_TTL_MS + 1),
      },
      exchange
    );
    assert.deepEqual(outcome, { ok: false, reason: 'state_expired' });
    assert.equal(calls.length, 0);
  });

  it('maps a rejected redemption to exchange_failed without leaking upstream detail', async () => {
    exchangeResult = { success: false };
    const outcome = await completeCanonicalCallback(
      {
        code: 'code-1',
        state: 'st-ok',
        origin: ORIGIN,
        consumeState: seeded('st-ok', 1000),
      },
      exchange
    );
    assert.deepEqual(outcome, { ok: false, reason: 'exchange_failed' });
    assert.equal(calls.length, 1);
  });

  it('fails closed when no exchange implementation is supplied', async () => {
    const outcome = await completeCanonicalCallback({
      code: 'code-1',
      state: 'st-ok',
      origin: ORIGIN,
      consumeState: seeded('st-ok', 1000),
    });
    assert.deepEqual(outcome, { ok: false, reason: 'exchange_failed' });
  });

  it('sends the exact registered redirect URI so Auth can match its binding', async () => {
    await completeCanonicalCallback(
      {
        code: 'c',
        state: 'st-ok',
        origin: `${ORIGIN}/`,
        consumeState: seeded('st-ok', 1000),
      },
      exchange
    );
    assert.equal(calls[0]?.[1], `${ORIGIN}/auth/alcore/callback`);
  });
});
