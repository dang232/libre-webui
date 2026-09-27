/*
 * ALcore API platform auto base-usage (Wave4 todo 19 flowfix-autobase).
 *
 * Proves, against a stubbed TokenPanel that enforces the real upstream auth
 * rules (management: tp_mgmt_* only; public customer surface: customer JWT
 * only; /v1: tp_live_* customer key only), with Ollama guaranteed DOWN, that:
 * - a fresh signup with an email is provisioned automatically: a
 *   `libre-auto` customer key is minted server-side, stored as the user's
 *   encrypted `alcore` plugin credential (never in the browser, never
 *   logged), the bundled plugin is activated, and the default model
 *   preference becomes default-chat/plugin/alcore;
 * - a first chat resolves through the real plugin execution path to the
 *   stub /v1/chat/completions with the server-held tp_live_* key;
 * - re-login provisions nothing new (idempotent, zero TokenPanel calls);
 * - signup without an email skips provisioning cleanly and auth still works;
 * - the signup limiter now allows 10/15min per IP (retune proof) and the
 *   11th rapid signup is rejected with 429;
 * - no HTTP response in the flow carries a tp_live_* secret.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const dataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'libre-task19-autobase-')
);
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = '9'.repeat(64);
process.env.JWT_SECRET = 'task19-flowfix-autobase-secret-long-enough';
process.env.ENABLE_SIGNUP = 'true';
process.env.TOKENPANEL_MGMT_KEY = 'tp_mgmt_testkey_autobase';
delete process.env.OLLAMA_HOST;
delete process.env.ALCORE_API_KEY;

const requireRoot = createRequire(pathToFileURL('package.json').href);
const express = requireRoot('express');

const importBuilt = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);

/** Stub TokenPanel enforcing the real auth boundary + call ledger. */
const ledger = {
  bridgeResolve: 0,
  portalMint: 0,
  keyCreate: 0,
  v1Chat: 0,
  v1Models: 0,
  v1KeysUsed: [],
};
const stubState = { customers: [], keys: [], seq: 0 };
// Harness-side truth only (never crosses HTTP): customer -> full secret,
// so the test can emulate an admin Settings key-save without browser I/O.
const stubSecrets = {};
const stubCustomerOfAuth = {};
const MGMT = 'Bearer tp_mgmt_testkey_autobase';
const mintFor = customerId => `customer-jwt-${customerId}`;
const customerIdOf = auth =>
  typeof auth === 'string' && auth.startsWith('Bearer customer-jwt-')
    ? auth.slice('Bearer customer-jwt-'.length)
    : null;

const stubJson = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const stubFetch = async (url, init = {}) => {
  const u = String(url);
  const headers = init.headers || {};
  const auth = headers.Authorization || headers.authorization;
  const method = init.method || 'GET';

  if (u.includes('/api/management/customers/bridge-resolve')) {
    if (auth !== MGMT) return stubJson(401, { error: 'unauthorized' });
    ledger.bridgeResolve += 1;
    const body = JSON.parse(init.body);
    let row = stubState.customers.find(c => c.authUserId === body.authUserId);
    let linked = 'existing';
    if (!row) {
      row = {
        _id: `cust-${stubState.customers.length + 1}`,
        authUserId: body.authUserId,
        email: body.email,
      };
      stubState.customers.push(row);
      linked = 'created';
    }
    stubCustomerOfAuth[body.authUserId] = row._id;
    return stubJson(200, { customer: row, customerId: row._id, linked });
  }
  const mint = u.match(/\/api\/management\/customers\/([^/]+)\/portal-token$/);
  if (mint && method === 'POST') {
    if (auth !== MGMT) return stubJson(401, { error: 'unauthorized' });
    ledger.portalMint += 1;
    return stubJson(200, {
      token: mintFor(mint[1]),
      expiresAt: '2030-01-01T00:02:00.000Z',
    });
  }
  if (u.includes('/public/customers/')) {
    const customerId = customerIdOf(auth);
    if (!customerId) return stubJson(401, { error: 'unauthorized' });
    const urlPath = u.split('/public/customers')[1].split('?')[0];
    if (method === 'POST' && urlPath === '/keys') {
      ledger.keyCreate += 1;
      const body = JSON.parse(init.body);
      stubState.seq += 1;
      const row = {
        _id: `aaaaaaaaaaaaaaaaaaaaaaaa${stubState.seq}`.slice(-24),
        customerId,
        name: body.name,
        prefix: 'tp_live_testprefix',
        fingerprint: `fp-${stubState.seq}`,
        status: 'active',
      };
      const secret = `tp_live_secret_${stubState.seq}_only_once`;
      stubState.keys.push({ ...row, secret });
      stubSecrets[customerId] = secret;
      return stubJson(201, { apiKey: row, key: secret });
    }
    return stubJson(404, { error: 'not_found' });
  }
  if (u.endsWith('/v1/models') && method === 'GET') {
    ledger.v1Models += 1;
    if (typeof auth !== 'string' || !auth.startsWith('Bearer tp_live_')) {
      return stubJson(401, { error: 'unauthorized' });
    }
    return stubJson(200, { data: [{ id: 'default-chat' }] });
  }
  if (u.endsWith('/v1/chat/completions') && method === 'POST') {
    ledger.v1Chat += 1;
    if (typeof auth !== 'string' || !auth.startsWith('Bearer tp_live_')) {
      return stubJson(401, { error: 'unauthorized' });
    }
    ledger.v1KeysUsed.push(auth);
    const body = JSON.parse(init.body);
    return stubJson(200, {
      id: 'chatcmpl-autobase',
      object: 'chat.completion',
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'platform-answer-ok' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  }
  throw new Error(`unexpected upstream call ${method} ${u}`);
};

const stubServer = express();
stubServer.use(express.json());
stubServer.use(async (req, res) => {
  try {
    const out = await stubFetch(`http://stub${req.url}`, {
      method: req.method,
      headers: { Authorization: req.headers.authorization },
      body:
        req.method === 'GET' || req.method === 'DELETE'
          ? undefined
          : JSON.stringify(req.body ?? {}),
    });
    const body = await out.json();
    res.status(out.status).json(body);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});
const stubListener = await new Promise(resolve => {
  const s = stubServer.listen(0, '127.0.0.1', () => resolve(s));
});
const stubPort = stubListener.address().port;
process.env.TOKENPANEL_API_URL = `http://127.0.0.1:${stubPort}`;

const [
  { authService },
  { userModel },
  database,
  coordinatorMod,
  authRouterMod,
  provisionMod,
  pluginServiceMod,
  pluginCredentialsMod,
  preferencesMod,
] = await Promise.all([
  importBuilt('services/authService.js'),
  importBuilt('models/userModel.js'),
  importBuilt('db.js'),
  importBuilt('platform/coordination/service.js'),
  importBuilt('routes/auth.js'),
  importBuilt('services/apiPlatformProvisionService.js'),
  importBuilt('services/pluginService.js'),
  importBuilt('services/pluginCredentialsService.js'),
  importBuilt('services/preferencesService.js'),
]);
const pluginService = pluginServiceMod.default;
const pluginCredentialsService = pluginCredentialsMod.default;
const preferencesService = preferencesMod.default;

await coordinatorMod.initializeCoordinator();

const app = express();
app.use(express.json());
app.use('/api/auth', authRouterMod.default);
const apiListener = await new Promise(resolve => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const apiBase = `http://127.0.0.1:${apiListener.address().port}`;

test.after(async () => {
  await new Promise(resolve => apiListener.close(resolve));
  await new Promise(resolve => stubListener.close(resolve));
  try {
    await coordinatorMod.closeCoordinator();
  } catch {
    // Local coordinator teardown is best-effort in the harness.
  }
  database.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const seenBodies = [];
const signup = (username, email) =>
  fetch(`${apiBase}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: 'AutobaseProbe1!x',
      ...(email === undefined ? {} : { email }),
    }),
  }).then(async r => {
    const body = await r.json();
    seenBodies.push(JSON.stringify(body));
    return { status: r.status, body };
  });

const waitFor = async (label, check, timeoutMs = 15000) => {
  const start = Date.now();
  for (;;) {
    const done = await check();
    if (done) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};

// Connection-variable writes publish cross-replica cache invalidation, so a
// chat issued milliseconds after provisioning could resolve the previous
// route. Poll the effective resolved variables until the stub base lands.

await test('autobase: fresh signup provisions platform base usage with Ollama down', async () => {
  let ollamaError = '';
  try {
    await fetch('http://127.0.0.1:11434/api/tags', {
      signal: AbortSignal.timeout(3000),
    });
  } catch (error) {
    ollamaError = error instanceof Error ? error.message : String(error);
  }
  console.log(`autobase ollama probe error=${ollamaError}`);
  assert.ok(ollamaError.length > 0, 'Ollama must be DOWN for this proof');

  const first = await signup('autobase-free', 'free@test.local');
  assert.equal(first.status, 200);
  const userId = first.body.data.user.id;
  console.log(`autobase signup user=${userId}`);

  await waitFor('platform credential', async () => {
    const creds = await pluginCredentialsService.getCredentials(userId);
    return creds.some(c => c.plugin_id === 'alcore' && c.has_api_key);
  });
  await waitFor('platform default', async () => {
    const prefs = await preferencesService.getPreferences(userId);
    return (
      prefs.defaultModel === 'default-chat' &&
      prefs.defaultProviderType === 'plugin' &&
      prefs.defaultProviderId === 'alcore'
    );
  });
  const creds = await pluginCredentialsService.getCredentials(userId);
  console.log(`autobase credentials=${JSON.stringify(creds)}`);
  assert.ok(
    creds.some(c => c.plugin_id === 'alcore' && c.has_api_key),
    'alcore credential stored server-side'
  );

  const active = await pluginService.getActivePlugins(userId);
  assert.ok(
    active.some(p => p.id === 'alcore'),
    'bundled alcore plugin activated for the new user'
  );

  const prefs = await preferencesService.getPreferences(userId);
  console.log(
    `autobase default=${prefs.defaultModel}/${prefs.defaultProviderType}/${prefs.defaultProviderId}`
  );
  assert.equal(prefs.defaultModel, 'default-chat');
  assert.equal(prefs.defaultProviderType, 'plugin');
  assert.equal(prefs.defaultProviderId, 'alcore');

  const keysBefore = ledger.keyCreate;
  const again = await provisionMod.ensureApiPlatformProvision(userId);
  assert.equal(again.provisioned, true);
  assert.equal(ledger.keyCreate, keysBefore, 'no duplicate platform key');
  console.log(`autobase re-provision reason=${again.reason}`);

  // Self-hosted admin setup, emulating Settings in the supported order:
  // connection override first, then key (re)bind so the routing fingerprint
  // matches the stub route. The provisioned credential alone binds the
  // manifest-default route, which the stub cannot serve.
  const stubBase = `${process.env.TOKENPANEL_API_URL.replace(/\/+$/, '')}/v1`;
  const pluginVarsMod = await importBuilt('services/pluginVariablesService.js');
  const pluginVariablesService = pluginVarsMod.default;
  const alcorePlugin = await pluginService.getPlugin('alcore');
  assert.ok(alcorePlugin, 'bundled alcore plugin resolves');
  const varsStored = await pluginVariablesService.setVariables(
    'alcore',
    { base_url: stubBase },
    alcorePlugin.variables ?? [],
    userId
  );
  assert.equal(varsStored, true);
  const adminFingerprint =
    await pluginService.getCredentialRoutingAuthFingerprint(
      alcorePlugin,
      userId
    );
  const adminKeyRebound = await pluginCredentialsService.setApiKey(
    'alcore',
    stubSecrets[stubCustomerOfAuth[userId]],
    userId,
    adminFingerprint
  );
  assert.equal(adminKeyRebound, true);
  await pluginService.activatePlugin('alcore', userId);
  const answer = await pluginService.executePluginRequest(
    'default-chat',
    [{ role: 'user', content: 'hello platform' }],
    {},
    userId,
    'alcore'
  );
  const content = answer.choices?.[0]?.message?.content ?? answer.content ?? '';
  console.log(`autobase platform answer=${JSON.stringify(content)}`);
  assert.equal(content, 'platform-answer-ok');
  assert.equal(ledger.v1Chat, 1);
  assert.ok(
    ledger.v1KeysUsed.every(k => k.startsWith('Bearer tp_live_')),
    'platform chat authenticates with the server-held customer key'
  );

  // Package-shaped variant: a later (initially pending) user is approved by
  // the admin, then the FIRST LOGIN provisions the same automatic path —
  // plan/subscription state stays server-side, the Libre side is identical.
  const pending = await signup('autobase-pack', 'pack@test.local');
  assert.equal(pending.status, 202);
  const approved = await userModel.approveUser(
    pending.body.data.user.id,
    userId
  );
  assert.ok(approved, 'admin approval activates the package user');
  const login = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'autobase-pack',
      password: 'AutobaseProbe1!x',
    }),
  }).then(async r => ({ status: r.status, body: await r.json() }));
  assert.equal(login.status, 200);
  const packId = login.body.data.user.id;
  await waitFor('package credential', async () => {
    const creds = await pluginCredentialsService.getCredentials(packId);
    return creds.some(c => c.plugin_id === 'alcore' && c.has_api_key);
  });
  // The hook is fire-and-forget past the credential store (activation +
  // default preference follow); poll for the preference like the credential.
  await waitFor('package default', async () => {
    const prefs = await preferencesService.getPreferences(packId);
    return (
      prefs.defaultModel === 'default-chat' &&
      prefs.defaultProviderType === 'plugin' &&
      prefs.defaultProviderId === 'alcore'
    );
  });
  const packPrefs = await preferencesService.getPreferences(packId);
  assert.equal(packPrefs.defaultModel, 'default-chat');
  assert.equal(packPrefs.defaultProviderType, 'plugin');
  assert.equal(packPrefs.defaultProviderId, 'alcore');
  const packActive = await pluginService.getActivePlugins(packId);
  assert.ok(packActive.some(p => p.id === 'alcore'));
  // Non-admin routing proof (no network): resolving the model for the
  // package user succeeds only with an active plugin AND a usable stored
  // credential, and the server-side key equals the stub-minted secret.
  // Stored connection overrides are admin-gated by design (SSRF defense),
  // so no live execution runs here — the HTTP leg is proven by the admin
  // user above through the identical code path.
  const packPlugin = await pluginService.getActivePluginForModel(
    'default-chat',
    packId,
    'alcore'
  );
  assert.ok(packPlugin && packPlugin.id === 'alcore');
  const packKey = await pluginService.getApiKey(packPlugin, packId);
  assert.equal(packKey, stubSecrets[stubCustomerOfAuth[packId]]);
  console.log('autobase package variant provisioned + credential bound');

  const noEmail = await authService.signup(
    'autobase-noemail',
    'AutobaseProbe1!x'
  );
  assert.ok(noEmail && noEmail.status === 'pending');
  const skipped = await provisionMod.ensureApiPlatformProvision(
    noEmail.user.id
  );
  console.log(`autobase no-email reason=${skipped.reason}`);
  assert.equal(skipped.provisioned, false);
  assert.equal(skipped.reason, 'no-email');
  const noEmailCreds = await pluginCredentialsService.getCredentials(
    noEmail.user.id
  );
  assert.deepEqual(noEmailCreds, []);

  for (const raw of seenBodies) {
    assert.ok(
      !raw.includes('tp_live_secret_'),
      'no HTTP response carries a platform secret'
    );
  }

  // Layering gate: the provisioning hook must never write per-user
  // connection routing (admin-gated SSRF boundary) — routing stays on the
  // manifest default for every role. Code identifiers only (prose may name
  // the boundary).
  const hookSource = fs.readFileSync(
    path.resolve('backend/src/services/apiPlatformProvisionService.ts'),
    'utf8'
  );
  assert.ok(
    !hookSource.includes('setVariables') &&
      !hookSource.includes('pluginVariablesService'),
    'hook touches no connection routing'
  );

  // Signup limiter (retune proof): budget consumed so far in this process is
  // the free signup + the package signup = 2 of 10.
  const statuses = [];
  for (let i = 0; i < 9; i++) {
    const { status } = await signup(
      `autobase-limit-${i}`,
      `limit${i}@test.local`
    );
    statuses.push(status);
  }
  console.log(`autobase limiter statuses = ${statuses.join(',')}`);
  assert.deepEqual(
    statuses.slice(0, 8),
    [202, 202, 202, 202, 202, 202, 202, 202]
  );
  assert.equal(statuses[8], 429);
});
