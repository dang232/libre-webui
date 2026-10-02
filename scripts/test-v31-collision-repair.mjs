/*
 * SQLite v31 migration collision repair (production upgrade crash-loop).
 *
 * Production reached ledger v31 as main's `canonical-auth-identity`
 * (checksum 71afc7d2) while this lane's `alcore-auth-subject` migration also
 * shipped as v31 and never applied. A database in that collided state (ledger
 * claims 31, users table lacks auth_subject) must boot cleanly: the v32
 * `alcore-auth-subject` migration applies the additive DDL and reconciles the
 * ledger. Fresh databases keep booting, reruns are no-ops, user rows are
 * never touched.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

const repoRoot = path.resolve(import.meta.dirname, '..');
const testSource = process.env.LIBRE_OPERATIONAL_TEST_SOURCE === '1';
const backendArtifact = relativePath =>
  pathToFileURL(
    path.join(
      repoRoot,
      'backend',
      testSource ? 'src' : 'dist',
      testSource ? relativePath.replace(/\.js$/, '.ts') : relativePath
    )
  ).href;

process.env.ENCRYPTION_KEY ??= '0'.repeat(64);
process.env.JWT_SECRET ??= 'v31-collision-test-secret-that-is-long-enough';

const CANONICAL_ROW_31 = {
  version: 31,
  name: 'canonical-auth-identity',
  checksum: '71afc7d24fa960eb174c2f5cfd948bb545cd6de2b44b53933a671d8fbc8d79b4',
};

const bootDatabase = dataDir =>
  spawnSync(
    process.execPath,
    [
      ...(testSource ? ['--import', 'tsx'] : []),
      '--input-type=module',
      '-e',
      `const database = await import(${JSON.stringify(
        backendArtifact('db.js')
      )}); database.getDatabase(); database.closeDatabase();`,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, DATA_DIR: dataDir },
      encoding: 'utf8',
    }
  );

const openData = dataDir => new Database(path.join(dataDir, 'data.sqlite'));

const readLedger = db =>
  db
    .prepare(
      'SELECT version, name, checksum FROM _libre_schema_migrations ORDER BY version ASC'
    )
    .all();

const readUserColumns = db => db.prepare('PRAGMA table_info(users)').all();

let dataDir;

test.after(() => {
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('builds the production-collided fixture (ledger 31 canonical, no auth_subject)', () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-v31-collision-'));

  const fresh = bootDatabase(dataDir);
  assert.equal(fresh.status, 0, `${fresh.stderr}\n${fresh.stdout}`);

  const db = openData(dataDir);
  try {
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO users
         (id, username, email, password_hash, role, account_status,
          approved_at, approved_by, avatar, canonical_user_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, 'user', 'active', ?, NULL, NULL, ?, ?, ?)`
    );
    insert.run(
      'v31-user-1',
      'v31_prod_one',
      'one@example.test',
      'x',
      now,
      'canon-user-1',
      now,
      now
    );
    insert.run(
      'v31-user-2',
      'v31_prod_two',
      'two@example.test',
      'x',
      now,
      'canon-user-2',
      now,
      now
    );
    insert.run(
      'v31-user-3',
      'v31_prod_three',
      'three@example.test',
      'x',
      now,
      'canon-user-3',
      now,
      now
    );

    // Reproduce the production incident state: ledger claims v31
    // canonical-auth-identity while the auth_subject DDL was never applied.
    db.exec('DELETE FROM _libre_schema_migrations WHERE version = 32');
    db.exec('DROP INDEX IF EXISTS idx_users_auth_subject');
    db.exec('ALTER TABLE users DROP COLUMN auth_subject');

    const ledger = readLedger(db);
    assert.equal(ledger.length, 31, 'ledger holds versions 1..31 only');
    assert.deepEqual(
      ledger.at(-1),
      CANONICAL_ROW_31,
      'released v31 canonical-auth-identity history is untouched'
    );
    assert.ok(
      ledger.every((row, index) => row.version === index + 1),
      'ledger sequence is contiguous'
    );

    const columns = readUserColumns(db).map(column => column.name);
    assert.ok(
      columns.includes('canonical_user_id'),
      'canonical_user_id survives from v31'
    );
    assert.ok(
      !columns.includes('auth_subject'),
      'auth_subject is absent in the collided state'
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM users WHERE id LIKE 'v31-user-%'"
        )
        .get().count,
      3,
      'all production users survive the fixture build'
    );
  } finally {
    db.close();
  }
});

test('collided fixture boots cleanly and converges to v32', t => {
  assert.ok(dataDir, 'fixture built by the previous test');
  const child = bootDatabase(dataDir);
  assert.equal(
    child.status,
    0,
    `collided DB must boot:\n${child.stderr}\n${child.stdout}`
  );

  const db = openData(dataDir);
  t.after(() => db.close());

  const subject = readUserColumns(db).find(
    column => column.name === 'auth_subject'
  );
  assert.ok(subject, 'v32 applies the auth_subject column');
  assert.equal(subject.notnull, 0, 'column stays nullable for legacy rows');

  const index = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_auth_subject'"
    )
    .get();
  assert.match(index?.sql ?? '', /UNIQUE/i, 'duplicate subjects rejected');
  assert.match(
    index?.sql ?? '',
    /WHERE auth_subject IS NOT NULL/i,
    'sparse index allows multiple NULLs'
  );

  const ledger = readLedger(db);
  assert.equal(ledger.length, 32, 'ledger reconciled to versions 1..32');
  assert.deepEqual(
    ledger.at(-2),
    CANONICAL_ROW_31,
    'v31 canonical-auth-identity row is never rewritten'
  );
  assert.equal(ledger.at(-1)?.version, 32);
  assert.equal(ledger.at(-1)?.name, 'alcore-auth-subject');

  const users = db
    .prepare(
      "SELECT id, canonical_user_id, auth_subject FROM users WHERE id LIKE 'v31-user-%' ORDER BY id ASC"
    )
    .all();
  assert.deepEqual(
    users,
    [
      {
        id: 'v31-user-1',
        canonical_user_id: 'canon-user-1',
        auth_subject: null,
      },
      {
        id: 'v31-user-2',
        canonical_user_id: 'canon-user-2',
        auth_subject: null,
      },
      {
        id: 'v31-user-3',
        canonical_user_id: 'canon-user-3',
        auth_subject: null,
      },
    ],
    'user rows pass through the repair untouched'
  );
});

test('repair rerun is a stable no-op', () => {
  assert.ok(dataDir, 'fixture built by the earlier test');
  const before = openData(dataDir);
  const ledgerBefore = readLedger(before);
  const usersBefore = before
    .prepare(
      "SELECT id, canonical_user_id, auth_subject FROM users WHERE id LIKE 'v31-user-%' ORDER BY id ASC"
    )
    .all();
  before.close();

  const child = bootDatabase(dataDir);
  assert.equal(
    child.status,
    0,
    `rerun must boot:\n${child.stderr}\n${child.stdout}`
  );

  const after = openData(dataDir);
  try {
    assert.deepEqual(
      readLedger(after),
      ledgerBefore,
      'ledger is stable across reruns'
    );
    assert.deepEqual(
      after
        .prepare(
          "SELECT id, canonical_user_id, auth_subject FROM users WHERE id LIKE 'v31-user-%' ORDER BY id ASC"
        )
        .all(),
      usersBefore,
      'users are stable across reruns'
    );
  } finally {
    after.close();
  }
});
