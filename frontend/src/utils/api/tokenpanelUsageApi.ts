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

import type { ApiResponse } from '@/types';
import { api } from './client';

/**
 * TokenPanel usage shapes, mirrored read-only from
 * `AlRepo/apps/api/src/domains/ports/usage-repository.ts`
 * (`CustomerUsageSummary`, `CustomerDailyUsageDay`, `CustomerUsageRecord`).
 * All money arrives as integer micros plus a pinned ISO currency — the BFF
 * forwards the API JSON verbatim and this client never transforms it.
 */
export interface UsageSummaryShape {
  totalRequests: number;
  totalTokens: number;
  totalCostMicros: number;
  totalPriceMicros: number;
  currency: string;
  byModel: Array<{
    modelAliasId: string;
    requests: number;
    tokens: number;
    costMicros: number;
    priceMicros: number;
  }>;
}

export interface UsageDayShape {
  day: string;
  requests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  avgDurationMs: number;
  costMicros: number;
  priceMicros: number;
  currency: string;
}

export interface UsageRecordShape {
  id: string;
  modelAliasId: string;
  apiKeyId: string | null;
  promptTokens: number;
  completionTokens: number;
  tokens: number;
  costMicros: number;
  priceMicros: number;
  currency: string;
  status: number;
  durationMs: number;
  occurredAt: string;
}

export interface UsageWindowQuery {
  from?: string;
  to?: string;
}

export interface UsageRecordsQuery extends UsageWindowQuery {
  limit?: number;
  model?: string;
  key?: string;
}

const windowQuery = (query?: UsageWindowQuery): string => {
  const params = new URLSearchParams();
  if (query?.from !== undefined) params.set('from', query.from);
  if (query?.to !== undefined) params.set('to', query.to);
  const suffix = params.toString();
  return suffix ? `?${suffix}` : '';
};

const recordsQuery = (query?: UsageRecordsQuery): string => {
  const params = new URLSearchParams();
  if (query?.limit !== undefined) params.set('limit', String(query.limit));
  if (query?.model !== undefined) params.set('model', query.model);
  if (query?.key !== undefined) params.set('key', query.key);
  if (query?.from !== undefined) params.set('from', query.from);
  if (query?.to !== undefined) params.set('to', query.to);
  const suffix = params.toString();
  return suffix ? `?${suffix}` : '';
};

/**
 * The BFF forwards the upstream JSON verbatim, so list endpoints arrive
 * wrapped (`{days: [...]}` / `{items: [...]}`) while this client promises
 * bare arrays. Unwrap the known envelopes here, at the typed boundary:
 * unknown shapes pass through untouched so the panel's own checks still
 * fail loud instead of rendering a silent empty list.
 */
const pickList = <T>(
  value: unknown,
  keys: readonly string[]
): T[] | undefined => {
  if (Array.isArray(value)) return value as T[];
  if (value !== null && typeof value === 'object') {
    for (const key of keys) {
      const nested = (value as Record<string, unknown>)[key];
      if (Array.isArray(nested)) return nested as T[];
    }
  }
  return undefined;
};

const withUnwrappedList = <T>(
  body: ApiResponse<unknown>,
  keys: readonly string[]
): ApiResponse<T[]> => {
  if (!body || typeof body !== 'object' || body.success !== true)
    return body as ApiResponse<T[]>;
  const list = pickList<T>(body.data, keys);
  return list === undefined
    ? (body as ApiResponse<T[]>)
    : { ...body, data: list };
};

/**
 * Usage + requests via the Libre BFF (`GET /api/tokenpanel/usage/*`).
 * The panel sends no window by default, so the server default window
 * applies identically on both sides of the BFF (no silent widening).
 */
export const tokenpanelUsageApi = {
  summary(query?: UsageWindowQuery): Promise<ApiResponse<UsageSummaryShape>> {
    return api
      .get(`/tokenpanel/usage/summary${windowQuery(query)}`)
      .then(response => response.data);
  },
  daily(query?: UsageWindowQuery): Promise<ApiResponse<UsageDayShape[]>> {
    return api
      .get(`/tokenpanel/usage/daily${windowQuery(query)}`)
      .then(response =>
        withUnwrappedList<UsageDayShape>(response.data, ['days'])
      );
  },
  records(query?: UsageRecordsQuery): Promise<ApiResponse<UsageRecordShape[]>> {
    return api
      .get(`/tokenpanel/usage/records${recordsQuery(query)}`)
      .then(response =>
        withUnwrappedList<UsageRecordShape>(response.data, ['items'])
      );
  },
};
