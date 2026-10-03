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

/**
 * Auth-subject backfill (unified-auth-core todo 20): apply an explicit
 * admin-mapped set of `users.id -> issuer|subject` pairs with raw queries,
 * on both engines (sqlite `?` placeholders, postgres `$n` placeholders).
 *
 * Eligibility is fail-closed and never email-based — this module has no
 * email input at all. A mapping entry is applied ONLY when:
 * - the row exists and its `auth_subject` is currently NULL, and
 * - the canonical subject is not already owned by another row.
 * Everything else is reported, never forced:
 * - `already_linked` — row already carries this exact subject (no write,
 *   so re-runs are idempotent with zero new writes);
 * - `queued_held` — row already carries a DIFFERENT subject (never
 *   overwrite; needs admin/claim judgment, owned by the todo-19 lane);
 * - `queued_taken` — subject is owned by another row (never steal; the
 *   loser of a concurrent backfill lands here via re-resolve, so two
 *   concurrent runs perform a single write);
 * - `queued_missing` — admin userId matches no row;
 * - `skipped_invalid` — empty userId or malformed `issuer|subject` pair
 *   (operator input error, fail closed).
 *
 * The guarded `UPDATE ... WHERE auth_subject IS NULL` plus the sparse
 * unique `idx_users_auth_subject` (sqlite v32, postgres v31) make the
 * write atomic per row: a lost race surfaces as zero changed rows and is
 * re-resolved to `already_linked`/`queued_*`, never a second row and never
 * an overwrite. Snapshot diffs therefore contain only `null -> subject`
 * transitions; any other delta fails the reconciliation gate (merges 0).
 *
 * This module is intentionally a persistence leaf: it imports only the
 * canonical subject normalizer. It never touches userModel,
 * alcoreAuthService, or routes (those are owned by sibling lanes).
 */

import { normalizeAuthSubject } from '../config/authMode.js';

export type AuthSubjectBackfillDialect = 'sqlite' | 'postgres';

export interface AuthSubjectBackfillMapping {
  readonly userId: string;
  readonly authSubject: string;
}

export type AuthSubjectBackfillDecision =
  | 'linked'
  | 'already_linked'
  | 'queued_held'
  | 'queued_taken'
  | 'queued_missing'
  | 'skipped_invalid';

export interface AuthSubjectBackfillRowResult {
  readonly userId: string;
  readonly authSubject: string | null;
  readonly decision: AuthSubjectBackfillDecision;
  readonly reason: string;
  readonly writes: 0 | 1;
}

export interface AuthSubjectBackfillReport {
  readonly runId: string;
  readonly dialect: AuthSubjectBackfillDialect;
  readonly rows: readonly AuthSubjectBackfillRowResult[];
  readonly linked: number;
  readonly alreadyLinked: number;
  readonly queued: number;
  readonly skipped: number;
  readonly writes: number;
}

export interface AuthSubjectBackfillSnapshotRow {
  readonly userId: string;
  readonly authSubject: string | null;
}

/**
 * Minimal raw-query port. Adapters wrap better-sqlite3 (`?`) or node-pg
 * (`$n`); the runner only ever emits SELECT-by-id, SELECT-by-subject, the
 * guarded UPDATE, and full-table SELECT/COUNT reads for snapshot and
 * reconciliation.
 */
export interface RawAuthSubjectBackfillConnection {
  readonly dialect: AuthSubjectBackfillDialect;
  all(
    text: string,
    params: readonly unknown[]
  ): Promise<Array<Record<string, unknown>>>;
  run(text: string, params: readonly unknown[]): Promise<number>;
}

const placeholder = (
  dialect: AuthSubjectBackfillDialect,
  index: number
): string => (dialect === 'postgres' ? `$${index}` : '?');

const SELECT_BY_ID = (dialect: AuthSubjectBackfillDialect): string =>
  `SELECT id, auth_subject FROM users WHERE id = ${placeholder(dialect, 1)}`;

const SELECT_BY_SUBJECT = (dialect: AuthSubjectBackfillDialect): string =>
  `SELECT id, auth_subject FROM users WHERE auth_subject = ${placeholder(
    dialect,
    1
  )}`;

const UPDATE_LINK = (dialect: AuthSubjectBackfillDialect): string =>
  `UPDATE users SET auth_subject = ${placeholder(
    dialect,
    1
  )} WHERE id = ${placeholder(dialect, 2)} AND auth_subject IS NULL`;

export const LIST_AUTH_SUBJECT_SNAPSHOT_SQL =
  'SELECT id, auth_subject FROM users ORDER BY id';

export const COUNT_USERS_SQL = 'SELECT COUNT(*) AS count FROM users';

export const COUNT_MAPPED_SQL =
  'SELECT COUNT(*) AS count FROM users WHERE auth_subject IS NOT NULL';

const toId = (row: Record<string, unknown>): string => String(row.id);

const toSubject = (row: Record<string, unknown>): string | null => {
  const value = row.auth_subject;
  return typeof value === 'string' ? value : null;
};

const toCount = (row: Record<string, unknown>): number =>
  Number(row.count ?? 0);

export const runAuthSubjectBackfill = async (
  connection: RawAuthSubjectBackfillConnection,
  mappings: readonly AuthSubjectBackfillMapping[],
  runId: string
): Promise<AuthSubjectBackfillReport> => {
  if (runId.trim().length === 0 || runId.length > 128) {
    throw new Error('runId must be 1-128 characters');
  }
  const { dialect } = connection;
  const selectById = SELECT_BY_ID(dialect);
  const selectBySubject = SELECT_BY_SUBJECT(dialect);
  const updateLink = UPDATE_LINK(dialect);
  const rows: AuthSubjectBackfillRowResult[] = [];

  for (const mapping of mappings) {
    const userId = mapping.userId.trim();
    if (!userId) {
      rows.push({
        userId: mapping.userId,
        authSubject: null,
        decision: 'skipped_invalid',
        reason: 'empty_user_id',
        writes: 0,
      });
      continue;
    }
    const canonical = normalizeAuthSubject(mapping.authSubject);
    if (!canonical) {
      rows.push({
        userId,
        authSubject: null,
        decision: 'skipped_invalid',
        reason: 'malformed_subject',
        writes: 0,
      });
      continue;
    }
    const current = (await connection.all(selectById, [userId]))[0] ?? null;
    if (!current) {
      rows.push({
        userId,
        authSubject: canonical,
        decision: 'queued_missing',
        reason: 'no_such_user',
        writes: 0,
      });
      continue;
    }
    const held = toSubject(current);
    if (held === canonical) {
      rows.push({
        userId,
        authSubject: canonical,
        decision: 'already_linked',
        reason: 'same_subject',
        writes: 0,
      });
      continue;
    }
    if (held !== null) {
      rows.push({
        userId,
        authSubject: canonical,
        decision: 'queued_held',
        reason: 'row_already_linked',
        writes: 0,
      });
      continue;
    }
    const owners = await connection.all(selectBySubject, [canonical]);
    if (owners.some(owner => toId(owner) !== userId)) {
      rows.push({
        userId,
        authSubject: canonical,
        decision: 'queued_taken',
        reason: 'subject_owned_by_other',
        writes: 0,
      });
      continue;
    }
    const changes = await connection.run(updateLink, [canonical, userId]);
    if (changes === 1) {
      rows.push({
        userId,
        authSubject: canonical,
        decision: 'linked',
        reason: 'null_row_linked',
        writes: 1,
      });
      continue;
    }
    // Lost a concurrent write: re-resolve instead of forcing. The winner
    // converged (already_linked) or owns a genuine conflict (queued_*).
    const reread = (await connection.all(selectById, [userId]))[0] ?? null;
    const nowHeld = reread ? toSubject(reread) : null;
    if (nowHeld === canonical) {
      rows.push({
        userId,
        authSubject: canonical,
        decision: 'already_linked',
        reason: 'race_converged',
        writes: 0,
      });
      continue;
    }
    const reowners = await connection.all(selectBySubject, [canonical]);
    if (reowners.some(owner => toId(owner) !== userId)) {
      rows.push({
        userId,
        authSubject: canonical,
        decision: 'queued_taken',
        reason: 'race_owner_changed',
        writes: 0,
      });
      continue;
    }
    rows.push({
      userId,
      authSubject: canonical,
      decision: nowHeld !== null ? 'queued_held' : 'queued_missing',
      reason: 'update_not_applied',
      writes: 0,
    });
  }

  return {
    runId,
    dialect,
    rows,
    linked: rows.filter(row => row.decision === 'linked').length,
    alreadyLinked: rows.filter(row => row.decision === 'already_linked').length,
    queued: rows.filter(row => row.decision.startsWith('queued')).length,
    skipped: rows.filter(row => row.decision === 'skipped_invalid').length,
    writes: rows.reduce((sum, row) => sum + row.writes, 0),
  };
};

export const listAuthSubjectSnapshot = async (
  connection: RawAuthSubjectBackfillConnection
): Promise<AuthSubjectBackfillSnapshotRow[]> => {
  const rows = await connection.all(LIST_AUTH_SUBJECT_SNAPSHOT_SQL, []);
  return rows.map(row => ({ userId: toId(row), authSubject: toSubject(row) }));
};

export interface AuthSubjectSnapshotDiff {
  readonly userId: string;
  readonly before: string | null;
  readonly after: string | null;
}

/**
 * Diff two snapshots. The reconciliation gate allows ONLY
 * `null -> subject` transitions; any other delta (overwrite, move, or
 * clear) is returned in `illegal` and must FAIL the gate (merges 0).
 */
export const diffAuthSubjectSnapshots = (
  before: readonly AuthSubjectBackfillSnapshotRow[],
  after: readonly AuthSubjectBackfillSnapshotRow[]
): {
  deltas: AuthSubjectSnapshotDiff[];
  illegal: AuthSubjectSnapshotDiff[];
} => {
  const beforeById = new Map(before.map(row => [row.userId, row.authSubject]));
  const afterById = new Map(after.map(row => [row.userId, row.authSubject]));
  const deltas: AuthSubjectSnapshotDiff[] = [];
  for (const [userId, next] of afterById) {
    const prev = beforeById.has(userId)
      ? (beforeById.get(userId) ?? null)
      : null;
    if (prev !== next) deltas.push({ userId, before: prev, after: next });
  }
  const illegal = deltas.filter(delta => delta.before !== null);
  return { deltas, illegal };
};

export interface AuthSubjectReconciliation {
  readonly total: number;
  readonly mapped: number;
  readonly unmapped: number;
}

/** Raw-count reconciliation: total = mapped + unmapped, always. */
export const reconcileAuthSubjectCounts = async (
  connection: RawAuthSubjectBackfillConnection
): Promise<AuthSubjectReconciliation> => {
  const [totalRows, mappedRows] = await Promise.all([
    connection.all(COUNT_USERS_SQL, []),
    connection.all(COUNT_MAPPED_SQL, []),
  ]);
  const total = toCount(totalRows[0] ?? {});
  const mapped = toCount(mappedRows[0] ?? {});
  return { total, mapped, unmapped: total - mapped };
};
