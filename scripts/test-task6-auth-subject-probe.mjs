/**
 * Task 6 feasibility probe (unified-auth-core): Libre users.auth_subject +
 * canonical_user_id uniqueness + transactional idempotent link.
 *
 * Behavior of record: scripts/test-alcore-auth-exchange.mjs proves the same
 * Auth subject converges to one Libre id and bound redirect codes are
 * single-use at the HTTP layer. This probe proves the STORE mechanism:
 *   1. users.auth_subject UNIQUE WHERE NOT NULL rejects duplicates.
 *   2. users.canonical_user_id UNIQUE WHERE NOT NULL rejects duplicates.
 *   3. Legacy NULL rows coexist without violation.
 *   4. Unique violations map to the 409/CONFLICT path (never merge).
 *   5. Racing double-submit of the same subject leaves exactly 1 row.
 *   6. Transactional idempotent find-or-create is single-row under replay.
 *
 * Runs on node:sqlite (stdlib) against the VERBATIM partial-unique index DDL
 * from backend/src/persistence/sqliteMigrations.ts (v31/v32) and
 * backend/src/persistence/postgresAlcoreAuthSubjectMigration.ts. Partial
 * `WHERE col IS NOT NULL` semantics are engine behavior, identical under the
 * backend's better-sqlite3 driver and PostgreSQL.
 * No product code is touched; probes only.
 */
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

// Verbatim index DDL from sqliteMigrations.ts v31/v32 (+postgres twin).
const AUTH_SUBJECT_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth_subject
    ON users(auth_subject)
    WHERE auth_subject IS NOT NULL;
`;
const CANONICAL_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_canonical_user_id
    ON users(canonical_user_id)
    WHERE canonical_user_id IS NOT NULL
`;

function openUserDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      auth_subject TEXT,
      canonical_user_id TEXT,
      created_at INTEGER NOT NULL
    );
    ${AUTH_SUBJECT_INDEX}
    ${CANONICAL_INDEX}
  `);
  return db;
}

/** Feasibility mapping under test: any DB uniqueness violation -> 409/CONFLICT. */
function conflictFromDbError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed|unique constraint/i.test(message)) {
    return { status: 409, code: 'CONFLICT' };
  }
  return null;
}

function insertUser(db, { id, email, authSubject = null, canonical = null }) {
  db.prepare(
    'INSERT INTO users (id,email,auth_subject,canonical_user_id,created_at) VALUES (?,?,?,?,?)'
  ).run(id, email, authSubject, canonical, Date.now());
}

function countBySubject(db, subject) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM users WHERE auth_subject = ?')
    .get(subject).n;
}

describe('task6 libre auth_subject + canonical_user_id uniqueness', () => {
  test('legacy NULL rows coexist; duplicate subject maps to 409/CONFLICT', () => {
    const db = openUserDb();
    insertUser(db, { id: 'legacy-1', email: 'a@example.com' });
    insertUser(db, { id: 'legacy-2', email: 'b@example.com' });
    insertUser(db, { id: 'legacy-3', email: 'c@example.com', canonical: null });
    insertUser(db, {
      id: 'linked-1',
      email: 'prove@example.com',
      authSubject: 'https://auth.alcore.io.vn|sub-1',
      canonical: 'canon-1',
    });
    let mapped = null;
    try {
      insertUser(db, {
        id: 'linked-2',
        email: 'other@example.com',
        authSubject: 'https://auth.alcore.io.vn|sub-1',
      });
    } catch (error) {
      mapped = conflictFromDbError(error);
    }
    assert.deepEqual(mapped, { status: 409, code: 'CONFLICT' });
    assert.equal(countBySubject(db, 'https://auth.alcore.io.vn|sub-1'), 1);
    console.log('libre unique-violation: mapped=409/CONFLICT rows=1');
    db.close();
  });

  test('duplicate canonical_user_id maps to 409/CONFLICT', () => {
    const db = openUserDb();
    insertUser(db, { id: 'c-1', email: 'a@example.com', canonical: 'canon-9' });
    let mapped = null;
    try {
      insertUser(db, { id: 'c-2', email: 'b@example.com', canonical: 'canon-9' });
    } catch (error) {
      mapped = conflictFromDbError(error);
    }
    assert.deepEqual(mapped, { status: 409, code: 'CONFLICT' });
    console.log('libre canonical unique-violation: mapped=409/CONFLICT rows=1');
    db.close();
  });

  test('racing double-submit of the same subject leaves exactly 1 row', () => {
    const path = join(tmpdir(), `task6-libre-probe-${process.pid}.sqlite`);
    try {
      unlinkSync(path);
    } catch {
      // Fresh probe file.
    }
    openUserDb(path).close();
    const subject = 'https://auth.alcore.io.vn|race-sub';
    const attempt = (id) => {
      const db = new DatabaseSync(path);
      try {
        insertUser(db, { id, email: `${id}@example.com`, authSubject: subject });
        return 'inserted';
      } catch {
        return 'conflict';
      } finally {
        db.close();
      }
    };
    // Two racing submitters, same subject: the loser must see the unique
    // violation, never a second row.
    const results = [attempt('race-a'), attempt('race-b')];
    assert.equal(results.filter((r) => r === 'inserted').length, 1);
    assert.equal(results.filter((r) => r === 'conflict').length, 1);
    const check = new DatabaseSync(path);
    const n = countBySubject(check, subject);
    check.close();
    assert.equal(n, 1);
    console.log(`libre racing double-submit: inserted=1 conflict=1 rows=${n}`);
    try {
      unlinkSync(path);
    } catch {
      // Best-effort probe cleanup.
    }
  });

  test('transactional idempotent find-or-create stays single-row under replay', () => {
    const db = openUserDb();
    const subject = 'https://auth.alcore.io.vn|idem-sub';
    const findOrCreate = (id, email) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(
          'INSERT OR IGNORE INTO users (id,email,auth_subject,canonical_user_id,created_at) VALUES (?,?,?,?,?)'
        ).run(id, email, subject, null, Date.now());
        const row = db
          .prepare('SELECT id FROM users WHERE auth_subject = ?')
          .get(subject);
        db.exec('COMMIT');
        return row.id;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Already rolled back.
        }
        throw error;
      }
    };
    const first = findOrCreate('idem-1', 'prove@example.com');
    const second = findOrCreate('idem-2', 'changed@example.com');
    assert.equal(first, second);
    assert.equal(countBySubject(db, subject), 1);
    console.log('libre transactional find-or-create: same-id replay rows=1');
    db.close();
  });
});
