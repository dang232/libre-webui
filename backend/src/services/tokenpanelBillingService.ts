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
 * TokenPanel billing BFF proxy — intent-only (todo 21).
 *
 * Libre NEVER writes ledger/balance itself. Every function below forwards the
 * caller's intent to the TokenPanel customer self-service API
 * (`routes/public/customers-public.ts`: `GET /me/billing` @1471,
 * `POST /me/topup-intents` @1531, `GET /me/topup-intents[:id]` @1551/:1577,
 * `POST /me/topup-intents/:id/cancel` @1592, `GET /me/invoices` @1611,
 * `POST /me/redeem` @1657) using the 120s viewer JWT minted server-side by
 * the bridge (`tokenpanelBridgeService.ts`). All value movement
 * (reserve/settle/debit/ledger) happens TokenPanel-side via
 * `selfserve-billing.ts` + the payment saga (`payment-saga.ts:105`); this
 * module performs no money math beyond integer validation at the boundary.
 *
 * Server-authoritative fields (QR payload, `qrExpiresAt` TTL, currency,
 * amounts in integer micros) pass through verbatim — never invented here.
 */

import { createLogger } from '../utils/logger.js';
import { resolveServiceIdempotencyKey } from '../utils/idempotencyKey.js';
import {
  TokenpanelBridgeError,
  exchangePortalToken,
} from './tokenpanelBridgeService.js';
import { callUpstreamWithAuthFallback } from './tokenpanelAuthSessionService.js';

const logger = createLogger('services:tokenpanel-billing');

export const DEFAULT_TOKENPANEL_API_URL = 'https://alcore.io.vn';

const apiBase = (): string =>
  (process.env.TOKENPANEL_API_URL || DEFAULT_TOKENPANEL_API_URL).replace(
    /\/+$/,
    ''
  );

export class TokenpanelBillingError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = 'TokenpanelBillingError';
    this.status = status;
  }
}

interface UpstreamResult {
  status: number;
  body: unknown;
}

async function customerFetch(
  portalToken: string,
  path: string,
  init: RequestInit & { idempotencyKey?: string }
): Promise<UpstreamResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${apiBase()}${path}`, {
      method: init.method ?? 'GET',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${portalToken}`,
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
    throw new TokenpanelBillingError(
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

/** Map an upstream customer-API denial to a BFF error (body passes through). */
const toBillingError = (result: UpstreamResult): TokenpanelBillingError => {
  const code = asRecord(result.body).error;
  const message =
    typeof code === 'string' && code.length > 0
      ? `TokenPanel denied the request (${code})`
      : 'TokenPanel denied the request';
  // 404 covers expired/decided/cross-customer intents (server reads them as
  // not found); 402 surfaces short-balance denials verbatim (never masked
  // as 502); 409/422 surface validation conflicts verbatim.
  const status =
    result.status === 400 ||
    result.status === 401 ||
    result.status === 402 ||
    result.status === 403 ||
    result.status === 404 ||
    result.status === 409 ||
    result.status === 422 ||
    result.status === 429
      ? result.status
      : 502;
  return new TokenpanelBillingError(message, status);
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
      throw new TokenpanelBillingError(error.message, error.status);
    }
    throw error;
  }
};

const forwardGet = async (
  userId: string,
  path: string,
  sessionToken?: string
): Promise<unknown> => {
  const result = await callUpstreamWithAuthFallback({
    sessionToken,
    bridgeMint: () => portalTokenFor(userId),
    call: token => customerFetch(token, path, { method: 'GET' }),
    context: 'billing',
  });
  if (result.status !== 200) {
    logger.warn('TokenPanel billing read denied', {
      status: result.status,
      path,
    });
    throw toBillingError(result);
  }
  return result.body;
};

const parsePageParam = (value: unknown): string | null => {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  // Pagination only; amounts never travel in the query string.
  if (!/^\d{1,6}$/.test(text)) {
    throw new TokenpanelBillingError('Invalid pagination parameter', 400);
  }
  return text;
};

const withPage = (
  path: string,
  query: { limit?: unknown; skip?: unknown }
): string => {
  const limit = parsePageParam(query.limit);
  const skip = parsePageParam(query.skip);
  const params = new URLSearchParams();
  if (limit !== null) params.set('limit', limit);
  if (skip !== null) params.set('skip', skip);
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
};

/** Billing history — read-only passthrough of `GET /me/billing`. */
export const getBillingHistory = (
  userId: string,
  query: { limit?: unknown; skip?: unknown },
  sessionToken?: string
): Promise<unknown> =>
  forwardGet(
    userId,
    withPage('/public/customers/me/billing', query),
    sessionToken
  );

/** Invoices — read-only passthrough of `GET /me/invoices`. */
export const listInvoices = (
  userId: string,
  query: { limit?: unknown; skip?: unknown },
  sessionToken?: string
): Promise<unknown> =>
  forwardGet(
    userId,
    withPage('/public/customers/me/invoices', query),
    sessionToken
  );

/** Top-up intents — read-only passthrough of `GET /me/topup-intents`. */
export const listTopupIntents = (
  userId: string,
  query: { limit?: unknown; skip?: unknown },
  sessionToken?: string
): Promise<unknown> =>
  forwardGet(
    userId,
    withPage('/public/customers/me/topup-intents', query),
    sessionToken
  );

/** One pending intent — read-only passthrough of `GET /me/topup-intents/:id`. */
export const getTopupIntent = (
  userId: string,
  intentId: string,
  sessionToken?: string
): Promise<unknown> => {
  if (!/^[0-9a-fA-F]{24}$/.test(intentId)) {
    throw new TokenpanelBillingError('Top-up intent not found', 404);
  }
  return forwardGet(
    userId,
    `/public/customers/me/topup-intents/${intentId}`,
    sessionToken
  );
};

const resolveIdempotencyKey = (provided: unknown): string => {
  const resolved = resolveServiceIdempotencyKey(provided);
  if (resolved === null) {
    throw new TokenpanelBillingError('Invalid idempotency key', 400);
  }
  return resolved;
};

/**
 * Create a recharge intent — forwards `{amountMicros}` only. The amount must
 * be a positive integer (micros, never floats); pricing, QR generation and
 * the QR TTL (`qrExpiresAt`) are server-authoritative and returned verbatim.
 */
export const createTopupIntent = async (
  userId: string,
  input: { amountMicros: unknown; idempotencyKey?: unknown },
  sessionToken?: string
): Promise<unknown> => {
  const amountMicros = input.amountMicros;
  if (
    typeof amountMicros !== 'number' ||
    !Number.isInteger(amountMicros) ||
    amountMicros <= 0
  ) {
    throw new TokenpanelBillingError(
      'Amount must be a positive integer in micros',
      400
    );
  }
  const idempotencyKey = resolveIdempotencyKey(input.idempotencyKey);
  // The bridge resolve is bound to the same replay key so a retried create
  // converges on one customer before the intent write (todo 23).
  const result = await callUpstreamWithAuthFallback({
    sessionToken,
    bridgeMint: () => portalTokenFor(userId, idempotencyKey),
    call: token =>
      customerFetch(token, '/public/customers/me/topup-intents', {
        method: 'POST',
        idempotencyKey,
        body: JSON.stringify({ amountMicros }),
      }),
    context: 'billing-create-intent',
  });
  if (result.status !== 201) {
    logger.warn('TokenPanel intent create denied', { status: result.status });
    throw toBillingError(result);
  }
  return result.body;
};

/** Cancel a pending intent — forwards to `POST /me/topup-intents/:id/cancel`. */
export const cancelTopupIntent = async (
  userId: string,
  intentId: string,
  idempotencyKey?: unknown,
  sessionToken?: string
): Promise<unknown> => {
  if (!/^[0-9a-fA-F]{24}$/.test(intentId)) {
    throw new TokenpanelBillingError('Top-up intent not found', 404);
  }
  const resolvedKey = resolveIdempotencyKey(idempotencyKey);
  const result = await callUpstreamWithAuthFallback({
    sessionToken,
    bridgeMint: () => portalTokenFor(userId),
    call: token =>
      customerFetch(
        token,
        `/public/customers/me/topup-intents/${intentId}/cancel`,
        {
          method: 'POST',
          idempotencyKey: resolvedKey,
          body: JSON.stringify({}),
        }
      ),
    context: 'billing-cancel-intent',
  });
  if (result.status !== 200) {
    logger.warn('TokenPanel intent cancel denied', { status: result.status });
    throw toBillingError(result);
  }
  return result.body;
};

/**
 * Redeem a voucher code — forwards `{code}` only. Claiming, idempotent
 * crediting (`redeem:{codeId}:{customerId}`) and settlement all happen
 * TokenPanel-side (`redeemCode` in `selfserve-billing.ts`); the credited
 * micros in the response are server-computed, never derived here.
 */
export const redeemVoucher = async (
  userId: string,
  input: { code: unknown; idempotencyKey?: unknown },
  sessionToken?: string
): Promise<unknown> => {
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  if (code.length < 4 || code.length > 64) {
    throw new TokenpanelBillingError('Invalid or already redeemed code', 400);
  }
  const resolvedKey = resolveIdempotencyKey(input.idempotencyKey);
  const result = await callUpstreamWithAuthFallback({
    sessionToken,
    bridgeMint: () => portalTokenFor(userId),
    call: token =>
      customerFetch(token, '/public/customers/me/redeem', {
        method: 'POST',
        idempotencyKey: resolvedKey,
        body: JSON.stringify({ code }),
      }),
    context: 'billing-redeem',
  });
  if (result.status !== 200) {
    logger.warn('TokenPanel redeem denied', { status: result.status });
    throw toBillingError(result);
  }
  return result.body;
};
