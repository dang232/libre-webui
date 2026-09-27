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
 * TokenPanel usage BFF proxy — read-only display (todo 20).
 *
 * Libre NEVER recomputes, settles, or bills. Every function below forwards
 * the caller's read to the TokenPanel customer self-service API
 * (`routes/public/customers-public.ts`: `GET /me/usage` @984,
 * `GET /me/usage/daily` @1446, `GET /me/usage/records` @1490) using the
 * 120s viewer JWT minted server-side by the bridge
 * (`tokenpanelBridgeService.ts`). The management key (`tp_mgmt_*`) and the
 * viewer JWT never leave the server.
 *
 * Server-computed values (request/token totals, `costMicros`/`priceMicros`,
 * `currency`) pass through verbatim — aggregation semantics live in
 * `domains/analytics/operations.ts` (`customerUsage`, `customerDailyUsage`,
 * `customerRecentUsage`) over settled usage rows; only `reported` provider
 * outcomes settle (`domains/providers/usage.ts:42-110`), the rest go to the
 * durable outbox. Display rounding happens once, at the render boundary, in
 * `frontend/src/utils/usageMicros.ts`.
 */

import { createLogger } from '../utils/logger.js';
import {
  TokenpanelBridgeError,
  exchangePortalToken,
} from './tokenpanelBridgeService.js';

const logger = createLogger('services:tokenpanel-usage');

export const DEFAULT_TOKENPANEL_API_URL = 'https://alcore.io.vn';

const apiBase = (): string =>
  (process.env.TOKENPANEL_API_URL || DEFAULT_TOKENPANEL_API_URL).replace(
    /\/+$/,
    ''
  );

export class TokenpanelUsageError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = 'TokenpanelUsageError';
    this.status = status;
  }
}

interface UpstreamResult {
  status: number;
  body: unknown;
}

async function customerFetch(
  portalToken: string,
  path: string
): Promise<UpstreamResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${apiBase()}${path}`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${portalToken}`,
      },
    });
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body };
  } catch (error) {
    throw new TokenpanelUsageError(
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
const toUsageError = (result: UpstreamResult): TokenpanelUsageError => {
  const code = asRecord(result.body).error;
  const message =
    typeof code === 'string' && code.length > 0
      ? `TokenPanel denied the request (${code})`
      : 'TokenPanel denied the request';
  // 422 surfaces the upstream date/limit/key validation verbatim so the UI
  // can explain a bad window without inventing its own reasons.
  const status =
    result.status === 400 ||
    result.status === 401 ||
    result.status === 403 ||
    result.status === 404 ||
    result.status === 422 ||
    result.status === 429
      ? result.status
      : 502;
  return new TokenpanelUsageError(message, status);
};

/** Resolve the caller's portal token (mgmt key stays server-side). */
const portalTokenFor = async (userId: string): Promise<string> => {
  try {
    const grant = await exchangePortalToken(userId);
    return grant.token;
  } catch (error) {
    if (error instanceof TokenpanelBridgeError) {
      throw new TokenpanelUsageError(error.message, error.status);
    }
    throw error;
  }
};

const forwardGet = async (userId: string, path: string): Promise<unknown> => {
  const token = await portalTokenFor(userId);
  const result = await customerFetch(token, path);
  if (result.status !== 200) {
    logger.warn('TokenPanel usage read denied', {
      status: result.status,
      path,
    });
    throw toUsageError(result);
  }
  return result.body;
};

/**
 * Window params (`from`/`to`) mirror the API exactly
 * (`customers-public.ts:986-992`): absent means the server default window,
 * present-but-unparseable means 422 — the BFF adds no silent widening or
 * narrowing of its own.
 */
const parseWindowParam = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  if (Number.isNaN(Date.parse(text))) {
    throw new TokenpanelUsageError(`Invalid ${name} date`, 422);
  }
  return text;
};

const withWindow = (
  path: string,
  query: { from?: unknown; to?: unknown }
): string => {
  const from = parseWindowParam(query.from, 'from');
  const to = parseWindowParam(query.to, 'to');
  const params = new URLSearchParams();
  if (from !== null) params.set('from', from);
  if (to !== null) params.set('to', to);
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
};

/** Totals — read-only passthrough of `GET /me/usage`. */
export const getUsageSummary = (
  userId: string,
  query: { from?: unknown; to?: unknown }
): Promise<unknown> =>
  forwardGet(userId, withWindow('/public/customers/me/usage', query));

/** Daily buckets — read-only passthrough of `GET /me/usage/daily`. */
export const getUsageDaily = (
  userId: string,
  query: { from?: unknown; to?: unknown }
): Promise<unknown> =>
  forwardGet(userId, withWindow('/public/customers/me/usage/daily', query));

export interface UsageRecordsQuery {
  limit?: unknown;
  model?: unknown;
  key?: unknown;
  from?: unknown;
  to?: unknown;
}

/**
 * Recent requests — read-only passthrough of `GET /me/usage/records`.
 * Validation mirrors the API (`customers-public.ts:1490-1508`): limit is an
 * integer in [1, 200] defaulting server-side to 50 when absent, `key` is a
 * 24-hex ObjectId, dates must parse. The BFF forwards each param verbatim
 * and never substitutes its own defaults.
 */
export const getUsageRecords = (
  userId: string,
  query: UsageRecordsQuery
): Promise<unknown> => {
  const params = new URLSearchParams();
  if (query.limit !== undefined && query.limit !== null && query.limit !== '') {
    const limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new TokenpanelUsageError('Invalid limit', 422);
    }
    params.set('limit', String(limit));
  }
  if (query.model !== undefined && query.model !== null && query.model !== '') {
    params.set('model', String(query.model));
  }
  if (query.key !== undefined && query.key !== null && query.key !== '') {
    const key = String(query.key);
    if (!/^[0-9a-fA-F]{24}$/.test(key)) {
      throw new TokenpanelUsageError('Invalid key', 422);
    }
    params.set('key', key);
  }
  const from = parseWindowParam(query.from, 'from');
  const to = parseWindowParam(query.to, 'to');
  if (from !== null) params.set('from', from);
  if (to !== null) params.set('to', to);
  const suffix = params.toString();
  const path = suffix
    ? `/public/customers/me/usage/records?${suffix}`
    : '/public/customers/me/usage/records';
  return forwardGet(userId, path);
};
