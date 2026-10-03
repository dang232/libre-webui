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

import { createHash } from 'node:crypto';

/**
 * Per-product Auth rollout observability (todo 47).
 *
 * Libre reads ALCORE_AUTH_MODE once via `config/authMode.ts` (`local`
 * default, fail-closed). This module is the single observability point for
 * the rollout: every auth-path decision maps to exactly one countable audit
 * action shared with TokenPanel (`auth.success` / `auth.failure` /
 * `auth.link_conflict` / `auth.legacy_fallback`), so the cutover monitor
 * counts each outcome separately per product.
 *
 * Outcome semantics (shared with TokenPanel + docs/auth/CUTOVER-PLAN.md):
 * - auth_success: the Auth path verified the identity.
 * - auth_failure: the Auth path was selected but verification failed, or the
 *   Auth path is not implemented yet (fail-closed, zero product writes).
 * - auth_link_conflict: an identity-link collision was observed and queued.
 * - legacy_fallback: the local path served the request (flag off).
 *
 * Audit details carry only path + outcome + reason code + email-hash/userId.
 * Tokens, passwords, and secrets must never enter these rows: the email is
 * stored as a one-way hash, reason codes are caller-supplied constants, and
 * `securityAuditService` drops secret-like keys before persistence.
 * This module never reads product records and never writes them; the old
 * local path is untouched.
 */

export type LibreAuthPathOutcome =
  'auth_success' | 'auth_failure' | 'auth_link_conflict' | 'legacy_fallback';

export const LIBRE_AUTH_PATH_OUTCOME_ACTION: Readonly<
  Record<LibreAuthPathOutcome, string>
> = {
  auth_success: 'auth.success',
  auth_failure: 'auth.failure',
  auth_link_conflict: 'auth.link_conflict',
  legacy_fallback: 'auth.legacy_fallback',
} as const;

/**
 * Cross-lane provisioning lifecycle naming (unified-auth-core todo 13,
 * shared with TokenPanel `provision-attempts.ts`). Libre exposes states as
 * observable equivalents — HTTP status + countable audit rows — never as
 * literal PENDING/PROVISIONED strings:
 * - 200 exchange OK <-> PROVISIONED (TokenPanel uses 201 create/replay,
 *   same 2xx family, same state)
 * - 409 AUTH_LINK_CONFLICT <-> CONFLICT (twin queued, never merged)
 * - 500 <-> FAILED (retryable with the same provision key)
 * - 503 <-> FAILED (unreachable Auth, same retryable family as 500)
 * PENDING (attempt in flight) + UNPROVISIONED (never-contacted product)
 * complete the set; neither is stored. 400-range caller errors carry no
 * lifecycle state (final rejections, nothing to resume).
 */
export const LIBRE_PROVISION_HTTP_TO_LIFECYCLE = {
  200: 'PROVISIONED',
  409: 'CONFLICT',
  500: 'FAILED',
  503: 'FAILED',
} as const;

/** One-way email digest for audit rows: normalized, never the raw address. */
export const hashEmailForAudit = (email: string): string =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

export interface AuthPathOutcomeInput {
  readonly outcome: LibreAuthPathOutcome;
  /** Stable reason code (e.g. local_login, auth_path_not_ready). Never a secret. */
  readonly reason: string;
  readonly email?: string | undefined;
  readonly userId?: string | undefined;
}

/**
 * Build the redacted audit details payload (pure, no I/O). Keys are fixed to
 * path + outcome + reason + emailHash/userId — no token, password, or secret
 * field can enter through this shape.
 */
export const buildAuthPathDetails = (
  input: AuthPathOutcomeInput
): Record<string, unknown> => ({
  path: input.outcome === 'legacy_fallback' ? 'local' : 'auth',
  outcome: input.outcome,
  reason: input.reason,
  ...(input.email !== undefined
    ? { emailHash: hashEmailForAudit(input.email) }
    : {}),
  ...(input.userId !== undefined ? { userId: input.userId } : {}),
});

/**
 * Emit exactly one countable audit row for an auth-path decision.
 * Best-effort (never throws, never blocks authentication): the import is
 * deferred so this config module stays cycle-free, matching `authMode.ts`.
 */
export const recordAuthPathOutcome = (input: AuthPathOutcomeInput): void => {
  void import('../services/securityAuditService.js').then(
    ({ recordAuditEvent }) =>
      recordAuditEvent({
        action: LIBRE_AUTH_PATH_OUTCOME_ACTION[input.outcome],
        result:
          input.outcome === 'auth_success' ||
          input.outcome === 'legacy_fallback'
            ? 'success'
            : 'denied',
        targetType: 'user',
        targetId: input.userId,
        details: buildAuthPathDetails(input),
      }),
    () => undefined
  );
};
