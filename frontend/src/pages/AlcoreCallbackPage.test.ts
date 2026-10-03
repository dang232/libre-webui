/*
 * Alcore
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

/**
 * Page-level contract for the `/auth/alcore/callback` decision.
 *
 * The component's effect hands the query string to `completeCanonicalCallback`
 * and renders one generic message for every rejection; effects never run under
 * SSR, so a render test cannot reach the decision. This suite drives that same
 * function directly through the two seams it already exposes: the injected
 * `exchange` transport and the `now` bound into `consumeState`. The state
 * machine itself is the real `consumeHandoffState` against an in-memory
 * Storage — never a mock — and the clock is an explicitly injected timestamp,
 * never a faked timer, so the TTL arithmetic stays load-bearing.
 *
 * Two properties are pinned here:
 *   1. Ordering: state is validated before the code is inspected, and only
 *      then may the transport run — a mismatch produces zero exchange
 *      invocations.
 *   2. Opaque surface: every rejection is exactly `{ ok: false, reason }`.
 *      The page maps that shape to its single user message, so a leak (a code
 *      echo, storage contents, an upstream error) would both fail
 *      `assertOpaqueFailure` and turn the outcome into an oracle.
 *
 * The React component itself stays exercised by the Playwright specs; this
 * file pins the decision behind it under plain Node with no DOM harness.
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
  completeCanonicalCallback,
  consumeHandoffState,
  HANDSOFF_STATE_TTL_MS,
  rememberHandoffState,
} = await import('../utils/canonicalHandoff.ts');

/** Minimal in-memory Storage stand-in; one instance per simulated tab. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/**
 * `consumeState` over a freshly seeded one-shot tab: the real state machine at
 * an explicitly injected clock, so expiry is proven with arithmetic rather
 * than with a faked timer.
 */
const seededTab =
  (storedState: string, at: number, now = at + 100) =>
  (received: string | null) => {
    const storage = fakeStorage();
    rememberHandoffState(storedState, storage, at);
    return consumeHandoffState(received, storage, now);
  };

/**
 * Every rejection the page receives is exactly `{ ok: false, reason }` — one
 * opaque surface it maps to a single user message, so the outcome never
 * distinguishes "no session was started" from "someone tampered". The explicit
 * key comparison fails loudly if upstream detail ever leaks an extra field in.
 */
function assertOpaqueFailure(
  outcome: { readonly ok: boolean; readonly reason?: string },
  reason: string
): void {
  assert.equal(outcome.ok, false);
  assert.deepEqual(Object.keys(outcome).sort(), ['ok', 'reason']);
  assert.equal(outcome.reason, reason);
}

describe('AlcoreCallbackPage callback decision tree', () => {
  const ORIGIN = 'https://web.alcore.io.vn';
  const STARTED_AT = 1_000;
  const WITHIN_TTL = STARTED_AT + 100;
  const calls: Array<[string, string, string]> = [];

  /** Injected transport: records every invocation instead of hitting a BFF. */
  const exchange = async (code: string, redirectUri: string, state: string) => {
    calls.push([code, redirectUri, state]);
    return { success: true };
  };

  beforeEach(() => {
    calls.length = 0;
  });

  it('callback success', async () => {
    const outcome = await completeCanonicalCallback(
      {
        code: 'code-ok',
        state: 'st-ok',
        origin: ORIGIN,
        consumeState: seededTab('st-ok', STARTED_AT, WITHIN_TTL),
      },
      exchange
    );
    assert.deepEqual(outcome, { ok: true, data: { success: true } });
    // Both gates passed, so the transport ran exactly once, with the exact
    // registered redirect URI and the state Auth echoed back.
    assert.deepEqual(calls, [
      ['code-ok', `${ORIGIN}/auth/alcore/callback`, 'st-ok'],
    ]);
  });

  it('callback state mismatch', async () => {
    // Ordering, first half: state is judged before the code is inspected, so
    // a forged state reports state_mismatch even with the code absent — had
    // the code gate run first, this would have said missing_code.
    const noCode = await completeCanonicalCallback(
      {
        code: null,
        state: 'st-forged',
        origin: ORIGIN,
        consumeState: seededTab('st-real', STARTED_AT, WITHIN_TTL),
      },
      exchange
    );
    assertOpaqueFailure(noCode, 'state_mismatch');

    // Ordering, second half: even with a perfectly valid code, a forged state
    // must never reach the network.
    const withCode = await completeCanonicalCallback(
      {
        code: 'code-1',
        state: 'st-forged',
        origin: ORIGIN,
        consumeState: seededTab('st-real', STARTED_AT, WITHIN_TTL),
      },
      exchange
    );
    assertOpaqueFailure(withCode, 'state_mismatch');
    assert.equal(calls.length, 0, 'exchange must not be called');
  });

  it('callback state expiration', async () => {
    // Real arithmetic, not a faked timer: the injected clock sits exactly one
    // millisecond past HANDSOFF_STATE_TTL_MS, so the TTL branch carries the
    // assertion instead of a vacuous always-past clock.
    const late = STARTED_AT + HANDSOFF_STATE_TTL_MS + 1;
    const outcome = await completeCanonicalCallback(
      {
        code: 'code-1',
        state: 'st-old',
        origin: ORIGIN,
        consumeState: seededTab('st-old', STARTED_AT, late),
      },
      exchange
    );
    assertOpaqueFailure(outcome, 'state_expired');
    assert.equal(calls.length, 0, 'exchange must not be called');
  });

  it('callback missing code', async () => {
    // Ordering, final gap: state passes, so the code gate is reached — and it
    // must stop before the network for both an absent and an empty code.
    for (const code of [null, '']) {
      const outcome = await completeCanonicalCallback(
        {
          code,
          state: 'st-ok',
          origin: ORIGIN,
          consumeState: seededTab('st-ok', STARTED_AT, WITHIN_TTL),
        },
        exchange
      );
      assertOpaqueFailure(outcome, 'missing_code');
    }
    assert.equal(calls.length, 0, 'exchange must not be called');
  });

  it('callback replay', async () => {
    // One tab, one storage: the same callback URL delivered twice.
    const storage = fakeStorage();
    rememberHandoffState('st-once', storage, STARTED_AT);
    const consumeState = (received: string | null) =>
      consumeHandoffState(received, storage, WITHIN_TTL);

    const first = await completeCanonicalCallback(
      { code: 'code-1', state: 'st-once', origin: ORIGIN, consumeState },
      exchange
    );
    assert.deepEqual(first, { ok: true, data: { success: true } });
    assert.equal(calls.length, 1);

    // The stored entry was consumed on first use, so the second delivery is
    // rejected at the state gate and adds no transport call.
    const replayed = await completeCanonicalCallback(
      { code: 'code-1', state: 'st-once', origin: ORIGIN, consumeState },
      exchange
    );
    assertOpaqueFailure(replayed, 'state_mismatch');
    assert.equal(calls.length, 1, 'replayed callback must not reach exchange');
  });
});
