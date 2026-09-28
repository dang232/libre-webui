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

// handleInvalidSession is DOM-free by construction: storage, window and the
// auth store are all optional. The harness below stubs the browser surface
// the helper touches and counts every side effect.

const events: string[] = [];
const removedKeys: string[] = [];
const store: Record<string, string> = {};
let hrefWrites = 0;
let currentHref = '/settings';

const resetStubs = (): void => {
  events.length = 0;
  removedKeys.length = 0;
  hrefWrites = 0;
  currentHref = '/settings';
  for (const key of Object.keys(store)) delete store[key];
};

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string): string | null => store[key] ?? null,
    setItem: (key: string, value: string): void => {
      store[key] = value;
    },
    removeItem: (key: string): void => {
      removedKeys.push(key);
      delete store[key];
    },
  },
});

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    location: {
      protocol: 'http:',
      pathname: '/settings',
      hash: '',
      get href(): string {
        return currentHref;
      },
      set href(next: string) {
        hrefWrites += 1;
        currentHref = next;
      },
    },
    dispatchEvent: (event: { type: string }): boolean => {
      events.push(event.type);
      return true;
    },
  },
});

const {
  AUTH_INVALIDATED_EVENT,
  AUTH_TOKEN_STORAGE_KEY,
  handleInvalidSession,
  isSessionInvalidated,
  resetSessionInvalidated,
} = await import('./sessionInvalid');

test('first invalid session clears the token and fires exactly one event', () => {
  resetStubs();
  resetSessionInvalidated();
  store[AUTH_TOKEN_STORAGE_KEY] = 'stale-token';
  assert.equal(handleInvalidSession(), true);
  assert.equal(store[AUTH_TOKEN_STORAGE_KEY], undefined);
  assert.deepEqual(removedKeys, [AUTH_TOKEN_STORAGE_KEY]);
  assert.deepEqual(events, [AUTH_INVALIDATED_EVENT]);
  assert.equal(isSessionInvalidated(), true);
  assert.equal(currentHref, '/login');
  assert.equal(hrefWrites, 1);
});

test('concurrent 401s after the first are side-effect free (no retry storm)', () => {
  resetStubs();
  resetSessionInvalidated();
  store[AUTH_TOKEN_STORAGE_KEY] = 'stale-token';
  const results = [
    handleInvalidSession(),
    handleInvalidSession(),
    handleInvalidSession(),
  ];
  assert.deepEqual(results, [true, false, false]);
  assert.deepEqual(
    events.filter(e => e === AUTH_INVALIDATED_EVENT),
    [AUTH_INVALIDATED_EVENT]
  );
  assert.equal(hrefWrites, 1);
  assert.deepEqual(removedKeys, [AUTH_TOKEN_STORAGE_KEY]);
});

test('no redirect when already on the login page', () => {
  resetStubs();
  resetSessionInvalidated();
  currentHref = '/login';
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        protocol: 'http:',
        pathname: '/login',
        hash: '',
        get href(): string {
          return currentHref;
        },
        set href(next: string) {
          hrefWrites += 1;
          currentHref = next;
        },
      },
      dispatchEvent: (event: { type: string }): boolean => {
        events.push(event.type);
        return true;
      },
    },
  });
  assert.equal(handleInvalidSession(), true);
  assert.deepEqual(events, [AUTH_INVALIDATED_EVENT]);
  assert.equal(hrefWrites, 0);
});

test('reset restores a fresh latch for the next login', () => {
  resetStubs();
  resetSessionInvalidated();
  assert.equal(handleInvalidSession(), true);
  resetSessionInvalidated();
  assert.equal(isSessionInvalidated(), false);
  assert.equal(handleInvalidSession(), true);
  assert.equal(events.filter(e => e === AUTH_INVALIDATED_EVENT).length, 2);
});
