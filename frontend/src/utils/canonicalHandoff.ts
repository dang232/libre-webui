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
 */

const STATE_STORAGE_KEY = 'alcore.canonical.handoff';

/** Must match the registered redirect URI on the Auth side, character for character. */
export const CANONICAL_CALLBACK_PATH = '/auth/callback';

/** Where the user lands after a successful exchange. */
export const POST_LOGIN_PATH = '/';

/**
 * Bound well below Auth's 60s code TTL: Auth refuses a stale code regardless, and
 * a shorter browser-side window shrinks the replay opportunity.
 */
export const HANDSOFF_STATE_TTL_MS = 5 * 60 * 1000;

interface StoredState {
  readonly value: string;
  readonly createdAt: number;
}

/** Web Crypto randomness; falls back only where the API is unavailable. */
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

export function rememberHandoffState(
  state: string,
  storage: Pick<Storage, 'setItem'> & { now?: () => number } = sessionStorage,
  now: number = Date.now()
): void {
  const entry: StoredState = { value: state, createdAt: now };
  storage.setItem(STATE_STORAGE_KEY, JSON.stringify(entry));
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

  const raw = storage.getItem(STATE_STORAGE_KEY);
  storage.removeItem(STATE_STORAGE_KEY);
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
