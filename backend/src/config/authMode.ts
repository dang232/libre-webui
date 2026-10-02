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

import type { Request, Response, NextFunction } from 'express';

/**
 * Self-hosted vs Alcore-managed authentication boundary (todo 41).
 *
 * - `local` (default): the Libre self-hosted password/OAuth/MFA/passkey
 *   routes work exactly as today. This is the fail-closed default when
 *   ALCORE_AUTH_MODE is unset, empty, or any unrecognized value.
 * - `alcore`: local credential routes return 404 so the external Auth
 *   service (todo 45 relying party) is the only sign-in path. Product
 *   sessions already minted keep working; only *issuing* local credentials
 *   is disabled.
 *
 * Alcore mode engages ONLY on the explicit value `alcore` (case- and
 * whitespace-insensitive). The value is read once at boot so the mode
 * cannot flip under a running process.
 */
export type AlcoreAuthMode = 'local' | 'alcore';

const normalizeAuthMode = (value: string | undefined): AlcoreAuthMode =>
  typeof value === 'string' && value.trim().toLowerCase() === 'alcore'
    ? 'alcore'
    : 'local';

/** Auth mode for this process, resolved once at module load (boot). */
export const AUTH_MODE: AlcoreAuthMode = normalizeAuthMode(
  process.env.ALCORE_AUTH_MODE
);

export const isAlcoreAuthMode = (): boolean => AUTH_MODE === 'alcore';

export const getAuthMode = (): AlcoreAuthMode => AUTH_MODE;

/** Auth Repo C origin default (todo 8 identity service; CORS triangle member). */
export const DEFAULT_AUTH_BASE_URL = 'https://auth.alcore.io.vn';

/** Error code returned when an Alcore-only route is hit in local mode. */
export const ALCORE_ONLY_CODE = 'ALCORE_AUTH_ONLY' as const;

/** Error code returned when a local-auth route is hit in Alcore mode. */
export const LOCAL_AUTH_DISABLED_CODE = 'LOCAL_AUTH_DISABLED' as const;

/**
 * Canonical Auth join key (todo 41): the issuer-plus-subject pair
 * `issuer|subject`, never email alone. Both parts are trimmed and must be
 * non-empty; neither may contain `|` or whitespace, so every stored value
 * splits unambiguously and two issuers can never collide on one subject.
 * Email-only merge is forbidden — callers must resolve the pair from a
 * validated Auth identity (todo 45 relying party), not from a profile email.
 */
export const AUTH_SUBJECT_SEPARATOR = '|' as const;

export const toCanonicalAuthSubject = (
  issuer: string,
  subject: string
): string => {
  const normalizedIssuer = issuer.trim();
  const normalizedSubject = subject.trim();
  if (!normalizedIssuer || !normalizedSubject) {
    throw new Error('An Auth issuer and subject are both required');
  }
  for (const part of [normalizedIssuer, normalizedSubject]) {
    if (part.includes(AUTH_SUBJECT_SEPARATOR) || /\s/.test(part)) {
      throw new Error(
        'An Auth issuer and subject must not contain `|` or whitespace'
      );
    }
  }
  return `${normalizedIssuer}${AUTH_SUBJECT_SEPARATOR}${normalizedSubject}`;
};

/**
 * Normalize a stored/candidate join key: trimmed `issuer|subject`, or null
 * when the value is not a well-formed pair. Read paths return null (no
 * match); write paths throw (fail closed, never fall back to email).
 */
export const normalizeAuthSubject = (value: string): string | null => {
  const trimmed = value.trim();
  const separatorIndex = trimmed.indexOf(AUTH_SUBJECT_SEPARATOR);
  if (
    separatorIndex <= 0 ||
    separatorIndex !== trimmed.lastIndexOf(AUTH_SUBJECT_SEPARATOR)
  ) {
    return null;
  }
  try {
    return toCanonicalAuthSubject(
      trimmed.slice(0, separatorIndex),
      trimmed.slice(separatorIndex + 1)
    );
  } catch {
    return null;
  }
};

/**
 * Express gate for local-credential routes. In Alcore mode every gated
 * route returns an identical 404 (no existent/nonexistent oracle); in
 * local mode the request passes through byte-identically to today.
 *
 * Every denial is audited best-effort as `auth.local_auth_blocked` with
 * only the matched path and a hashed IP (no identity material). The audit
 * write never blocks or alters the denial: the import is deferred so this
 * config module stays cycle-free, and recordAuditEvent never throws.
 */
export const rejectLocalAuthInAlcoreMode = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (!isAlcoreAuthMode()) {
    next();
    return;
  }
  void import('../services/securityAuditService.js').then(
    ({ recordAuditEvent, hashClientIp }) =>
      recordAuditEvent({
        action: 'auth.local_auth_blocked',
        result: 'denied',
        ipHash: hashClientIp(req.ip),
        details: { path: req.originalUrl?.split('?')[0] ?? req.path },
      }),
    () => undefined
  );
  res.status(404).json({
    success: false,
    code: LOCAL_AUTH_DISABLED_CODE,
    message: 'Local sign-in is disabled on this server',
  });
};
