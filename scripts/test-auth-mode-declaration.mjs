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

/*
 * Production auth-mode declaration (unified-auth-core todo 14).
 *
 * Covers: Alcore-managed host detection (explicit ALCORE_DEPLOYMENT=alcore
 * marker, or BASE_URL/CORS_ORIGIN on the alcore.io.vn production domains);
 * assertAlcoreHostAuthMode passes an alcore-booted managed host and throws
 * FATAL otherwise (fail-closed before persistence opens or the port
 * listens); generic self-hosted installs are never managed hosts, so the
 * `local` default is untouched; the mode is boot-once and cannot flip under
 * a running process.
 *
 * Gating only: no local issuance code is touched or deleted here.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const authMode = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'config', 'authMode.js')
  ).href
);
const { isAlcoreManagedHost, assertAlcoreHostAuthMode } = authMode;

test('generic self-hosted installs are never managed hosts', () => {
  assert.equal(isAlcoreManagedHost({}), false);
  assert.equal(
    isAlcoreManagedHost({ BASE_URL: 'http://localhost:3001' }),
    false
  );
  assert.equal(
    isAlcoreManagedHost({
      CORS_ORIGIN: 'http://localhost:5173,http://127.0.0.1:5173',
    }),
    false
  );
  assert.equal(
    isAlcoreManagedHost({ ALCORE_DEPLOYMENT: 'self-hosted' }),
    false
  );
  assert.equal(isAlcoreManagedHost({ ALCORE_DEPLOYMENT: '' }), false);
});

test('alcore-managed host detection: marker and production origins', () => {
  assert.equal(isAlcoreManagedHost({ ALCORE_DEPLOYMENT: 'alcore' }), true);
  assert.equal(isAlcoreManagedHost({ ALCORE_DEPLOYMENT: '  Alcore ' }), true);
  assert.equal(
    isAlcoreManagedHost({ BASE_URL: 'https://web.alcore.io.vn' }),
    true
  );
  assert.equal(
    isAlcoreManagedHost({
      CORS_ORIGIN: 'https://web.alcore.io.vn,https://alcore.io.vn',
    }),
    true
  );
  assert.equal(
    isAlcoreManagedHost({ CORS_ORIGIN: 'https://WEB.ALCORE.IO.VN' }),
    true
  );
});

test('managed host boots only with alcore mode, otherwise FATAL', () => {
  assert.doesNotThrow(() =>
    assertAlcoreHostAuthMode({
      ALCORE_DEPLOYMENT: 'alcore',
      ALCORE_AUTH_MODE: 'alcore',
    })
  );
  for (const mode of ['local', '', 'bogus', undefined]) {
    const env =
      mode === undefined
        ? { ALCORE_DEPLOYMENT: 'alcore' }
        : { ALCORE_DEPLOYMENT: 'alcore', ALCORE_AUTH_MODE: mode };
    assert.throws(() => assertAlcoreHostAuthMode(env), /FATAL.*ALCORE_AUTH_MODE=alcore/);
  }
  assert.throws(
    () =>
      assertAlcoreHostAuthMode({
        BASE_URL: 'https://web.alcore.io.vn',
        ALCORE_AUTH_MODE: 'local',
      }),
    /Refusing to boot/
  );
});

test('self-hosted local boot is never gated', () => {
  assert.doesNotThrow(() => assertAlcoreHostAuthMode({}));
  assert.doesNotThrow(() =>
    assertAlcoreHostAuthMode({ ALCORE_AUTH_MODE: 'local' })
  );
});

test('mode is boot-once: later env flips cannot change it', () => {
  const before = authMode.getAuthMode();
  process.env.ALCORE_AUTH_MODE =
    before === 'alcore' ? 'local-bogus-flip' : 'alcore';
  try {
    assert.equal(authMode.getAuthMode(), before);
    assert.equal(authMode.AUTH_MODE, before);
  } finally {
    delete process.env.ALCORE_AUTH_MODE;
  }
});
