import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const authRoot = process.env.AUTH_SERVICE_ROOT || path.resolve(process.cwd(), '..', 'auth-service-shared-identity');
const authPort = Number(process.env.AUTH_SIM_PORT || 18099);
const librePort = Number(process.env.LIBRE_SIM_PORT || 18100);
const authBase = `http://127.0.0.1:${authPort}`;
const libreBase = `http://127.0.0.1:${librePort}`;
const issuer = 'auth.alcore.io.vn';
const secret = `local-simulation-${crypto.randomUUID()}-only`;
const email = 'libre-simulation@example.test';
const password = 'Local-Simulation-Password-42!';
const googleEmail = 'google-simulation@example.test';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-unified-identity-'));
const authDataDir = path.join(scratch, 'auth-data');
const dataDir = path.join(scratch, 'libre-data');
const preflightDir = path.join(scratch, 'libre-preflight');
fs.mkdirSync(authDataDir);
fs.mkdirSync(dataDir);
fs.mkdirSync(preflightDir);

// This preload stubs only Auth's external Google tokeninfo request. Product
// and Auth HTTP APIs remain live loopback requests to their real processes.
const googlePreload = path.join(scratch, 'google-tokeninfo-preload.mjs');
fs.writeFileSync(googlePreload, `
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('https://oauth2.googleapis.com/tokeninfo?')) {
    const token = new URL(url).searchParams.get('id_token');
    if (token === 'simulation-google-id-token') return Response.json({
      aud: 'sim-client.apps.googleusercontent.com', iss: 'accounts.google.com',
      exp: String(Math.floor(Date.now() / 1000) + 300), sub: 'google-simulation-subject',
      email: '${googleEmail}', email_verified: true,
    });
    return new Response('{}', { status: 401 });
  }
  return nativeFetch(input, init);
};
`);

const bun = process.env.BUN_EXECUTABLE || 'bun';
let auth;
let libre;
let canonicalUserId;
const waitFor = async (url, child, label) => {
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${label} did not become ready: ${output}`);
};
const postLibre = (route, body) => fetch(`${libreBase}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('Given live Auth and built Libre backend, when canonical signup runs, then Libre creates a session for the canonical email', async () => {
  auth = spawn(bun, ['--preload', googlePreload, 'src/index.ts'], {
    cwd: authRoot,
    env: {
      ...process.env, AUTH_PORT: String(authPort), AUTH_HOST: '127.0.0.1',
      AUTH_DATABASE_PATH: path.join(authDataDir, 'auth.sqlite'), AUTH_ISSUER: issuer,
      AUTH_ALLOWED_ORIGINS: 'http://127.0.0.1', JWT_SECRET: secret,
      NODE_ENV: 'production', GOOGLE_CLIENT_ID: 'sim-client.apps.googleusercontent.com',
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor(`${authBase}/health`, auth, 'Auth');
  libre = spawn(process.execPath, ['backend/dist/main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env, PORT: String(librePort), WEBUI_HOST: '127.0.0.1',
      DATA_DIR: dataDir, ENCRYPTION_KEY: '0'.repeat(64),
      JWT_SECRET: `libre-simulation-${crypto.randomUUID()}-secret`, ENABLE_SIGNUP: 'true',
      NODE_ENV: 'test', AUTH_BASE_URL: authBase, AUTH_ISSUER: issuer,
      AUTH_JWT_SECRET: secret, PLATFORM_DATABASE_BACKEND: 'sqlite',
      PLATFORM_PREFLIGHT_TMP_DIR: preflightDir, PLATFORM_JOB_WORKER_MODE: 'external',
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor(`${libreBase}/health`, libre, 'Libre backend');
  const response = await postLibre('/api/auth/canonical-signup', { email, password });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.user.email, email);
  assert.ok(body.data.token);
  canonicalUserId = body.data.user.id;
  const session = JSON.parse(Buffer.from(body.data.token.split('.')[1], 'base64url').toString());
  assert.equal(session.userId, canonicalUserId);
});

test('Given the canonical account, when password login succeeds or fails, then identity is stable and invalid credentials fail closed', async () => {
  const login = await postLibre('/api/auth/canonical-password', { email, password });
  assert.equal(login.status, 200, await login.clone().text());
  const loggedIn = await login.json();
  assert.equal(loggedIn.data.user.id, canonicalUserId);
  assert.equal(loggedIn.data.user.email, email);
  const wrong = await postLibre('/api/auth/canonical-password', { email, password: 'Wrong-Local-Password-99!' });
  assert.equal(wrong.status, 401, await wrong.text());
});

test('Given a verified Google ID token, when canonical Google sign-in runs, then it returns a Libre session for Auth-verified email', async () => {
  const response = await postLibre('/api/auth/canonical-google', { idToken: 'simulation-google-id-token' });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.user.email, googleEmail);
  assert.ok(body.data.token);
});

test.after(async () => {
  for (const child of [libre, auth]) {
    if (!child) continue;
    child.kill();
  }
  await Promise.all([libre, auth].filter(Boolean).map(child =>
    child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))
  ));
  fs.rmSync(scratch, { recursive: true, force: true });
});
