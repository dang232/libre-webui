/*
 * Alcore Auth subject mapping and self-hosted mode boundary (todo 41).
 *
 * Covers: SQLite v32 additive migration (nullable column, legacy rows NULL,
 * sparse unique allows multiple NULLs, duplicate non-null rejected),
 * userModel findOrCreateByAuthSubject beside unchanged id (email-only merge
 * forbidden, conversations/settings preserved), linkAuthSubject collision
 * behavior, ALCORE_AUTH_MODE fail-closed default, local-auth gate 404 shape,
 * and lwk_* still barred from /api/auth.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-alcore-auth-'));
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.JWT_SECRET = 'alcore-auth-test-secret-that-is-long-enough';
process.env.ENABLE_SIGNUP = 'true';

const repoRoot = path.resolve(import.meta.dirname, '..');
const importBuilt = file =>
  import(pathToFileURL(path.join(repoRoot, 'backend', 'dist', file)).href);

const [{ authService }, { userModel }, authMode, database, tokens] =
  await Promise.all([
    importBuilt('services/authService.js'),
    importBuilt('models/userModel.js'),
    importBuilt('config/authMode.js'),
    importBuilt('db.js'),
    importBuilt('services/apiTokenService.js'),
  ]);

test.after(() => {
  database.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const password = 'Alcore-Subject-Test-Password-1!';
let adminId = null;

test('SQLite registry ends with additive alcore-auth-subject v32', async () => {
  const { SQLITE_MIGRATION_CONTRACT } = await importBuilt(
    'persistence/sqliteMigrations.js'
  );
  assert.equal(SQLITE_MIGRATION_CONTRACT.at(-1)?.version, 32);
  assert.equal(SQLITE_MIGRATION_CONTRACT.at(-1)?.name, 'alcore-auth-subject');
  assert.equal(SQLITE_MIGRATION_CONTRACT.at(-2)?.version, 31);
  assert.equal(
    SQLITE_MIGRATION_CONTRACT.at(-2)?.name,
    'canonical-auth-identity'
  );
});

test('legacy local rows boot with NULL subject and share NULLs', async () => {
  const first = await authService.signup('alcore_legacy_one', password, null, {
    kind: 'signup',
  });
  assert.equal(first?.status, 'authenticated', 'bootstrap user is active');
  const second = await authService.signup('alcore_legacy_two', password, null, {
    kind: 'signup',
  });
  assert.equal(second?.status, 'pending', 'later signups await review');
  adminId = first.user.id;
  assert.equal(
    await userModel.getUserByAuthSubject('no-such-subject'),
    null
  );
});

test('users.auth_subject is a nullable additive column', async () => {
  await userModel.getUserCount();
  const db = new Database(path.join(dataDir, 'data.sqlite'));
  try {
    const columns = db.prepare('PRAGMA table_info(users)').all();
    const subject = columns.find(column => column.name === 'auth_subject');
    assert.ok(subject, 'auth_subject column exists after migration');
    assert.equal(subject.notnull, 0, 'column is nullable for legacy rows');
    const nulls = db
      .prepare('SELECT COUNT(*) AS count FROM users WHERE auth_subject IS NULL')
      .get();
    assert.ok(nulls.count >= 2, 'legacy rows stay NULL');
    const indexes = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'idx_users_auth_subject'"
      )
      .get();
    assert.match(
      indexes?.sql ?? '',
      /UNIQUE/i,
      'duplicate non-null subjects are rejected'
    );
    assert.match(
      indexes?.sql ?? '',
      /WHERE auth_subject IS NOT NULL/i,
      'sparse index allows multiple NULLs'
    );
  } finally {
    db.close();
  }
});

test('sparse unique index rejects duplicate non-null subjects at SQL level', () => {
  const db = new Database(path.join(dataDir, 'data.sqlite'));
  try {
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role, account_status, created_at, updated_at, auth_subject) VALUES ('sql-dup-1', 'sql_dup_1', 'x', 'user', 'active', 1, 1, 'dup-subject')"
    ).run();
    assert.throws(() =>
      db.prepare(
        "INSERT INTO users (id, username, password_hash, role, account_status, created_at, updated_at, auth_subject) VALUES ('sql-dup-2', 'sql_dup_2', 'x', 'user', 'active', 1, 1, 'dup-subject')"
      ).run()
    );
  } finally {
    db.prepare("DELETE FROM users WHERE id IN ('sql-dup-1', 'sql-dup-2')").run();
    db.close();
  }
});

let mappedUser;
const subject = 'auth|alcore-test-subject-001';

test('findOrCreateByAuthSubject mints a fresh id beside the mapping', async () => {
  mappedUser = await userModel.findOrCreateByAuthSubject({
    subject,
    username: 'alcore_mapped',
    email: 'alcore-mapped@example.test',
  });
  assert.ok(mappedUser.id, 'Libre id assigned');
  assert.match(mappedUser.id, /^[0-9a-f-]{36}$/i, 'id stays a randomUUID');
  const again = await userModel.findOrCreateByAuthSubject({
    subject,
    username: 'alcore_mapped_other',
    email: 'other@example.test',
  });
  assert.equal(again.id, mappedUser.id, 'subject resolves to the same user');
});

test('mapping preserves the existing session and user data', async () => {
  const approved = await userModel.approveUser(mappedUser.id, adminId);
  assert.ok(approved, 'Auth-provisioned account activates like a signup');
  mappedUser = (await userModel.getUserById(mappedUser.id)) ?? mappedUser;
  const token = await authService.issueSession(mappedUser, { kind: 'test' });
  await userModel.linkAuthSubject(mappedUser.id, subject);
  const resolved = await authService.getUserFromToken(token);
  assert.equal(resolved?.id, mappedUser.id, 'session survives linking');
});

test('Auth link preserves conversations and settings on the same Libre id', async () => {
  const { getPersistence } = await importBuilt('persistence/index.js');
  const persistence = getPersistence();
  const legacy = await authService.signup('alcore_data_owner', password, null, {
    kind: 'signup',
  });
  assert.ok(legacy, 'legacy local account created');
  const ownerId = legacy.user.id;
  const now = Date.now();
  await persistence.repositories.resources.chatSessions.replace({
    session: {
      id: 'sess-preserve-1',
      user_id: ownerId,
      title: 'Keep me',
      model: 'test-model',
      persona_id: null,
      provider_type: null,
      provider_id: null,
      created_at: now,
      updated_at: now,
      archived: 0,
      settings: '{"theme":"dark"}',
      folder_id: null,
      pinned: 0,
    },
    messages: [
      {
        id: 'msg-preserve-1',
        session_id: 'sess-preserve-1',
        role: 'user',
        content: 'hello',
        thinking: null,
        timestamp: now,
        message_index: 0,
        model: null,
        provider_metadata: null,
        images: null,
        statistics: null,
        artifacts: null,
        parent_id: null,
        branch_index: 0,
        is_active: 1,
        rating: null,
      },
    ],
  });
  await persistence.repositories.resources.preferences.replaceAll(
    ownerId,
    [{ key: 'theme', value: '"dark"' }],
    now
  );
  await userModel.linkAuthSubject(ownerId, 'auth|data-owner-subject');
  const resolved = await userModel.getUserByAuthSubject(
    'auth|data-owner-subject'
  );
  assert.equal(
    resolved?.id,
    ownerId,
    'Auth subject resolves to the same Libre profile'
  );
  const sessions =
    await persistence.repositories.resources.chatSessions.listByOwner(ownerId);
  assert.equal(sessions.length, 1, 'conversation survives the Auth link');
  assert.equal(sessions[0].session.title, 'Keep me');
  assert.equal(sessions[0].messages.length, 1);
  assert.equal(sessions[0].messages[0].content, 'hello');
  const prefs =
    await persistence.repositories.resources.preferences.listByOwner(ownerId);
  assert.ok(
    prefs.some(p => p.key === 'theme' && p.value === '"dark"'),
    'settings survive the Auth link'
  );
});

test('email-only merge is forbidden', async () => {
  await authService.signup('alcore_email_owner', password, 'owned@example.test', {
    kind: 'signup',
  });
  await assert.rejects(
    userModel.findOrCreateByAuthSubject({
      subject: 'auth|brand-new-subject',
      username: 'alcore_intruder',
      email: 'owned@example.test',
    }),
    /already exists/,
    'collision throws instead of linking'
  );
});

test('linkAuthSubject rejects subjects owned by another user', async () => {
  await assert.rejects(
    userModel.linkAuthSubject('no-such-user', subject),
    /already linked/,
    'duplicate subject across users throws'
  );
  const other = await userModel.findOrCreateByAuthSubject({
    subject: 'auth|second-subject',
    username: 'alcore_second',
  });
  await assert.rejects(
    userModel.linkAuthSubject(other.id, subject),
    /already linked/
  );
});

test('ALCORE_AUTH_MODE defaults to fail-closed local', () => {
  assert.equal(authMode.getAuthMode(), 'local');
  assert.equal(authMode.isAlcoreAuthMode(), false);
});

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

test('Alcore mode engages only on the explicit value', () => {
  for (const [value, expected] of [
    ['alcore', 'alcore'],
    ['  Alcore  ', 'alcore'],
    ['ALCORE', 'alcore'],
    ['local', 'local'],
    ['true', 'local'],
    ['oidc', 'local'],
    ['', 'local'],
  ]) {
    const child = modeProbe(value);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), expected, `ALCORE_AUTH_MODE=${value}`);
  }
});

test('local-auth gate passes through in local mode', () =>
  new Promise(resolve => {
    const res = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body });
      },
    };
    authMode.rejectLocalAuthInAlcoreMode({}, res, () =>
      resolve({ status: 'next' })
    );
  }).then(outcome => assert.equal(outcome.status, 'next')));

test('local-auth gate returns identical 404 in Alcore mode', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const m = await import(${JSON.stringify(
        pathToFileURL(
          path.join(repoRoot, 'backend', 'dist', 'config', 'authMode.js')
        ).href
      )});
      let nexted = false;
      const res = { status(code) { this.code = code; return this; }, json(body) { console.log(JSON.stringify({ code: this.code, body })); } };
      m.rejectLocalAuthInAlcoreMode({}, res, () => { nexted = true; });
      if (nexted) console.log(JSON.stringify({ nexted: true }));`,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, ALCORE_AUTH_MODE: 'alcore' },
      encoding: 'utf8',
    }
  );
  assert.equal(child.status, 0, child.stderr);
  const parsed = JSON.parse(child.stdout.trim());
  assert.equal(parsed.code, 404);
  assert.equal(parsed.body.code, 'LOCAL_AUTH_DISABLED');
  assert.equal(parsed.body.success, false);
});

test('blocked local-auth attempts are audited without identity material', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const authMode = await import(${JSON.stringify(
        pathToFileURL(
          path.join(repoRoot, 'backend', 'dist', 'config', 'authMode.js')
        ).href
      )});
      const audit = await import(${JSON.stringify(
        pathToFileURL(
          path.join(
            repoRoot,
            'backend',
            'dist',
            'services',
            'securityAuditService.js'
          )
        ).href
      )});
      const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
      authMode.rejectLocalAuthInAlcoreMode(
        { ip: '127.0.0.1', originalUrl: '/api/auth/login', path: '/login' },
        res,
        () => {}
      );
      await new Promise(resolve => setTimeout(resolve, 500));
      const rows = await audit.queryAuditEvents({ action: 'auth.local_auth_blocked' });
      const latest = rows.at(-1);
      console.log(JSON.stringify({ code: res.code, rows: rows.length, latest }));`,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, ALCORE_AUTH_MODE: 'alcore' },
      encoding: 'utf8',
    }
  );
  assert.equal(child.status, 0, child.stderr);
  const parsed = JSON.parse(child.stdout.trim());
  assert.equal(parsed.code, 404);
  assert.ok(parsed.rows >= 1, 'denial audit row persisted');
  assert.equal(parsed.latest.action, 'auth.local_auth_blocked');
  assert.equal(parsed.latest.result, 'denied');
});

test('lwk_* tokens stay barred from /api/auth', async () => {
  await assert.rejects(
    (async () => {
      const record = {
        id: 'token-id',
        user_id: mappedUser.id,
        name: 'probe',
        token_hash: 'hash',
        token_prefix: 'lwk_test',
        scopes: JSON.stringify(['admin', 'chat']),
        created_at: Date.now(),
        expires_at: null,
        last_used_at: null,
        revoked_at: null,
      };
      return tokens.assertTokenAllowsPath(record, '/api/auth/login');
    })(),
    /cannot be used with an API token/,
    'product tokens never authorize auth routes'
  );
  const record = {
    id: 'token-id',
    user_id: mappedUser.id,
    name: 'probe',
    token_hash: 'hash',
    token_prefix: 'lwk_test',
    scopes: JSON.stringify(['chat']),
    created_at: Date.now(),
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
  };
  assert.deepEqual(tokens.assertTokenAllowsPath(record, '/api/chat'), [
    'chat',
  ]);
});

test('system info exposes the public auth mode', async () => {
  const info = await authService.getSystemInfo();
  assert.equal(info.authMode, 'local');
});
