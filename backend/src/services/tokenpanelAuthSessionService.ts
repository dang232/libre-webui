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
 * Auth-session upstream auth for the TokenPanel BFF (gap2-bff, R-BFF1).
 *
 * In Alcore mode (`ALCORE_AUTH_MODE=alcore`) the BFF authenticates upstream
 * with the caller's Auth-derived Libre product session (server-side session
 * kind `alcore-auth`, minted by the direct Auth exchange in
 * `alcoreAuthService.ts`) instead of a bridge-minted 120s viewer JWT. The
 * bridge (`tokenpanelBridgeService.ts`) stays as a flag-gated fallback: when
 * the upstream answers 401 to the Auth session, each site mints through the
 * bridge once and retries once, so panels keep working against a TokenPanel
 * that does not validate Auth sessions yet.
 *
 * In local self-hosted mode this module is inert: the gate passes through
 * and every upstream call rides the bridge exactly as today (byte-identical).
 *
 * Credential boundaries (never relaxed):
 * - `tp_mgmt_*` is only ever attached to bridge resolve/mint calls
 *   server-side; it never rides a customer endpoint and never reaches the
 *   browser.
 * - `lwk_*` API tokens are never sessions: the gate below rejects
 *   `api-token` auth on BFF routes in Alcore mode with 403 TOKEN_SCOPE, and
 *   legacy (session-less) tokens are rejected with 401.
 */

import type { Request, Response, NextFunction } from 'express';
import { isAlcoreAuthMode } from '../config/authMode.js';
import { getValidSession } from './authSessionService.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:tokenpanel-auth-session');

/** Server-side session kind minted by the direct Auth exchange (todo 45). */
export const ALCORE_AUTH_SESSION_KIND = 'alcore-auth' as const;

/** Error code when a BFF route needs an Auth-derived session in Alcore mode. */
export const AUTH_SESSION_REQUIRED_CODE = 'AUTH_SESSION_REQUIRED' as const;

/**
 * Extract the caller's session JWT from the request. Returns null unless the
 * request authenticated as a session (`authenticate` set `req.auth.kind` to
 * `session`): API-token (`lwk_*`) and legacy callers never yield a token
 * here, so a returned value is always session-bound, never an API token.
 */
export const sessionBearerOf = (req: Request): string | null => {
  const auth = (req as AuthenticatedRequest).auth;
  if (!auth || auth.kind !== 'session') return null;
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.substring(7).trim();
  return token.length > 0 ? token : null;
};

/**
 * Whether the request rides an Auth-derived Libre session. The check reads
 * the server-side session record (source of truth for the issuance kind),
 * never the JWT payload alone, so a forged or local-issued session cannot
 * pass in Alcore mode.
 */
export const isAuthDerivedSession = async (req: Request): Promise<boolean> => {
  const auth = (req as AuthenticatedRequest).auth;
  if (!auth || auth.kind !== 'session') return false;
  const session = await getValidSession(auth.sessionId).catch(() => null);
  return session !== null && session.kind === ALCORE_AUTH_SESSION_KIND;
};

/**
 * BFF session gate. In local mode this is a pure pass-through (existing
 * `authenticate` behavior is byte-identical). In Alcore mode every BFF route
 * behind this gate requires an Auth-derived session:
 * - API-token (`lwk_*`) callers are rejected with 403 TOKEN_SCOPE (an API
 *   token is never a session);
 * - missing, legacy, revoked, or non-Auth sessions are rejected with 401
 *   AUTH_SESSION_REQUIRED (same shape for every denial: no oracle).
 */
export const requireBffAuthSession = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  if (!isAlcoreAuthMode()) {
    next();
    return;
  }
  try {
    const auth = (req as AuthenticatedRequest).auth;
    if (auth?.kind === 'api-token') {
      res.status(403).json({
        success: false,
        code: 'TOKEN_SCOPE',
        message: 'API tokens cannot open the API Platform panels',
      });
      return;
    }
    if (!(await isAuthDerivedSession(req))) {
      res.status(401).json({
        success: false,
        code: AUTH_SESSION_REQUIRED_CODE,
        message: 'Sign in with Auth to open the API Platform panels',
      });
      return;
    }
    next();
  } catch {
    // Fail closed with the same denial shape (no oracle distinguishing a
    // store failure from a bad session).
    res.status(401).json({
      success: false,
      code: AUTH_SESSION_REQUIRED_CODE,
      message: 'Sign in with Auth to open the API Platform panels',
    });
  }
};

export interface AuthUpstreamAttempt {
  status: number;
  body: unknown;
}

/**
 * Auth-session-first upstream call with bridge fallback.
 *
 * - Local mode, or no session token supplied: `call(await bridgeMint())` —
 *   the exact bridge sequence used today.
 * - Alcore mode with a session token: `call(sessionToken)` first (zero
 *   bridge calls on the happy path); only when the upstream answers 401,
 *   mint through the bridge once and retry once, then return whatever the
 *   retry produced. A throwing `bridgeMint` propagates (callers already map
 *   bridge errors to their typed failures).
 */
export const callUpstreamWithAuthFallback = async (args: {
  sessionToken: string | null | undefined;
  bridgeMint: () => Promise<string>;
  call: (bearer: string) => Promise<AuthUpstreamAttempt>;
  context: string;
}): Promise<AuthUpstreamAttempt> => {
  const { sessionToken, bridgeMint, call, context } = args;
  if (!isAlcoreAuthMode() || !sessionToken) {
    return call(await bridgeMint());
  }
  const first = await call(sessionToken);
  if (first.status !== 401) return first;
  logger.warn(
    'TokenPanel Auth-session upstream denied, using bridge fallback',
    {
      context,
    }
  );
  return call(await bridgeMint());
};
