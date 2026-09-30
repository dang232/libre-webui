import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const authRoot =
  process.env.AUTH_SERVICE_ROOT ||
  path.resolve(process.cwd(), '..', 'auth-service-shared-identity');
const authPort = Number(process.env.AUTH_SIM_PORT || 18099);
const librePort = Number(process.env.LIBRE_SIM_PORT || 18100);
const authBase = `http://127.0.0.1:${authPort}`;
const libreBase = `http://127.0.0.1:${librePort}`;
const issuer = 'auth.alcore.io.vn';
const secret = `local-simulation-${crypto.randomUUID()}-only`;
const email = 'libre-simulation@example.test';
const password = 'Local-Simulation-Password-42!';
const googleEmail = 'google-simulation@example.test';
const scratch = fs.mkdtempSync(
  path.join(os.tmpdir(), 'libre-unified-identity-')
);
const authDataDir = path.join(scratch, 'auth-data');
const dataDir = path.join(scratch, 'libre-data');
const preflightDir = path.join(scratch, 'libre-preflight');
fs.mkdirSync(authDataDir);
fs.mkdirSync(dataDir);
fs.mkdirSync(preflightDir);

// This preload stubs only Auth's external Google tokeninfo request. Product
// and Auth HTTP APIs remain live loopback requests to their real processes.
const googlePreload = path.join(scratch, 'google-tokeninfo-preload.mjs');
fs.writeFileSync(
  googlePreload,
  `
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
`
);

const bun = process.env.BUN_EXECUTABLE || 'bun';
let auth;
let libre;
let canonicalUserId;
const waitFor = async (url, child, label) => {
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => {
    output += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', chunk => {
    output += chunk;
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${label} did not become ready: ${output}`);
};
const postLibre = (route, body) =>
  fetch(`${libreBase}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('Given live Auth and built Libre backend, when canonical signup runs, then Libre creates a session for the canonical email', async () => {
  auth = spawn(bun, ['--preload', googlePreload, 'src/index.ts'], {
    cwd: authRoot,
    env: {
      ...process.env,
      AUTH_PORT: String(authPort),
      AUTH_HOST: '127.0.0.1',
      AUTH_DATABASE_PATH: path.join(authDataDir, 'auth.sqlite'),
      AUTH_ISSUER: issuer,
      AUTH_ALLOWED_ORIGINS: 'http://127.0.0.1',
      JWT_SECRET: secret,
      NODE_ENV: 'production',
      GOOGLE_CLIENT_ID: 'sim-client.apps.googleusercontent.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor(`${authBase}/health`, auth, 'Auth');
  libre = spawn(process.execPath, ['backend/dist/main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(librePort),
      WEBUI_HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      ENCRYPTION_KEY: '0'.repeat(64),
      JWT_SECRET: `libre-simulation-${crypto.randomUUID()}-secret`,
      ENABLE_SIGNUP: 'true',
      NODE_ENV: 'test',
      AUTH_BASE_URL: authBase,
      AUTH_ISSUER: issuer,
      AUTH_JWT_SECRET: secret,
      PLATFORM_DATABASE_BACKEND: 'sqlite',
      PLATFORM_PREFLIGHT_TMP_DIR: preflightDir,
      PLATFORM_JOB_WORKER_MODE: 'external',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor(`${libreBase}/health`, libre, 'Libre backend');
  const response = await postLibre('/api/auth/canonical-signup', {
    email,
    password,
  });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.user.email, email);
  assert.ok(body.data.token);
  canonicalUserId = body.data.user.id;
  const session = JSON.parse(
    Buffer.from(body.data.token.split('.')[1], 'base64url').toString()
  );
  assert.equal(session.userId, canonicalUserId);
});

test('Given the canonical account, when password login succeeds or fails, then identity is stable and invalid credentials fail closed', async () => {
  const login = await postLibre('/api/auth/canonical-password', {
    email,
    password,
  });
  assert.equal(login.status, 200, await login.clone().text());
  const loggedIn = await login.json();
  assert.equal(loggedIn.data.user.id, canonicalUserId);
  assert.equal(loggedIn.data.user.email, email);
  const wrong = await postLibre('/api/auth/canonical-password', {
    email,
    password: 'Wrong-Local-Password-99!',
  });
  assert.equal(wrong.status, 401, await wrong.text());
});

test('Given a verified Google ID token, when canonical Google sign-in runs, then it returns a Libre session for Auth-verified email', async () => {
  const response = await postLibre('/api/auth/canonical-google', {
    idToken: 'simulation-google-id-token',
  });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.user.email, googleEmail);
  assert.ok(body.data.token);
  // Repeat Google sign-in inside the same test so the login rate bucket
  // (5 per 15 min per IP) is never exceeded by the suite as a whole.
  const repeat = await postLibre('/api/auth/canonical-google', {
    idToken: 'simulation-google-id-token',
  });
  assert.equal(repeat.status, 200, await repeat.clone().text());
  assert.equal((await repeat.json()).data.user.id, body.data.user.id);
});

const secondEmail = 'libre-simulation-second@example.test';
let secondAuthToken = '';
let secondAuthSub = '';

test('Given direct Auth API, when registering and logging in, then Auth issues sessions with cookies', async () => {
  const register = await fetch(`${authBase}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: secondEmail, password }),
  });
  assert.equal(register.status, 201, await register.clone().text());
  const setCookie = register.headers.getSetCookie?.() ?? [];
  assert.ok(
    setCookie.some(cookie => cookie.startsWith('alcore_at=')) ||
      (register.headers.get('set-cookie') ?? '').includes('alcore_at='),
    'register must set the Auth session cookie'
  );
  const login = await fetch(`${authBase}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: secondEmail, password }),
  });
  assert.equal(login.status, 200, await login.clone().text());
  const loginBody = await login.json();
  assert.equal(typeof loginBody.access_token, 'string');
  secondAuthToken = loginBody.access_token;
});

const decodeJwtPayload = token =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

test('Given an Auth session, when exchanging for Libre, then the assertion carries sub/aud/intent/email and the code is single-use', async () => {
  const me = await fetch(`${authBase}/auth/me`, {
    headers: { authorization: `Bearer ${secondAuthToken}` },
  });
  assert.equal(me.status, 200, await me.clone().text());
  const meBody = await me.json();
  secondAuthSub = meBody.id;
  assert.equal(meBody.email, secondEmail);
  const exchange = await fetch(`${authBase}/oidc/exchange`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secondAuthToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ audience: 'libre', intent: 'product_exchange' }),
  });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const { code } = await exchange.json();
  assert.equal(typeof code, 'string');
  const consume = await fetch(`${authBase}/oidc/exchange/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      audience: 'libre',
      intent: 'product_exchange',
    }),
  });
  assert.equal(consume.status, 200, await consume.clone().text());
  const claims = decodeJwtPayload((await consume.json()).access_token);
  // Expected values come from Auth itself (/auth/me), never from test inputs.
  assert.equal(claims.sub, secondAuthSub);
  assert.equal(claims.aud, 'libre');
  assert.equal(claims.intent, 'product_exchange');
  assert.equal(claims.email, secondEmail);
  // A consumed code is rejected outright (invalid_grant) — the enforcement
  // signal is failure, not any one status: first consume succeeded above.
  const replay = await fetch(`${authBase}/oidc/exchange/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      audience: 'libre',
      intent: 'product_exchange',
    }),
  });
  assert.equal(replay.status, 400, await replay.clone().text());
  assert.match(await replay.text(), /invalid_grant/);
});

test('Given the canonical profile row, when read from Libre storage, then it links the Auth subject and keeps the verified address', async () => {
  const [sqliteFile] = fs
    .readdirSync(dataDir)
    .filter(name => name.endsWith('.sqlite'));
  assert.ok(sqliteFile, 'expected a Libre sqlite database in the scratch dir');
  const { default: Database } = await import('better-sqlite3');
  const database = new Database(path.join(dataDir, sqliteFile), {
    readonly: true,
  });
  try {
    const row = database
      .prepare(
        'SELECT id, username, email, canonical_user_id FROM users WHERE id = ?'
      )
      .get(canonicalUserId);
    assert.ok(row, 'canonical profile row must exist');
    assert.equal(typeof row.canonical_user_id, 'string');
    assert.ok(row.canonical_user_id.length > 0);
    // Addresses rest encrypted at rest, so the stored form never equals the
    // plaintext: the regression signal is a populated column. Before the
    // email-claim fix it stayed NULL while the API echoed the request email.
    // Correctness of the value itself is proven by the API-level assertions
    // above, which read back through the decrypting repository path.
    assert.equal(typeof row.email, 'string');
    assert.ok(row.email.length > 0);
  } finally {
    database.close();
  }
});

test('Given an existing canonical account, when signing up again, then Libre reports conflict', async () => {
  const response = await postLibre('/api/auth/canonical-signup', {
    email,
    password,
  });
  assert.equal(response.status, 409, await response.clone().text());
});

test('Given an existing session, when signing in again by password, then the same Libre profile returns', async () => {
  const again = await postLibre('/api/auth/canonical-password', {
    email,
    password,
  });
  assert.equal(again.status, 200, await again.clone().text());
  assert.equal((await again.json()).data.user.id, canonicalUserId);
});

test.after(async () => {
  for (const child of [libre, auth]) {
    if (!child) continue;
    child.kill();
  }
  await Promise.all(
    [libre, auth]
      .filter(Boolean)
      .map(child =>
        child.exitCode !== null
          ? Promise.resolve()
          : new Promise(resolve => child.once('exit', resolve))
      )
  );
  fs.rmSync(scratch, { recursive: true, force: true });
});
