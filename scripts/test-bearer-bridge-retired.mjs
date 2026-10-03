/*
 * Legacy Bearer shared-secret bridge retirement (unified-auth-core todo 16).
 *
 * Boots the REAL backend in alcore mode with AUTH_JWT_SECRET deliberately SET
 * and proves the retirement is unconditional: every legacy Bearer route
 * answers 410 CANONICAL_AUTH_RETIRED while the redirect target
 * (POST /api/auth/alcore/exchange) stays live. No stub Auth is needed — the
 * retired routes must answer before any upstream call, and the redirect
 * probes use shapes that never touch Auth.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const PORT = Number(process.env.BEARER_RETIRED_PORT || 3223);
const base = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-bearer-retired-'));
// Production preflight fatals when its tmp dir defaults inside DATA_DIR
// (PLATFORM_PREFLIGHT_TMP_DIR must be outside DATA_DIR), so mint one.
const preflightTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-bearer-retired-preflight-'));

let backend;
const bootLog = [];
const post = (route, body) =>
  fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const waitForReady = async (timeoutMs = 120000) => {
  // Any HTTP response (even 404) proves the listener is up; readiness is the
  // alcore config advertisement answering 200.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${base}/api/auth/alcore/config`);
      if (response.status === 200) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      process.stderr.write(`[bearer-retired] boot log tail:\n`);
      for (const line of bootLog.slice(-30)) process.stderr.write(line);
      throw new Error(`backend never became ready at ${base}`);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
};

test.before(async () => {
  backend = spawn(process.execPath, ['backend/dist/main.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      WEBUI_HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      PLATFORM_PREFLIGHT_TMP_DIR: preflightTmpDir,
      ENCRYPTION_KEY: '7'.repeat(64),
      JWT_SECRET: 'bearer-retired-test-secret-that-is-long-enough',
      NODE_ENV: 'production',
      ALCORE_DEPLOYMENT: 'alcore',
      ALCORE_AUTH_MODE: 'alcore',
      // Retirement must hold even when the secret is configured.
      AUTH_JWT_SECRET: 'retired-dummy-secret-proves-unconditional-410',
      ALCORE_SKIP_STARTUP_INTEGRITY_SCAN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', chunk => bootLog.push(String(chunk)));
  backend.stderr.on('data', chunk => bootLog.push(String(chunk)));
  await waitForReady();
});

test.after(async () => {
  backend?.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 1000));
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(preflightTmpDir, { recursive: true, force: true });
});

for (const [route, body] of [
  ['/api/auth/canonical-password', { email: 'a@b.c', password: 'x' }],
  ['/api/auth/canonical-signup', { email: 'a@b.c', password: 'x' }],
  ['/api/auth/canonical-google', { idToken: 'gis-token' }],
  ['/api/auth/canonical-exchange', { code: 'one-use-code' }],
]) {
  test(`Given alcore mode with secret set, when POST ${route}, then 410 retired`, async () => {
    const response = await post(route, body);
    assert.equal(response.status, 410);
    const payload = await response.json();
    assert.equal(payload.success, false);
    assert.equal(payload.code, 'CANONICAL_AUTH_RETIRED');
  });
}

test('Given alcore mode, when redirect config is read, then target is advertised', async () => {
  const response = await fetch(`${base}/api/auth/alcore/config`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.equal(payload.data.mode, 'alcore');
});

test('Given alcore mode, when redirect exchange gets a malformed body, then 400 (route live, not retired)', async () => {
  const response = await post('/api/auth/alcore/exchange', {});
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('Given alcore mode, when provider status is read, then advertisement is intact', async () => {
  const response = await fetch(`${base}/api/auth/oauth/google/status`);
  assert.equal(response.status, 200);
});
