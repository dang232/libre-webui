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
 * Self-hosted vs Alcore-managed authentication boundary
 * (unified-auth-core todo 14 production-path declaration).
 *
 * - `local` (default): generic self-hosted installs. Local password/OAuth/
 *   MFA/passkey routes work exactly as today. This mode is isolated to
 *   generic self-hosted and dev use only — it must never serve an
 *   Alcore-managed host. This is the fail-closed default when
 *   ALCORE_AUTH_MODE is unset, empty, or any unrecognized value.
 * - `alcore`: the Alcore deployment. Local credential routes return 404 so
 *   the external Auth service is the only sign-in path. Product sessions
 *   already minted keep working; only *issuing* local credentials is
 *   disabled. Every Alcore-managed host must boot in this mode:
 *   `assertAlcoreHostAuthMode()` (called from `main.ts` preflight)
 *   refuses to boot otherwise.
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

/**
 * Production-path declaration (unified-auth-core todo 14): a host is
 * Alcore-managed when the operator declares it (`ALCORE_DEPLOYMENT=alcore`)
 * or when its public identity points at the Alcore production domains
 * (`BASE_URL` / `CORS_ORIGIN` mentioning `alcore.io.vn`). A generic
 * self-hosted install never matches either signal, so `local` stays its
 * isolated dev-only default with no new requirement.
 */
export const ALCORE_MANAGED_HOST_SUFFIX = 'alcore.io.vn' as const;

export const isAlcoreManagedHost = (
  env: NodeJS.ProcessEnv = process.env
): boolean => {
  if (typeof env.ALCORE_DEPLOYMENT === 'string') {
    const marker = env.ALCORE_DEPLOYMENT.trim().toLowerCase();
    if (marker === 'alcore') return true;
  }
  for (const key of ['BASE_URL', 'CORS_ORIGIN'] as const) {
    const value = env[key];
    if (
      typeof value === 'string' &&
      value.toLowerCase().includes(ALCORE_MANAGED_HOST_SUFFIX)
    ) {
      return true;
    }
  }
  return false;
};

/**
 * Fail-closed production gate: an Alcore-managed host must boot with
 * `ALCORE_AUTH_MODE=alcore`. Called once during startup preflight
 * (`main.ts`); it throws before persistence opens or the port listens, so
 * a misconfigured Alcore host never serves local issuance. The mode itself
 * stays boot-once (`AUTH_MODE`), so this decision cannot flip under a
 * running process.
 */
export const assertAlcoreHostAuthMode = (
  env: NodeJS.ProcessEnv = process.env
): void => {
  if (
    isAlcoreManagedHost(env) &&
    normalizeAuthMode(env.ALCORE_AUTH_MODE) !== 'alcore'
  ) {
    throw new Error(
      'FATAL: Alcore-managed host must boot with ALCORE_AUTH_MODE=alcore ' +
        `(got ${JSON.stringify(env.ALCORE_AUTH_MODE ?? '')}). Local credential issuance is disabled on Alcore hosts; ` +
        'set ALCORE_AUTH_MODE=alcore and restart. Refusing to boot.'
    );
  }
};

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
