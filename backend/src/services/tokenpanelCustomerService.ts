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
 * TokenPanel customer-surface proxy (plan Wave4 todo 19).
 *
 * The browser calls the Libre BFF with its Libre user session only. This
 * service resolves the caller's linked TokenPanel customer through the
 * fail-closed bridge (server-side management key, never in the browser)
 * and mints a short-lived customer JWT that is used ONLY in server-side
 * fetch calls below. Neither the management key nor the customer JWT ever
 * leaves the server: responses carry redacted upstream payloads, and every
 * secret-bearing route sets `Cache-Control: no-store`.
 */

import {
  DEFAULT_TOKENPANEL_API_URL,
  TokenpanelBridgeError,
  exchangePortalToken,
} from './tokenpanelBridgeService.js';
import { isAlcoreAuthMode } from '../config/authMode.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:tokenpanel-customer');

export class TokenpanelCustomerError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = 'TokenpanelCustomerError';
    this.status = status;
  }
}

const apiBase = (): string =>
  (process.env.TOKENPANEL_API_URL || DEFAULT_TOKENPANEL_API_URL).replace(
    /\/+$/,
    ''
  );

export interface CustomerCallOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** JSON body forwarded verbatim (already validated by the route). */
  body?: unknown;
  /** Raw query string without the leading `?` (already validated). */
  query?: string;
  /** Client replay key, forwarded as Idempotency-Key (todo 23 owns E2E). */
  idempotencyKey?: string;
  /**
   * Caller Auth-derived Libre session JWT (gap2-bff, R-BFF1). In Alcore mode
   * the BFF tries this bearer upstream first (zero bridge calls on success)
   * and falls back to the bridge mint on upstream 401. Ignored in local
   * mode, where the bridge path below runs byte-identically to today.
   */
  sessionToken?: string;
}

export interface CustomerCallResult {
  status: number;
  body: unknown;
}

const asRecord = (body: unknown): Record<string, unknown> =>
  typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)
    : {};

/**
 * Resolve the Libre user to a TokenPanel customer and perform one upstream
 * `/public/customers/*` call with the minted customer JWT. Upstream 4xx
 * statuses are returned (never thrown) so routes can pass 404/409/422/429
 * through; upstream 401 means the customer grant is invalid and is thrown
 * so the route answers 401 and the browser invalidates the session.
 *
 * Gap2-bff (R-BFF1): in Alcore mode with `options.sessionToken`, the
 * caller's Auth-derived session is tried upstream first (zero bridge calls
 * on success); on upstream 401 the bridge mint below runs as flag-gated
 * fallback and the retry result stands. Local mode always takes the bridge
 * path byte-identically to today.
 */
export const callTokenpanelAsCustomer = async (
  userId: string,
  path: string,
  options?: CustomerCallOptions
): Promise<CustomerCallResult> => {
  const authBearer =
    isAlcoreAuthMode() &&
    typeof options?.sessionToken === 'string' &&
    options.sessionToken.length > 0
      ? options.sessionToken
      : null;
  if (authBearer !== null) {
    try {
      return await customerCall(authBearer, path, options);
    } catch (error) {
      if (!(error instanceof TokenpanelCustomerError) || error.status !== 401) {
        throw error;
      }
      logger.warn(
        'TokenPanel Auth-session upstream denied, using bridge fallback',
        {
          path,
        }
      );
    }
  }
  let customerToken: string;
  try {
    const grant = await exchangePortalToken(
      userId,
      options?.idempotencyKey !== undefined
        ? { idempotencyKey: options.idempotencyKey }
        : undefined
    );
    customerToken = grant.token;
  } catch (error) {
    if (error instanceof TokenpanelBridgeError) {
      // Bridge messages are already browser-safe (no key material).
      throw new TokenpanelCustomerError(error.message, error.status);
    }
    logger.error('TokenPanel customer resolve failed', error);
    throw new TokenpanelCustomerError(
      'TokenPanel is temporarily unavailable',
      503
    );
  }

  return customerCall(customerToken, path, options);
};

/**
 * One upstream `/public/customers/*` call with an already-resolved bearer.
 * The bearer is either the caller's Auth-derived session (Alcore mode) or
 * the bridge-minted customer JWT; the management key never appears here.
 */
const customerCall = async (
  customerToken: string,
  path: string,
  options?: CustomerCallOptions
): Promise<CustomerCallResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const query =
      options?.query !== undefined && options.query !== ''
        ? `?${options.query}`
        : '';
    const response = await fetch(
      `${apiBase()}/public/customers${path}${query}`,
      {
        method: options?.method ?? 'GET',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${customerToken}`,
          ...(options?.idempotencyKey !== undefined
            ? { 'Idempotency-Key': options.idempotencyKey }
            : {}),
        },
        ...(options?.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
      }
    );
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 401) {
      // The minted grant was rejected (suspended customer, rotated JWT
      // secret, expired grant): surface 401 so the browser clears the
      // session per the shared invalid-session contract.
      logger.warn('TokenPanel rejected the customer grant', {
        status: response.status,
      });
      throw new TokenpanelCustomerError(
        'The API Platform session is no longer valid. Sign in again.',
        401
      );
    }
    return { status: response.status, body };
  } catch (error) {
    if (error instanceof TokenpanelCustomerError) throw error;
    throw new TokenpanelCustomerError(
      `TokenPanel is unreachable: ${error instanceof Error ? error.message : 'network error'}`,
      502
    );
  } finally {
    clearTimeout(timeout);
  }
};

/** Upstream error code when the body carries one, else null. */
export const upstreamErrorCode = (body: unknown): string | null => {
  const code = asRecord(body).error;
  return typeof code === 'string' && code !== '' ? code : null;
};
