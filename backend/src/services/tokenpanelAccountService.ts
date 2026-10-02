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
 * TokenPanel account BFF proxy — subscriptions, budgets, limits, profile
 * (todo 22).
 *
 * The browser calls the account router with the Libre user session only; the
 * management key and the short-lived TokenPanel viewer JWT never leave the
 * server (minted per request by the bridge, `tokenpanelBridgeService.ts`).
 * Every function forwards to the TokenPanel customer self-service API
 * (`routes/public/customers-public.ts`: `GET /me/subscription` @868,
 * `POST /me/subscriptions` @890, `GET /me/limits` @1005,
 * `GET /me/budgets` @1017, `PATCH /me/limits` @1079,
 * `PATCH /me/budgets/:id` @1126, `GET /me` @847, `PATCH /me` @1170,
 * `GET /plans` @568) and returns the upstream payload verbatim.
 *
 * Validation parity: the boundary checks below mirror the upstream Effect
 * Schema shapes exactly (planId 24-hex, billing month|quarter|year, micros
 * integer-exact non-negative, windowSeconds 1..31536000, thresholds 0..100,
 * name 1..160, email 3..254). The server stays authoritative — violations
 * that pass the boundary still surface the upstream message verbatim.
 * Currency is pinned: it is never accepted from the caller, only echoed
 * from the server response.
 *
 * Session handling: an upstream 401 (bad/expired customer JWT) maps to a
 * BFF 401 with zero retries, so the frontend unified invalid-session path
 * (clearToken + AUTH_INVALIDATED_EVENT, single-fire) engages and the stale
 * token never continues working.
 */

import { createLogger } from '../utils/logger.js';
import { resolveServiceIdempotencyKey } from '../utils/idempotencyKey.js';
import {
  TokenpanelBridgeError,
  exchangePortalToken,
} from './tokenpanelBridgeService.js';
import { callUpstreamWithAuthFallback } from './tokenpanelAuthSessionService.js';

const logger = createLogger('services:tokenpanel-account');

export const DEFAULT_TOKENPANEL_API_URL = 'https://alcore.io.vn';

const apiBase = (): string =>
  (process.env.TOKENPANEL_API_URL || DEFAULT_TOKENPANEL_API_URL).replace(
    /\/+$/,
    ''
  );

export class TokenpanelAccountError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = 'TokenpanelAccountError';
    this.status = status;
  }
}

interface UpstreamResult {
  status: number;
  body: unknown;
}

async function customerFetch(
  path: string,
  init: RequestInit & { idempotencyKey?: string; portalToken?: string }
): Promise<UpstreamResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${apiBase()}${path}`, {
      method: init.method ?? 'GET',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init.portalToken
          ? { Authorization: `Bearer ${init.portalToken}` }
          : {}),
        ...(init.idempotencyKey
          ? { 'Idempotency-Key': init.idempotencyKey }
          : {}),
        ...(init.headers || {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body };
  } catch (error) {
    throw new TokenpanelAccountError(
      `TokenPanel is unreachable: ${error instanceof Error ? error.message : 'network error'}`
    );
  } finally {
    clearTimeout(timeout);
  }
}

const asRecord = (body: unknown): Record<string, unknown> =>
  typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)
    : {};

/**
 * Map an upstream denial to a BFF error. The upstream error code passes
 * through verbatim (server-authoritative messages, never invented here).
 * 401 is preserved with zero retries so the frontend single-fire
 * invalidation path engages.
 */
const toAccountError = (
  result: UpstreamResult,
  context: string
): TokenpanelAccountError => {
  const code = asRecord(result.body).error;
  const suffix =
    typeof code === 'string' && code.length > 0 ? ` (${code})` : '';
  if (result.status === 401) {
    return new TokenpanelAccountError(
      `TokenPanel session is no longer valid${suffix}`,
      401
    );
  }
  const status =
    result.status === 400 ||
    result.status === 402 ||
    result.status === 403 ||
    result.status === 404 ||
    result.status === 409 ||
    result.status === 422 ||
    result.status === 429
      ? result.status
      : 502;
  return new TokenpanelAccountError(
    `TokenPanel denied the ${context} request${suffix}`,
    status
  );
};

/** Resolve the caller's portal token (mgmt key stays server-side). Bridge path: kept for local mode and Alcore fallback. */
const portalTokenFor = async (
  userId: string,
  idempotencyKey?: string
): Promise<string> => {
  try {
    const grant = await exchangePortalToken(
      userId,
      idempotencyKey !== undefined ? { idempotencyKey } : undefined
    );
    return grant.token;
  } catch (error) {
    if (error instanceof TokenpanelBridgeError) {
      throw new TokenpanelAccountError(error.message, error.status);
    }
    throw error;
  }
};

const forwardGet = async (
  userId: string,
  path: string,
  context: string,
  sessionToken?: string
): Promise<unknown> => {
  const result = await callUpstreamWithAuthFallback({
    sessionToken,
    bridgeMint: () => portalTokenFor(userId),
    call: token =>
      customerFetch(path, {
        method: 'GET',
        portalToken: token,
      }),
    context: `account-${context}`,
  });
  if (result.status !== 200) {
    logger.warn('TokenPanel account read denied', {
      status: result.status,
      path,
    });
    throw toAccountError(result, context);
  }
  return result.body;
};

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const BILLINGS = new Set(['month', 'quarter', 'year']);
const MAX_WINDOW_SECONDS = 31536000;

const isNonNegativeSafeInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const resolveIdempotencyKey = (provided: unknown): string => {
  const resolved = resolveServiceIdempotencyKey(provided);
  if (resolved === null) {
    throw new TokenpanelAccountError('Invalid idempotency key', 400);
  }
  return resolved;
};

/** Active subscription + plan — passthrough of `GET /me/subscription`. */
export const getSubscription = (
  userId: string,
  sessionToken?: string
): Promise<unknown> =>
  forwardGet(
    userId,
    '/public/customers/me/subscription',
    'subscription',
    sessionToken
  );

/**
 * Buy a plan from existing balance — forwards `{planId, billing?}` only.
 * planId must be a 24-hex ObjectId and billing one of month|quarter|year
 * (mirrors upstream SubscribeBody); the cycle total, debit and subscription
 * are server-computed. Short balances surface the upstream 402 verbatim.
 */
export const subscribePlan = async (
  userId: string,
  input: { planId: unknown; billing?: unknown },
  idempotencyKey?: unknown,
  sessionToken?: string
): Promise<unknown> => {
  const planId = typeof input.planId === 'string' ? input.planId : '';
  if (!OBJECT_ID_PATTERN.test(planId)) {
    throw new TokenpanelAccountError('Plan not available', 400);
  }
  const body: Record<string, unknown> = { planId };
  if (input.billing !== undefined && input.billing !== null) {
    if (typeof input.billing !== 'string' || !BILLINGS.has(input.billing)) {
      throw new TokenpanelAccountError('Invalid billing period', 400);
    }
    body.billing = input.billing;
  }
  const key = resolveIdempotencyKey(idempotencyKey);
  const result = await callUpstreamWithAuthFallback({
    sessionToken,
    bridgeMint: () => portalTokenFor(userId, key),
    call: token =>
      customerFetch('/public/customers/me/subscriptions', {
        method: 'POST',
        portalToken: token,
        idempotencyKey: key,
        body: JSON.stringify(body),
      }),
    context: 'account-subscribe',
  });
  if (result.status !== 201) {
    logger.warn('TokenPanel subscribe denied', { status: result.status });
    throw toAccountError(result, 'subscription');
  }
  return result.body;
};

/**
 * Plan catalog — the upstream `GET /plans` is public (no customer JWT), so
 * this read needs only the Libre session. Prices pass through verbatim in
 * integer micros.
 */
export const listPlans = async (): Promise<unknown> => {
  const result = await customerFetch('/public/customers/plans', {
    method: 'GET',
  });
  if (result.status !== 200) {
    logger.warn('TokenPanel plans read denied', { status: result.status });
    throw toAccountError(result, 'plans');
  }
  return result.body;
};

/** Budgets — passthrough of `GET /me/budgets` (micros-exact, verbatim). */
export const getBudgets = (
  userId: string,
  sessionToken?: string
): Promise<unknown> =>
  forwardGet(userId, '/public/customers/me/budgets', 'budgets', sessionToken);

/**
 * Update one budget — forwards `{amountMicros?, alertThresholds?}` only.
 * amountMicros must be an integer >= 0 (mirrors upstream NonNegativeSafeInt,
 * never floats); thresholds must be integers 0..100. Unknown/other-customer
 * ids surface the upstream 404 verbatim, never a leak.
 */
export const updateBudget = async (
  userId: string,
  budgetId: string,
  input: { amountMicros?: unknown; alertThresholds?: unknown },
  idempotencyKey?: unknown,
  sessionToken?: string
): Promise<unknown> => {
  if (!OBJECT_ID_PATTERN.test(budgetId)) {
    throw new TokenpanelAccountError('Budget not found', 404);
  }
  const patch: Record<string, unknown> = {};
  if (input.amountMicros !== undefined) {
    if (!isNonNegativeSafeInt(input.amountMicros)) {
      throw new TokenpanelAccountError(
        'Amount must be a non-negative integer in micros',
        400
      );
    }
    patch.amountMicros = input.amountMicros;
  }
  if (input.alertThresholds !== undefined) {
    if (
      !Array.isArray(input.alertThresholds) ||
      !input.alertThresholds.every(
        t =>
          typeof t === 'number' && Number.isSafeInteger(t) && t >= 0 && t <= 100
      )
    ) {
      throw new TokenpanelAccountError(
        'Alert thresholds must be integers 0-100',
        400
      );
    }
    patch.alertThresholds = input.alertThresholds;
  }
  const key = resolveIdempotencyKey(idempotencyKey);
  const result = await callUpstreamWithAuthFallback({
    sessionToken,
    bridgeMint: () => portalTokenFor(userId),
    call: token =>
      customerFetch(`/public/customers/me/budgets/${budgetId}`, {
        method: 'PATCH',
        portalToken: token,
        idempotencyKey: key,
        body: JSON.stringify(patch),
      }),
    context: 'account-budget',
  });
  if (result.status !== 200) {
    logger.warn('TokenPanel budget update denied', { status: result.status });
    throw toAccountError(result, 'budget');
  }
  return result.body;
};

/** Limits — passthrough of `GET /me/limits` (rules + spendingCap verbatim). */
export const getLimits = (
  userId: string,
  sessionToken?: string
): Promise<unknown> =>
  forwardGet(userId, '/public/customers/me/limits', 'limits', sessionToken);

/**
 * Upsert the spending cap — forwards `{spendingCap}` only, where spendingCap
 * is `{maxSpendMicros: non-negative integer micros, windowSeconds: 1..31_536_000}`
 * or null to clear (mirrors upstream LimitsPatchBody). Currency is pinned:
 * no currency field exists on this path.
 */
export const updateLimits = async (
  userId: string,
  input: { spendingCap?: unknown },
  idempotencyKey?: unknown,
  sessionToken?: string
): Promise<unknown> => {
  if (!('spendingCap' in input)) {
    throw new TokenpanelAccountError('Missing spendingCap', 400);
  }
  const { spendingCap } = input;
  if (spendingCap !== null) {
    const cap =
      (typeof spendingCap === 'object' && spendingCap !== null
        ? (spendingCap as Record<string, unknown>)
        : null) ?? null;
    if (
      cap === null ||
      !isNonNegativeSafeInt(cap.maxSpendMicros) ||
      typeof cap.windowSeconds !== 'number' ||
      !Number.isSafeInteger(cap.windowSeconds) ||
      cap.windowSeconds < 1 ||
      cap.windowSeconds > MAX_WINDOW_SECONDS
    ) {
      throw new TokenpanelAccountError('Invalid spending cap', 400);
    }
  }
  const key = resolveIdempotencyKey(idempotencyKey);
  const result = await callUpstreamWithAuthFallback({
    sessionToken,
    bridgeMint: () => portalTokenFor(userId),
    call: token =>
      customerFetch('/public/customers/me/limits', {
        method: 'PATCH',
        portalToken: token,
        idempotencyKey: key,
        body: JSON.stringify({ spendingCap }),
      }),
    context: 'account-limits',
  });
  if (result.status !== 200) {
    logger.warn('TokenPanel limits update denied', { status: result.status });
    throw toAccountError(result, 'limits');
  }
  return result.body;
};

/** Profile — passthrough of `GET /me` (never includes passwordHash). */
export const getProfile = (
  userId: string,
  sessionToken?: string
): Promise<unknown> =>
  forwardGet(userId, '/public/customers/me', 'profile', sessionToken);

/**
 * Update the profile — forwards `{name?, email?}` only (mirrors upstream
 * ProfileBody: name 1..160, email 3..254). Only provided fields are sent;
 * password changes are NOT proxied here (credentials belong to Auth Repo C).
 */
export const updateProfile = async (
  userId: string,
  input: { name?: unknown; email?: unknown },
  idempotencyKey?: unknown,
  sessionToken?: string
): Promise<unknown> => {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length < 1 || name.length > 160) {
      throw new TokenpanelAccountError('Name must be 1-160 characters', 400);
    }
    patch.name = name;
  }
  if (input.email !== undefined) {
    const email = typeof input.email === 'string' ? input.email.trim() : '';
    if (email.length < 3 || email.length > 254 || !email.includes('@')) {
      throw new TokenpanelAccountError('Invalid email address', 400);
    }
    patch.email = email;
  }
  if (Object.keys(patch).length === 0) {
    throw new TokenpanelAccountError('Nothing to update', 400);
  }
  const key = resolveIdempotencyKey(idempotencyKey);
  const result = await callUpstreamWithAuthFallback({
    sessionToken,
    bridgeMint: () => portalTokenFor(userId),
    call: token =>
      customerFetch('/public/customers/me', {
        method: 'PATCH',
        portalToken: token,
        idempotencyKey: key,
        body: JSON.stringify(patch),
      }),
    context: 'account-profile',
  });
  if (result.status !== 200) {
    logger.warn('TokenPanel profile update denied', { status: result.status });
    throw toAccountError(result, 'profile');
  }
  return result.body;
};
