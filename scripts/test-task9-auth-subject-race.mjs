/**
 * Task 9 cross-store uniqueness probe (unified-auth-core): Libre
 * findOrCreateByAuthSubject / linkAuthSubject deterministic lookup-before-
 * create with the sparse `idx_users_auth_subject` unique index as backstop.
 *
 * Behavior of record: scripts/test-alcore-auth-exchange.mjs proves the same
 * subject converges to one Libre id at the HTTP layer; the task 6 probe
 * proves the partial-unique index rejects duplicate subjects at the SQL
 * layer. This probe drives the REAL UserModel (compiled backend/dist) with
 * a stateful in-memory persistence stand-in that enforces the SAME sparse
 * uniques verbatim-style (`UNIQUE constraint failed: users.<column>`,
 * better-sqlite3 wording) and proves the todo 9 catch/re-resolve:
 *   1. Concurrent same-subject provisioning converges to one id, 1 row,
 *      no orphan NULL-subject row (subject rides the INSERT).
 *   2. A stale-read loser re-resolves to the winner (unique violation ->
 *      converge, never a second row).
 *   3. linkAuthSubject race-loss throws the already-linked denial whose
 *      wording matches the alcoreAuthService 409 regex
 *      (/already exists|already linked/i, alcoreAuthService.ts:258) ->
 *      route 409 AUTH_LINK_CONFLICT (routes/alcoreAuth.ts exchange catch).
 *   4. Same-user re-link stays a no-op; email-twin race keeps the
 *      email-collision denial (never merge).
 */
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { UserModel } from '../backend/dist/models/userModel.js';

const SERVICE_CONFLICT_REGEX = /already exists|already linked/i;
const SUBJECT = 'https://auth.alcore.io.vn|task9-sub-1';

/** Stateful stand-in enforcing the product sparse uniques verbatim-style. */
function makePersistence() {
  const users = new Map();
  const state = { staleSubjectReads: 0, staleEmailReads: 0 };
  const toStored = row => ({ ...row });
  const identity = {
    findPublicById: async id => {
      const u = users.get(id);
      return u ? toStored(u) : null;
    },
    findByUsername: async username =>
      [...users.values()].find(u => u.username === username) ?? null,
    findByAuthSubject: async subject => {
      if (state.staleSubjectReads > 0) {
        state.staleSubjectReads -= 1;
        return null;
      }
      return [...users.values()].find(u => u.auth_subject === subject) ?? null;
    },
    emailExists: async email => {
      if (state.staleEmailReads > 0) {
        state.staleEmailReads -= 1;
        return false;
      }
      return [...users.values()].some(u => u.email === email);
    },
    usernameExists: async username =>
      [...users.values()].some(u => u.username === username),
    countRealUsers: () => users.size,
    insert: user => {
      if (
        user.auth_subject !== null &&
        user.auth_subject !== undefined &&
        [...users.values()].some(u => u.auth_subject === user.auth_subject)
      ) {
        throw new Error('UNIQUE constraint failed: users.auth_subject');
      }
      if (
        user.email !== null &&
        user.email !== undefined &&
        [...users.values()].some(u => u.email === user.email)
      ) {
        throw new Error('UNIQUE constraint failed: users.email_lookup');
      }
      if ([...users.values()].some(u => u.username === user.username)) {
        throw new Error('UNIQUE constraint failed: users.username');
      }
      users.set(user.id, toStored(user));
    },
    update: async (id, update) => {
      const u = users.get(id);
      if (!u) return false;
      if (update.authSubject !== undefined) {
        const clash = [...users.values()].some(
          o => o.id !== id && o.auth_subject === update.authSubject
        );
        if (clash)
          throw new Error('UNIQUE constraint failed: users.auth_subject');
        u.auth_subject = update.authSubject;
      }
      return true;
    },
  };
  const persistence = {
    dialect: 'sqlite',
    transaction: fn => fn({ identity }),
    repositories: { identity },
  };
  return { persistence, users, state };
}

describe('task9 libre auth_subject lookup-before-create + conflict', () => {
  test('concurrent same-subject provisioning converges to one id, no orphan', async () => {
    const { persistence, users } = makePersistence();
    const model = new UserModel(() => persistence);
    const results = await Promise.all(
      [0, 1, 2, 3].map(() =>
        model.findOrCreateByAuthSubject({
          subject: SUBJECT,
          username: 'racer',
          email: 'race@example.com',
        })
      )
    );
    const ids = new Set(results.map(r => r.id));
    assert.equal(ids.size, 1);
    assert.equal(users.size, 1);
    const sole = [...users.values()][0];
    assert.equal(sole.auth_subject, SUBJECT);
    console.log(
      `libre concurrent provision: same-id rows=1 orphans=0 id=${results[0].id}`
    );
  });

  test('stale-read loser re-resolves to the winner (unique -> converge)', async () => {
    const { persistence, users, state } = makePersistence();
    const model = new UserModel(() => persistence);
    const winner = await model.findOrCreateByAuthSubject({
      subject: SUBJECT,
      username: 'winner',
      email: 'winner@example.com',
    });
    state.staleSubjectReads = 1;
    const loser = await model.findOrCreateByAuthSubject({
      subject: SUBJECT,
      username: 'loser',
      email: 'loser@example.com',
    });
    assert.equal(loser.id, winner.id);
    assert.equal(users.size, 1);
    console.log('libre stale-read race: loser-converged rows=1');
  });

  test('link race-loss throws already-linked (409-mappable), never merges', async () => {
    const { persistence, users, state } = makePersistence();
    const model = new UserModel(() => persistence);
    const owner = await model.findOrCreateByAuthSubject({
      subject: SUBJECT,
      username: 'owner',
      email: 'owner@example.com',
    });
    const intruder = await model.findOrCreateByAuthSubject({
      subject: 'https://auth.alcore.io.vn|task9-sub-2',
      username: 'intruder',
      email: 'intruder@example.com',
    });
    state.staleSubjectReads = 1;
    await assert.rejects(
      model.linkAuthSubject(intruder.id, SUBJECT),
      /already linked/
    );
    assert.match(
      'This Auth identity is already linked to an account',
      SERVICE_CONFLICT_REGEX
    );
    const stillOwner = await model.getUserByAuthSubject(SUBJECT);
    assert.equal(stillOwner.id, owner.id);
    assert.equal(users.size, 2);
    console.log('libre link race: loser=409/CONFLICT owner-unchanged rows=2');
  });

  test('same-user re-link is a no-op; email-twin race keeps denial', async () => {
    const { persistence, state } = makePersistence();
    const model = new UserModel(() => persistence);
    const owner = await model.findOrCreateByAuthSubject({
      subject: SUBJECT,
      username: 'owner',
      email: 'owner@example.com',
    });
    await model.linkAuthSubject(owner.id, SUBJECT);
    state.staleEmailReads = 1;
    await assert.rejects(
      model.findOrCreateByAuthSubject({
        subject: 'https://auth.alcore.io.vn|task9-sub-3',
        username: 'twin',
        email: 'owner@example.com',
      }),
      /already exists/
    );
    assert.match(
      'An account with this email already exists',
      SERVICE_CONFLICT_REGEX
    );
    console.log('libre idempotent relink: ok; email-twin: 409/CONFLICT');
  });
});
