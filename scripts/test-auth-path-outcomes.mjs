/*
 * Per-product Auth rollout observability for Libre (todo 47).
 *
 * Covers: LIBRE_AUTH_PATH_OUTCOME_ACTION maps the four outcomes to four
 * DISTINCT countable audit actions (same strings as TokenPanel, so the
 * cutover monitor counts uniformly); buildAuthPathDetails carries only
 * path + outcome + reason + emailHash/userId (raw email never stored);
 * recordAuthPathOutcome emits one row per outcome through the existing
 * redacting security-audit pipeline; toggling ALCORE_AUTH_MODE changes zero
 * product records (no login performed, user count identical).
 *
 * Old paths untouched: local login/signup/OAuth behave byte-identically;
 * this suite only reads the additive config/authPath.js module.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-auth-path-'));
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.JWT_SECRET = 'auth-path-test-secret-that-is-long-enough';

const repoRoot = path.resolve(import.meta.dirname, '..');
const importBuilt = file =>
  import(pathToFileURL(path.join(repoRoot, 'backend', 'dist', file)).href);

const [{ userModel }, authPath, audit, database] = await Promise.all([
  importBuilt('models/userModel.js'),
  importBuilt('config/authPath.js'),
  importBuilt('services/securityAuditService.js'),
  importBuilt('db.js'),
]);

test.after(() => {
  database.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('four outcomes map to four distinct countable audit actions', () => {
  const actions = Object.values(authPath.LIBRE_AUTH_PATH_OUTCOME_ACTION);
  assert.equal(new Set(actions).size, 4);
  assert.deepEqual(
    new Set(actions),
    new Set([
      'auth.success',
      'auth.failure',
      'auth.link_conflict',
      'auth.legacy_fallback',
    ])
  );
});

test('details carry only redacted shapes with hashed email', () => {
  const details = authPath.buildAuthPathDetails({
    outcome: 'auth_failure',
    reason: 'auth_path_not_ready',
    email: 'Customer@Example.com',
    userId: 'user-1',
  });
  assert.deepEqual(
    new Set(Object.keys(details)),
    new Set(['path', 'outcome', 'reason', 'emailHash', 'userId'])
  );
  assert.equal(details.path, 'auth');
  assert.match(details.emailHash, /^[0-9a-f]{64}$/);
  const serialized = JSON.stringify(details);
  assert.ok(!serialized.includes('Customer@Example.com'));
  assert.ok(!serialized.includes('customer@example.com'));
  assert.equal(
    authPath.buildAuthPathDetails({
      outcome: 'legacy_fallback',
      reason: 'local_login',
    }).path,
    'local'
  );
});

test('ALCORE_AUTH_MODE toggles without touching product records', async () => {
  const before = (await userModel.getAllUsers()).length;
  const modeProbe = envValue =>
    spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(
          pathToFileURL(
            path.join(repoRoot, 'backend', 'dist', 'config', 'authMode.js')
          ).href
        )}); console.log(m.getAuthMode());`,
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, ALCORE_AUTH_MODE: envValue },
        encoding: 'utf8',
      }
    );
  for (const [value, expected] of [
    ['local', 'local'],
    ['', 'local'],
    ['bogus', 'local'],
    ['alcore', 'alcore'],
  ]) {
    const child = modeProbe(value);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), expected, `ALCORE_AUTH_MODE=${value}`);
  }
  // No login performed anywhere in this suite: the user table is identical.
  const after = (await userModel.getAllUsers()).length;
  assert.equal(after, before);
});

test('each outcome emits exactly one countable redacted audit row', async () => {
  const before = {};
  for (const action of Object.values(authPath.LIBRE_AUTH_PATH_OUTCOME_ACTION)) {
    before[action] = (await audit.queryAuditEvents({ action })).length;
  }
  const usersBefore = (await userModel.getAllUsers()).length;
  authPath.recordAuthPathOutcome({
    outcome: 'auth_success',
    reason: 'auth_login',
    email: 'customer@example.com',
    userId: 'user-1',
  });
  authPath.recordAuthPathOutcome({
    outcome: 'auth_failure',
    reason: 'auth_path_not_ready',
    email: 'customer@example.com',
  });
  authPath.recordAuthPathOutcome({
    outcome: 'auth_link_conflict',
    reason: 'identity_collision_queued',
  });
  authPath.recordAuthPathOutcome({
    outcome: 'legacy_fallback',
    reason: 'local_login',
    email: 'customer@example.com',
    userId: 'user-1',
  });
  // The emit path is deferred (dynamic import) + best-effort: poll briefly.
  const deadline = Date.now() + 10000;
  let rows = [];
  for (;;) {
    rows = [];
    for (const action of Object.values(
      authPath.LIBRE_AUTH_PATH_OUTCOME_ACTION
    )) {
      const found = await audit.queryAuditEvents({ action });
      rows.push(...found.slice(before[action]));
    }
    if (rows.length >= 4 || Date.now() > deadline) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(rows.length, 4);
  const byAction = new Map(rows.map(row => [row.action, row]));
  assert.equal(byAction.size, 4);
  for (const row of rows) {
    const details =
      typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
    assert.deepEqual(
      new Set(Object.keys(details)),
      new Set(
        ['path', 'outcome', 'reason', 'emailHash', 'userId'].filter(
          key => details[key] !== undefined
        )
      )
    );
    const serialized = JSON.stringify(row);
    assert.ok(!serialized.includes('customer@example.com'));
    assert.ok(!serialized.toLowerCase().includes('password'));
    assert.ok(!serialized.toLowerCase().includes('secret'));
    assert.ok(!serialized.includes('Bearer'));
    assert.ok(!serialized.includes('tp_live_'));
    assert.ok(!serialized.includes('tp_mgmt_'));
    assert.ok(!serialized.includes('lwk_'));
  }
  // Outcome emissions write audit rows only: zero product records changed.
  assert.equal((await userModel.getAllUsers()).length, usersBefore);
});
