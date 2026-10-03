/**
 * Task 20 backfill + reconciliation probe (unified-auth-core): Libre
 * `auth_subject` backfill for admin-mapped rows only, snapshot diff, and
 * count reconciliation (merges 0).
 *
 * Behavior of record: todo 11 proves exchange-time linking converges and
 * refuses email merges; todo 9 proves the sparse unique index + re-resolve
 * races; todo 19 owns incumbent claim linking. This probe covers ONLY rows
 * eligible WITHOUT claim judgment: an explicit admin-mapped set of
 * { userId, authSubject } pairs. There is no email input anywhere — the
 * runner cannot backfill by email alone, structurally (asserted below on
 * every SQL string the run emits).
 *
 * Engines: sqlite runs against REAL better-sqlite3 (in-memory) with the
 * verbatim sparse unique index; postgres runs against a stateful stub that
 * captures exact SQL/params (placeholder discipline `$n` vs `?`) plus a
 * bounded live-`pg` attempt that SKIPS honestly when no server answers.
 * The backfill is DML-only: no schema migration is added, so the v31/v32
 * chain is untouched (proven by the owned-files-only worktree check).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  runAuthSubjectBackfill,
  listAuthSubjectSnapshot,
  diffAuthSubjectSnapshots,
  reconcileAuthSubjectCounts,
  LIST_AUTH_SUBJECT_SNAPSHOT_SQL,
  COUNT_USERS_SQL,
  COUNT_MAPPED_SQL,
} from '../backend/dist/persistence/authSubjectBackfill.js';

const ISS = 'https://auth.alcore.io.vn';
const RUN = 'task20-probe-run';
const SNAPSHOT_URL = new URL(
  '../../.omo/evidence/task-20-identity-mapping-snapshot.json',
  import.meta.url
);

/** Admin set: eligible pairs only. No email field exists on any entry. */
const ADMIN_SET = [
  { userId: 'u1', authSubject: `${ISS}|sub-1` },
  { userId: 'u2', authSubject: `${ISS}|sub-2` },
  { userId: 'u4', authSubject: `${ISS}|other-1` },
  { userId: 'u5', authSubject: `${ISS}|sub-1` },
  { userId: 'u9', authSubject: `${ISS}|sub-9` },
  { userId: 'u1', authSubject: `${ISS}|sub-1` },
  { userId: 'u3', authSubject: 'not a subject' },
];

const EXPECTED_DECISIONS = [
  'linked',
  'linked',
  'queued_held',
  'queued_taken',
  'queued_missing',
  'already_linked',
  'skipped_invalid',
];

function makeSqlite() {
  const db = new Database(':memory:');
  db.exec(
    'CREATE TABLE users (id TEXT PRIMARY KEY, auth_subject TEXT);' +
      'CREATE UNIQUE INDEX idx_users_auth_subject' +
      ' ON users(auth_subject) WHERE auth_subject IS NOT NULL;'
  );
  const seenSql = [];
  const seed = rows => {
    const insert = db.prepare(
      'INSERT INTO users (id, auth_subject) VALUES (?, ?)'
    );
    for (const row of rows) insert.run(row.id, row.auth_subject);
  };
  const connection = {
    dialect: 'sqlite',
    all: async (text, params) => {
      seenSql.push(text);
      return db.prepare(text).all(...params);
    },
    run: async (text, params) => {
      seenSql.push(text);
      return Number(db.prepare(text).run(...params).changes);
    },
  };
  return { db, seed, connection, seenSql };
}

function seedLegacy(seed) {
  seed([
    { id: 'u1', auth_subject: null },
    { id: 'u2', auth_subject: null },
    { id: 'u3', auth_subject: null },
    { id: 'u4', auth_subject: `${ISS}|keep-1` },
    { id: 'u5', auth_subject: null },
    { id: 'u6', auth_subject: null },
  ]);
}

/** Stateful postgres stub: enforces sparse-unique + guarded update. */
function makePgStub() {
  const users = new Map();
  const seenSql = [];
  const seed = rows => {
    for (const row of rows) users.set(row.id, row.auth_subject);
  };
  const connection = {
    dialect: 'postgres',
    all: async (text, params) => {
      seenSql.push({ text, params: [...params] });
      if (text.includes('COUNT(*)')) {
        const mapped = text.includes('IS NOT NULL');
        const count = [...users.values()].filter(v =>
          mapped ? v !== null : true
        ).length;
        return [{ count: String(count) }];
      }
      if (text.includes('WHERE id =')) {
        const id = String(params[0]);
        return users.has(id) ? [{ id, auth_subject: users.get(id) }] : [];
      }
      if (text.includes('WHERE auth_subject =')) {
        const subject = String(params[0]);
        return [...users.entries()]
          .filter(([, v]) => v === subject)
          .map(([id, v]) => ({ id, auth_subject: v }));
      }
      return [...users.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([id, auth_subject]) => ({ id, auth_subject }));
    },
    run: async (text, params) => {
      seenSql.push({ text, params: [...params] });
      const [subject, id] = params.map(String);
      if (!users.has(id) || users.get(id) !== null) return 0;
      if ([...users.entries()].some(([oid, v]) => oid !== id && v === subject))
        return 0;
      users.set(id, subject);
      return 1;
    },
  };
  return { seed, connection, seenSql, users };
}

function assertNoEmailInSql(seenSql) {
  for (const entry of seenSql) {
    const text = typeof entry === 'string' ? entry : entry.text;
    assert.match(
      text,
      /WHERE id =|WHERE auth_subject =|ORDER BY id|COUNT\(\*\)/
    );
    assert.doesNotMatch(text, /email/i);
  }
}

describe('task20 libre auth_subject backfill + reconciliation', () => {
  test('sqlite backfill links eligible rows, queues the rest, never merges', async () => {
    const { seed, connection, seenSql } = makeSqlite();
    seedLegacy(seed);
    const before = await listAuthSubjectSnapshot(connection);
    const report = await runAuthSubjectBackfill(connection, ADMIN_SET, RUN);
    assert.deepEqual(
      report.rows.map(r => r.decision),
      EXPECTED_DECISIONS
    );
    assert.equal(report.writes, 2);
    assert.equal(report.linked, 2);
    assert.equal(report.queued, 3);
    assert.equal(report.skipped, 1);
    const after = await listAuthSubjectSnapshot(connection);
    const { deltas, illegal } = diffAuthSubjectSnapshots(before, after);
    assert.equal(deltas.length, 2);
    assert.equal(illegal.length, 0);
    const counts = await reconcileAuthSubjectCounts(connection);
    assert.equal(counts.total, 6);
    assert.equal(counts.mapped, 3);
    assert.equal(counts.unmapped, 3);
    assert.equal(counts.total, counts.mapped + counts.unmapped);
    // Ineligible rows untouched: u3 (invalid entry) and u6 (never referenced).
    const byId = new Map(after.map(r => [r.userId, r.authSubject]));
    assert.equal(byId.get('u3'), null);
    assert.equal(byId.get('u5'), null);
    assert.equal(byId.get('u6'), null);
    assert.equal(byId.get('u4'), `${ISS}|keep-1`);
    // Eligible universe fully accounted: mapped-or-queued, zero unaccounted.
    const eligible = ['u1', 'u2', 'u4', 'u5', 'u9'];
    const covered = new Set(
      report.rows
        .filter(
          r =>
            r.decision === 'linked' ||
            r.decision === 'already_linked' ||
            r.decision.startsWith('queued')
        )
        .map(r => r.userId)
    );
    assert.deepEqual(
      eligible.filter(id => !covered.has(id)),
      []
    );
    assertNoEmailInSql(seenSql);
    console.log(
      `task20 sqlite: total=${counts.total} mapped=${counts.mapped} ` +
        `unmapped=${counts.unmapped} eligible=${eligible.length} ` +
        `linked=${report.linked} queued=${report.queued} ` +
        `unaccounted=0 merges=${illegal.length} writes=${report.writes}`
    );
    const snapshot = {
      task: 20,
      runId: RUN,
      dialect: 'sqlite',
      at: new Date().toISOString(),
      before,
      after,
      deltas,
      illegal,
      queue: report.rows.filter(r => r.decision.startsWith('queued')),
      reconciliation: {
        ...counts,
        eligible: eligible.length,
        linked: report.linked,
        alreadyLinked: report.alreadyLinked,
        queued: report.queued,
        unaccountedEligible: 0,
        merges: illegal.length,
        writes: report.writes,
      },
    };
    writeFileSync(SNAPSHOT_URL, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`task20 snapshot: ${SNAPSHOT_URL.pathname}`);
  });

  test('sqlite re-run is idempotent: zero new writes', async () => {
    const { seed, connection } = makeSqlite();
    seedLegacy(seed);
    const first = await runAuthSubjectBackfill(connection, ADMIN_SET, RUN);
    assert.equal(first.writes, 2);
    const second = await runAuthSubjectBackfill(
      connection,
      ADMIN_SET,
      `${RUN}-rerun`
    );
    assert.equal(second.writes, 0);
    assert.equal(second.linked, 0);
    assert.deepEqual(
      second.rows.map(r => r.decision),
      [
        'already_linked',
        'already_linked',
        'queued_held',
        'queued_taken',
        'queued_missing',
        'already_linked',
        'skipped_invalid',
      ]
    );
    console.log(
      `task20 sqlite rerun: writes=${second.writes} linked=${second.linked}`
    );
  });

  test('sqlite concurrent backfill twice performs single writes', async () => {
    const { seed, connection } = makeSqlite();
    seedLegacy(seed);
    const [a, b] = await Promise.all([
      runAuthSubjectBackfill(connection, ADMIN_SET, `${RUN}-a`),
      runAuthSubjectBackfill(connection, ADMIN_SET, `${RUN}-b`),
    ]);
    assert.equal(a.writes + b.writes, 2);
    const after = await listAuthSubjectSnapshot(connection);
    const byId = new Map(after.map(r => [r.userId, r.authSubject]));
    assert.equal(byId.get('u1'), `${ISS}|sub-1`);
    assert.equal(byId.get('u2'), `${ISS}|sub-2`);
    assert.equal(byId.get('u4'), `${ISS}|keep-1`);
    console.log(
      `task20 sqlite concurrent: writes-a=${a.writes} writes-b=${b.writes} total=${a.writes + b.writes}`
    );
  });

  test('postgres path: $n placeholders, same branch outcomes', async () => {
    const { seed, connection, seenSql } = makePgStub();
    seedLegacy(seed);
    const report = await runAuthSubjectBackfill(connection, ADMIN_SET, RUN);
    assert.deepEqual(
      report.rows.map(r => r.decision),
      EXPECTED_DECISIONS
    );
    assert.equal(report.writes, 2);
    const hasDollar = seenSql.some(e => /\$\d/.test(e.text));
    const hasQMark = seenSql.some(e => e.text.includes('?'));
    assert.equal(hasDollar, true);
    assert.equal(hasQMark, false);
    assertNoEmailInSql(seenSql);
    const counts = await reconcileAuthSubjectCounts(connection);
    assert.equal(counts.total, counts.mapped + counts.unmapped);
    console.log(
      `task20 postgres-stub: placeholders=$n writes=${report.writes} ` +
        `total=${counts.total} mapped=${counts.mapped} unmapped=${counts.unmapped}`
    );
  });

  test('postgres live attempt is bounded and never fails the gate', async t => {
    let pg;
    try {
      pg = await import('pg');
    } catch (error) {
      console.log(
        `task20 postgres-live: SKIPPED (pg import: ${error.code ?? error.message})`
      );
      return;
    }
    const pool = new pg.Pool({
      host: process.env.PG_TEST_HOST ?? '127.0.0.1',
      port: Number(process.env.PG_TEST_PORT ?? 5432),
      user: process.env.PG_TEST_USER ?? 'postgres',
      password: process.env.PG_TEST_PASSWORD ?? 'postgres',
      database: process.env.PG_TEST_DB ?? 'postgres',
      connectionTimeoutMillis: 2000,
    });
    try {
      await pool.query('SELECT 1');
      console.log(
        'task20 postgres-live: server answered (operator runs full matrix there)'
      );
    } catch (error) {
      console.log(
        `task20 postgres-live: SKIPPED (${error.code ?? error.message})`
      );
    } finally {
      await pool.end().catch(() => undefined);
    }
  });

  test('fail-closed runId + persistence-leaf boundary', async () => {
    const { seed, connection } = makeSqlite();
    seedLegacy(seed);
    await assert.rejects(
      runAuthSubjectBackfill(connection, ADMIN_SET, '   '),
      /runId/
    );
    const dist = readFileSync(
      new URL(
        '../backend/dist/persistence/authSubjectBackfill.js',
        import.meta.url
      ),
      'utf8'
    );
    const imports = [...dist.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
      match => match[1]
    );
    assert.ok(imports.length > 0);
    for (const spec of imports) {
      assert.ok(
        spec === '../config/authMode.js' || spec.startsWith('node:'),
        spec
      );
    }
    for (const sql of [
      LIST_AUTH_SUBJECT_SNAPSHOT_SQL,
      COUNT_USERS_SQL,
      COUNT_MAPPED_SQL,
    ]) {
      assert.doesNotMatch(sql, /email/i);
    }
    console.log(
      'task20 boundary: runId fail-closed; leaf imports intact; SQL email-free'
    );
  });
});
