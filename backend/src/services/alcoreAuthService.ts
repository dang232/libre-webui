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
 * Direct Auth relying party (todo 45).
 *
 * Libre validates an Auth identity through a server-to-server opaque-code
 * exchange at Auth `POST /oidc/exchange/token` (TARGET-ARCHITECTURE §3c),
 * then loads or creates the LOCAL Libre profile beside the unchanged Libre
 * user id (`findOrCreateByAuthSubject`, todo 41), and mints ONLY a Libre
 * product session (`authService.issueSession`).
 *
 * What this module MUST NOT do (acceptance fail-closed):
 * - Verify passwords or OAuth provider tokens. Auth owns credentials
 *   (bcrypt-compat/Argon2id, Google JWKS); Libre never sees them.
 * - Verify the Auth JWT signature locally. Auth signs HS256 with a symmetric
 *   secret; holding that secret would let Libre mint Auth sessions, which is
 *   forbidden. Authenticity comes from the S2S TLS exchange with Auth: only
 *   Auth can turn a single-use code into an assertion, so a 200 response
 *   from Auth IS the validation. Libre additionally checks the assertion's
 *   structural claims (iss/aud/intent/exp/sub) below without trusting them
 *   for authenticity.
 * - Mint Auth sessions or Auth-like JWTs (`intent: session|oidc` is
 *   Auth-only). Libre mints its own product JWT (no `aud`/`intent` claims).
 * - Accept `lwk_*` as a session. The exchange route takes an opaque Auth
 *   code only; API tokens are rejected explicitly at the route layer and
 *   remain barred from `/api/auth/*` by FORBIDDEN_PREFIXES.
 * - Route through TokenPanel auth. This is direct Libre↔Auth only.
 */

import {
  toCanonicalAuthSubject,
  DEFAULT_AUTH_BASE_URL,
} from '../config/authMode.js';
import { userModel, type UserPublic } from '../models/userModel.js';
import { authService } from './authService.js';
import type { SessionMetadata } from './authService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:alcore-auth');

export const PRODUCT_AUDIENCE = 'libre' as const;
export const PRODUCT_INTENT = 'product_exchange' as const;
const EXCHANGE_TIMEOUT_MS = 10_000;
/** Clock-skew leeway for the 60 s Auth assertion. Documented, not silent. */
const ASSERTION_SKEW_LEEWAY_SECONDS = 60;

export class AlcoreAuthError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = 'AlcoreAuthError';
    this.status = status;
  }
}

/** Auth origin for the S2S exchange. Operator override, sane default. */
export const getAlcoreAuthUrl = (): string => {
  const raw = (process.env.ALCORE_AUTH_URL || '').trim().replace(/\/+$/, '');
  return raw || DEFAULT_AUTH_BASE_URL;
};

/** Expected `iss` of Auth assertions. Must match Auth AUTH_ISSUER. */
export const getAlcoreAuthIssuer = (): string => {
  const raw = (process.env.ALCORE_AUTH_ISSUER || '').trim();
  return raw || DEFAULT_AUTH_BASE_URL;
};

export interface AlcoreExchangeInput {
  code: string;
  redirectUri?: string;
  state?: string;
}

interface AssertionClaims {
  sub: string;
  email: string | null;
}

const base64UrlDecode = (segment: string): string =>
  Buffer.from(segment, 'base64url').toString('utf8');

/**
 * Decode an Auth assertion payload WITHOUT verifying its signature (see
 * module doc: Libre must never hold the Auth HS256 secret). Authenticity
 * comes from receiving the assertion over the S2S TLS exchange; the
 * structural claim checks in `validateAssertionClaims` are defense in depth.
 */
export const decodeAssertionPayload = (assertion: string): unknown => {
  const parts = assertion.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new AlcoreAuthError('This Auth sign-in is invalid or expired', 401);
  }
  try {
    return JSON.parse(base64UrlDecode(parts[1] as string));
  } catch {
    throw new AlcoreAuthError('This Auth sign-in is invalid or expired', 401);
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};

/**
 * Structural claim checks on an Auth product assertion. Every failure maps
 * to the same generic 401 (no oracle distinguishing expired vs wrong-aud vs
 * wrong-iss vs malformed). Throws AlcoreAuthError, never returns null.
 */
export const validateAssertionClaims = (
  payload: unknown,
  expectedIssuer: string
): AssertionClaims => {
  const record = asRecord(payload);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const sub = record.sub;
  const sid = record.sid;
  const exp = record.exp;
  const email = record.email;
  const valid =
    record.iss === expectedIssuer &&
    record.aud === PRODUCT_AUDIENCE &&
    record.intent === PRODUCT_INTENT &&
    typeof sub === 'string' &&
    sub.length > 0 &&
    typeof sid === 'string' &&
    sid.length > 0 &&
    typeof exp === 'number' &&
    exp + ASSERTION_SKEW_LEEWAY_SECONDS > nowSeconds;
  if (!valid) {
    throw new AlcoreAuthError('This Auth sign-in is invalid or expired', 401);
  }
  return {
    sub: sub as string,
    email:
      typeof email === 'string' && email.includes('@') ? email.trim() : null,
  };
};

/**
 * S2S opaque-code exchange with Auth. The code is single-use at Auth
 * (replay → invalid_grant → generic 401 here). Auth refresh credentials
 * never appear on this path: the request carries only the code, and the
 * response carries only the 60 s product assertion. Nothing here is logged
 * (no code, assertion, email, or subject values in logs).
 */
export const exchangeCodeForAssertion = async (
  input: AlcoreExchangeInput
): Promise<string> => {
  const body: Record<string, string> = {
    code: input.code,
    audience: PRODUCT_AUDIENCE,
    intent: PRODUCT_INTENT,
  };
  // Bound (redirect-handoff) codes must present their binding; unbound
  // (bearer-handoff) codes must NOT send redirect fields, or Auth takes the
  // binding-free path refusal. Mirror oidc.ts consume/consumeForRedirect.
  if (input.redirectUri !== undefined) {
    body.redirect_uri = input.redirectUri;
    body.state = input.state ?? '';
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${getAlcoreAuthUrl()}/oidc/exchange/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new AlcoreAuthError(
      `Auth sign-in cannot be reached right now: ${error instanceof Error ? error.message : 'network error'}`,
      503
    );
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 429 || response.status === 503) {
    throw new AlcoreAuthError(
      'Auth sign-in is rate-limited right now; try again shortly',
      503
    );
  }
  if (!response.ok) {
    // invalid_grant (bad/replayed/bound-mismatch code), unauthorized, and
    // invalid_request all converge here: one generic shape, no oracle.
    throw new AlcoreAuthError('This Auth sign-in is invalid or expired', 401);
  }
  const data: unknown = await response.json().catch(() => null);
  const assertion = asRecord(data).access_token;
  if (typeof assertion !== 'string' || assertion.length === 0) {
    throw new AlcoreAuthError('This Auth sign-in is invalid or expired', 401);
  }
  return assertion;
};

export interface AlcoreSignIn {
  user: UserPublic;
  token: string;
}

/**
 * Full relying-party sign-in: S2S exchange → claim checks → LOCAL profile
 * (created beside a fresh Libre id on first sight, found by canonical
 * `issuer|subject` afterwards — never email alone) → Libre product session
 * only. The same Auth user reached via password or Google converges on the
 * same profile because Auth resolves both credentials to one subject.
 */
export const signInWithAuthCode = async (
  input: AlcoreExchangeInput,
  metadata: Omit<SessionMetadata, 'kind'>
): Promise<AlcoreSignIn> => {
  const issuer = getAlcoreAuthIssuer();
  const assertion = await exchangeCodeForAssertion(input);
  const claims = validateAssertionClaims(
    decodeAssertionPayload(assertion),
    issuer
  );
  let subject: string;
  try {
    subject = toCanonicalAuthSubject(issuer, claims.sub);
  } catch {
    throw new AlcoreAuthError('This Auth sign-in is invalid or expired', 401);
  }
  const usernameHint =
    claims.email !== null ? (claims.email.split('@')[0] ?? '') : 'alcore_user';
  let user: UserPublic;
  try {
    user = await userModel.findOrCreateByAuthSubject({
      subject,
      username: usernameHint.trim() || 'alcore_user',
      email: claims.email,
    });
  } catch (error) {
    // Email-collision (another account owns the address): fail closed with
    // the manual-link signal, never merge. No identity material in the log.
    logger.warn('Auth subject sign-in refused by profile mapping');
    throw new AlcoreAuthError(
      error instanceof Error &&
        /already exists|already linked/i.test(error.message)
        ? 'This Auth identity matches multiple accounts; contact support to link it'
        : 'This Auth sign-in cannot be linked to an account',
      409
    );
  }
  if (user.status !== 'active') {
    throw new AlcoreAuthError(
      'This account is waiting for administrator approval',
      403
    );
  }
  const token = await authService.issueSession(user, {
    kind: 'alcore-auth',
    ...metadata,
  });
  return { user, token };
};
