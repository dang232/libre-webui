/*
 * Alcore
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { createHash } from 'node:crypto';
import type { PostgresMigration } from './postgresMigrationTypes.js';

const version = 30;
const name = 'canonical-auth-identity';
const sql = `
ALTER TABLE users ADD COLUMN canonical_user_id text;
CREATE UNIQUE INDEX idx_users_canonical_user_id
  ON users(canonical_user_id)
  WHERE canonical_user_id IS NOT NULL;
CREATE TABLE canonical_identity_conflicts (
  canonical_user_id text PRIMARY KEY,
  queued_at bigint NOT NULL
);
`;

export const POSTGRES_CANONICAL_IDENTITY_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum: createHash('sha256')
      .update(`${version}\n${name}\n${sql}`)
      .digest('hex'),
    sql,
    rollbackPlan:
      'Stop Libre and remove idx_users_canonical_user_id after canonical identity mapping is no longer required.',
    minimumCompatibleVersion: 1,
  });
