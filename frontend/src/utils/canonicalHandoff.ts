/*
 * Alcore
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

/**
 * Browser handoff to Auth (Repo C).
 *
 * Flow: the browser holds no Auth credentials at any point. It generates a CSRF
 * `state`, sends the user to Auth, Auth authenticates with its own HttpOnly
 * cookie and redirects back with a single-use code, and only then does the
 * browser present that code to the Libre backend. No session or access token is
 * ever readable by, or passes through, JavaScript.
 *
 * `state` is the CSRF binding: an attacker who can make the browser visit the
 * callback with their own code cannot produce a matching state, so the login
 * they attempt is rejected. It is kept in sessionStorage (same tab, cleared when
 * the tab closes) and consumed on first use so a replayed callback URL fails.
 *
 * Deliberately free of browser globals and of `@/utils/config`: this module is
 * imported by unit tests under plain Node, where touching `window` at module
 * scope throws. Callers pass the Auth base URL and the origin in.
 *
 * The state key is shared, not redeclared: it lives in the import-free leaf
 * `@/utils/handoffStateKey` and both this module and the sign-in panel
 * re-export that same binding, so there is exactly one state key in the
 * product and no component↔state-machine import cycle (the cycle made the
 * production bundle crash at boot — task-8-e2e evidence). Unit tests still
 * stub the browser globals before importing, exactly as the sign-in panel
 * test does.
 */

import { ALCORE_AUTH_STATE_KEY } from '@/utils/handoffStateKey';

export { ALCORE_AUTH_STATE_KEY };

/** Must match the registered redirect URI on the Auth side, character for character. */
export const CANONICAL_CALLBACK_PATH = '/auth/alcore/callback';

/** Where the user lands after a successful exchange. */
export const POST_LOGIN_PATH = '/';

/**
 * Browser-side replay window for a started handoff. Auth's single-use code
 * TTL (60s) stays the tighter server-side constraint regardless; this window
 * only bounds how long a captured callback URL remains redeemable from the
 * tab that started it, so it is kept short.
 */
export const HANDSOFF_STATE_TTL_MS = 5 * 60 * 1000;

interface StoredState {
  readonly value: string;
  readonly createdAt: number;
}

/**
 * Cutover switch for the Auth browser handoff.
 *
 * Defaults OFF: while it is off the legacy local password form is the only way
 * in, so enabling this cannot strand a Libre user that has no
 * `canonical_user_id` yet. Flip it only after the migration census shows the
 * population is mapped or deliberately flagged.
 *
 * Lives here rather than beside the button so that component module exports only
 * components; a component file that also exports a plain function disables React
 * Fast Refresh for everything in it.
 */
export function isAuthBrowserHandoffEnabled(): boolean {
  return import.meta.env?.VITE_AUTH_BROWSER_HANDOFF === 'true';
}

/** Web Crypto randomness; fails closed rather than falling back to Math.random. */
export function generateState(randomSource?: {
  getRandomValues?: (a: Uint8Array) => Uint8Array;
}): string {
  const source =
    randomSource ??
    (globalThis.crypto as
      { getRandomValues?: (a: Uint8Array) => Uint8Array } | undefined);
  if (!source?.getRandomValues) {
    throw new Error('secure random unavailable');
  }
  const bytes = new Uint8Array(32);
  source.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function canonicalCallbackUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${CANONICAL_CALLBACK_PATH}`;
}

/**
 * Builds the Auth redirect URL that starts the handoff. The caller must have
 * already persisted `state` via `rememberHandoffState`.
 */
export function buildAuthRedirectUrl(
  authBaseUrl: string,
  state: string,
  redirectUri: string
): string {
  const query = new URLSearchParams({
    audience: 'libre',
    redirect_uri: redirectUri,
    state,
  });
  return `${authBaseUrl.replace(/\/+$/, '')}/oidc/exchange/redirect?${query.toString()}`;
}

export function buildGoogleStartUrl(
  authBaseUrl: string,
  audience: string,
  redirectUri: string,
  state: string
): string {
  const query = new URLSearchParams({
    audience,
    redirect_uri: redirectUri,
    state,
  });
  return `${authBaseUrl.replace(/\/+$/, '')}/auth/google/start?${query.toString()}`;
}

export function rememberHandoffState(
  state: string,
  storage: Pick<Storage, 'setItem'> & { now?: () => number } = sessionStorage,
  now: number = Date.now()
): void {
  const entry: StoredState = { value: state, createdAt: now };
  storage.setItem(ALCORE_AUTH_STATE_KEY, JSON.stringify(entry));
}

export type StateRejection =
  'missing_state' | 'state_mismatch' | 'state_expired' | 'missing_code';

export interface StateCheck {
  readonly ok: boolean;
  readonly reason?: StateRejection;
}

/**
 * Consumes the stored state and compares it with the one Auth echoed back.
 *
 * The stored entry is removed before the comparison result is returned, so a
 * second callback in the same tab cannot reuse it. An expired entry is treated
 * exactly like a mismatch: there is no legitimate flow that returns late.
 */
export function consumeHandoffState(
  received: string | null,
  storage: Pick<Storage, 'getItem' | 'removeItem'> = sessionStorage,
  now: number = Date.now()
): StateCheck {
  if (received === null || received === '')
    return { ok: false, reason: 'missing_state' };

  const raw = storage.getItem(ALCORE_AUTH_STATE_KEY);
  storage.removeItem(ALCORE_AUTH_STATE_KEY);
  if (raw === null) return { ok: false, reason: 'state_mismatch' };

  let parsed: StoredState;
  try {
    parsed = JSON.parse(raw) as StoredState;
  } catch {
    return { ok: false, reason: 'state_mismatch' };
  }
  if (
    typeof parsed?.value !== 'string' ||
    typeof parsed?.createdAt !== 'number'
  ) {
    return { ok: false, reason: 'state_mismatch' };
  }
  if (now - parsed.createdAt > HANDSOFF_STATE_TTL_MS) {
    return { ok: false, reason: 'state_expired' };
  }
  if (parsed.value !== received) return { ok: false, reason: 'state_mismatch' };
  return { ok: true };
}

/**
 * Outcome of completing a handoff callback. `ok: false` always carries a reason
 * that is safe to show a user: it never distinguishes "no session was started"
 * from "someone tampered", which would make this an oracle.
 */
export type CallbackOutcome<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly reason: StateRejection | 'missing_code' | 'exchange_failed';
    };

export interface CallbackExchangeResult {
  readonly success: boolean;
}

/** Options for {@link completeCanonicalCallback}. */
export interface CallbackOptions {
  /**
   * Redeem the code twice before reporting `exchange_failed` (R7). The
   * single-use code fails closed server-side with one generic message, so
   * a second attempt can only rescue a redemption lost to a transient
   * network or 5xx failure inside the handoff TTL — it can never turn a
   * consumed or invalid code into a session, and the user-visible message
   * stays generic (no oracle).
   */
  readonly retryExchangeOnce?: boolean;
}

/**
 * The whole callback decision, free of React and of the network.
 *
 * Keeping the ordering here — state before code before redemption — is the
 * security-relevant part, and it is exactly what a component-level render test
 * cannot reach: the effects that drive it never run under SSR. Injecting the
 * exchange call keeps this unit-testable without a DOM harness.
 */
export async function completeCanonicalCallback<
  T extends CallbackExchangeResult,
>(
  params: {
    readonly code: string | null;
    readonly state: string | null;
    readonly origin: string;
    readonly consumeState?: typeof consumeHandoffState;
  },
  exchange?: (code: string, redirectUri: string, state: string) => Promise<T>,
  options?: CallbackOptions
): Promise<CallbackOutcome<T>> {
  const consumeState = params.consumeState ?? consumeHandoffState;

  const check = consumeState(params.state);
  if (!check.ok) return { ok: false, reason: check.reason ?? 'state_mismatch' };

  const code = params.code;
  if (code === null || code === '')
    return { ok: false, reason: 'missing_code' };

  const state = params.state ?? '';
  if (exchange === undefined) {
    // Fail closed rather than treating "no transport wired up" as success.
    return { ok: false, reason: 'exchange_failed' };
  }
  const redirectUri = canonicalCallbackUrl(params.origin);
  let result = await exchange(code, redirectUri, state);
  if (!result.success && options?.retryExchangeOnce === true) {
    result = await exchange(code, redirectUri, state);
  }
  if (!result.success) return { ok: false, reason: 'exchange_failed' };
  return { ok: true, data: result };
}

/**
 * Starts a handoff and returns the Auth URL to navigate to. The caller supplies
 * the Auth base URL and its own origin so this module stays importable outside a
 * browser (unit tests run under plain Node).
 */
export function startAuthHandoff(
  authBaseUrl: string,
  origin: string,
  storage: Pick<Storage, 'setItem'> = sessionStorage,
  now: number = Date.now(),
  randomSource?: { getRandomValues?: (a: Uint8Array) => Uint8Array }
): string {
  const state = generateState(randomSource);
  rememberHandoffState(state, storage, now);
  return buildAuthRedirectUrl(authBaseUrl, state, canonicalCallbackUrl(origin));
}
