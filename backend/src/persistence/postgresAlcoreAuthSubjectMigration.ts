/*
 * Alcore
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { createHash } from 'node:crypto';
import type { PostgresMigration } from './postgresMigrationTypes.js';

/**
 * Canonical Alcore Auth subject mapped beside the unchanged Libre users.id
 * (todo 41). Nullable additive column: existing rows stay NULL, the primary
 * key and every REFERENCES users(id) foreign key are untouched. The sparse
 * unique index allows any number of unmapped rows while rejecting duplicate
 * non-null subjects.
 */
export const POSTGRES_ALCORE_AUTH_SUBJECT_SQL = `ALTER TABLE users ADD COLUMN auth_subject text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth_subject ON users(auth_subject) WHERE auth_subject IS NOT NULL;`;

const version = 31;
const name = 'alcore-auth-subject';

export const POSTGRES_ALCORE_AUTH_SUBJECT_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum: createHash('sha256')
      .update(`${version}\n${name}\n${POSTGRES_ALCORE_AUTH_SUBJECT_SQL}`)
      .digest('hex'),
    sql: POSTGRES_ALCORE_AUTH_SUBJECT_SQL,
    rollbackPlan:
      'DROP INDEX IF EXISTS idx_users_auth_subject; ' +
      'ALTER TABLE users DROP COLUMN IF EXISTS auth_subject; ' +
      'delete ledger row 31. Product sessions keep working on users.id; ' +
      'Auth-linked sign-in (todo 45) stops resolving until re-migrated, ' +
      'the pre-migration behavior.',
    minimumCompatibleVersion: 30,
  });
