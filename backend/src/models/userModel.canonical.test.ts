import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  IdentityRepository,
  IdentityUserRecord,
  Persistence,
} from '../persistence/index.js';
import { UserModel } from './userModel.js';

const record = (
  id: string,
  username: string,
  canonicalUserId: string | null
): IdentityUserRecord => ({
  id,
  username,
  canonical_user_id: canonicalUserId,
  email: null,
  password_hash: 'hash',
  role: 'user',
  account_status: 'active',
  approved_at: 1,
  approved_by: null,
  avatar: null,
  created_at: 1,
  updated_at: 1,
});

const fakePersistence = (identity: Partial<IdentityRepository>): Persistence =>
  ({
    dialect: 'postgres',
    repositories: {
      identity: identity as IdentityRepository,
    } as Persistence['repositories'],
    health: async () => ({ ready: true, dialect: 'postgres', latencyMs: 0 }),
    close: async () => undefined,
  }) as Persistence;

test('Given another identity owns the deterministic username, when provisioning, then queue conflict and fail closed', async () => {
  const canonicalId = 'subject';
  const username = `auth_${Buffer.from(canonicalId, 'utf8').toString('hex').slice(0, 48)}`;
  let queued = false;
  const identity: Partial<IdentityRepository> = {
    canonicalIdentityCollision: async () => false,
    findByCanonicalUserId: async () => null,
    findByUsername: async () => record('local-user', username, null),
    queueCanonicalIdentityConflict: async () => {
      queued = true;
    },
  };
  const model = new UserModel(() => fakePersistence(identity));
  await assert.rejects(
    model.getOrCreateCanonicalUser(canonicalId),
    /collision/
  );
  assert.equal(queued, true);
});

test('Given a concurrent create for the same canonical subject, when insert loses the race, then recover that canonical user', async () => {
  const canonicalId = 'race-subject';
  const canonicalUser = record(
    'canonical-local-id',
    `auth_${Buffer.from(canonicalId, 'utf8').toString('hex')}`,
    canonicalId
  );
  let canonicalLookups = 0;
  const identity: Partial<IdentityRepository> = {
    canonicalIdentityCollision: async () => false,
    findByCanonicalUserId: async () => {
      canonicalLookups += 1;
      return canonicalLookups === 1 ? null : canonicalUser;
    },
    findByUsername: async () => null,
    createCanonicalUser: async () => {
      throw new Error('unique constraint');
    },
  };
  const model = new UserModel(() => fakePersistence(identity));
  assert.equal(
    (await model.getOrCreateCanonicalUser(canonicalId)).id,
    canonicalUser.id
  );
});
