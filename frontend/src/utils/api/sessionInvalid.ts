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
 * Unified invalid-session path (todo 22, shared by todos 19-23).
 *
 * Mirrors the TokenPanel portal contract (`apps/api/.../client.ts:183-186`):
 * any HTTP 401 — an expired/revoked Libre session OR a 401 forwarded by the
 * BFF when the upstream TokenPanel customer JWT is bad/expired — clears the
 * stored token and emits AUTH_INVALIDATED_EVENT exactly once per session.
 * Single-fire matters: N in-flight requests failing together must produce
 * one logout + one redirect, never a retry storm or repeated navigation.
 * The BFF never retries an upstream 401 (fail-closed), so a stale token can
 * never continue working past this point.
 */

export const AUTH_INVALIDATED_EVENT = 'auth:invalidated';

export const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

let invalidated = false;

/** True once the invalidation event has fired for the current session. */
export const isSessionInvalidated = (): boolean => invalidated;

/**
 * Reset the single-fire latch. Called on explicit login (a fresh session
 * gets a fresh latch) and by unit tests. Never called by the 401 path.
 */
export const resetSessionInvalidated = (): void => {
  invalidated = false;
};

const storage = (): Storage | null => {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // Non-DOM runtimes (unit tests without a stub) have no storage.
  }
  return null;
};

const win = (): Window | null => {
  try {
    if (typeof window !== 'undefined') return window;
  } catch {
    // Non-DOM runtimes.
  }
  return null;
};

const clearStoredToken = (): void => {
  storage()?.removeItem(AUTH_TOKEN_STORAGE_KEY);
};

const notifyStoreLogout = (): void => {
  // Dynamic import: authStore pulls half the app graph; the API client must
  // not statically depend on it (import cycle + Node testability).
  import('@/store/authStore')
    .then(({ useAuthStore }) => {
      try {
        useAuthStore.getState().logout();
      } catch {
        // Store teardown must never break invalidation.
      }
    })
    .catch(() => {
      // Store teardown must never break invalidation.
    });
};

const redirectToLoginOnce = (): void => {
  const w = win();
  if (!w?.location) return;
  const isElectron = w.location.protocol === 'file:';
  const currentPath = isElectron
    ? String(w.location.hash || '')
    : String(w.location.pathname || '');
  if (currentPath.includes('/login')) return;
  w.location.href = isElectron ? '#/login' : '/login';
};

/**
 * Handle an invalid/expired session. Fires at most once: the first call
 * clears the token, logs the store out, dispatches AUTH_INVALIDATED_EVENT
 * and navigates to login; later calls return false with zero side effects.
 * Returns true exactly when this call fired the event.
 */
export const handleInvalidSession = (): boolean => {
  if (invalidated) return false;
  invalidated = true;
  clearStoredToken();
  notifyStoreLogout();
  win()?.dispatchEvent(new CustomEvent(AUTH_INVALIDATED_EVENT));
  redirectToLoginOnce();
  return true;
};
