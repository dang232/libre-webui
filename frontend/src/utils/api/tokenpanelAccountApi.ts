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
 * TokenPanel account surface through the Libre BFF (todo 22) — the browser
 * sends the Libre user session only; the BFF holds tp_mgmt_* server-side.
 * Amounts are integer micros, currency is server-pinned. Every request flows
 * through the shared `api` client, so a 401 (stale Libre session or an
 * upstream-invalid customer JWT forwarded as 401) engages the unified
 * invalid-session path: clearToken + AUTH_INVALIDATED_EVENT, single-fire.
 */

export interface AccountSubscription {
  subscription: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
}

export interface SubscribeResult {
  subscription: Record<string, unknown>;
  debited: {
    amountMicros: number;
    currency: string;
    adjustmentId: string;
  };
}

export interface AccountBudget {
  _id: string;
  periodStart: string;
  periodEnd: string;
  amountMicros: number;
  currency: string;
  alertThresholds: number[];
}

export interface AccountSpendingCap {
  maxSpendMicros: number;
  windowSeconds: number;
}

export interface AccountLimit {
  _id: string;
  projectId: string | null;
  rules: unknown[];
  spendingCap: AccountSpendingCap | null;
}

export interface AccountProfile {
  _id?: string;
  name?: string;
  email?: string;
  status?: string;
  balance?: { amountMicros: number; currency: string };
  [key: string]: unknown;
}

export type BillingPeriod = 'month' | 'quarter' | 'year';

const unwrap = <T>(response: {
  data: ApiResponse<T>;
}): Promise<ApiResponse<T>> => Promise.resolve(response.data);

export const tokenpanelAccountApi = {
  subscription(): Promise<ApiResponse<AccountSubscription>> {
    return api
      .get('/tokenpanel/account/subscription')
      .then(unwrap<AccountSubscription>);
  },

  subscribe(
    input: { planId: string; billing?: BillingPeriod },
    idempotencyKey?: string
  ): Promise<ApiResponse<SubscribeResult>> {
    return api
      .post('/tokenpanel/account/subscriptions', input, {
        ...(idempotencyKey
          ? { headers: { 'Idempotency-Key': idempotencyKey } }
          : {}),
      })
      .then(unwrap<SubscribeResult>);
  },

  plans(): Promise<ApiResponse<{ items: unknown[] }>> {
    return api
      .get('/tokenpanel/account/plans')
      .then(unwrap<{ items: unknown[] }>);
  },

  budgets(): Promise<ApiResponse<{ items: AccountBudget[] }>> {
    return api
      .get('/tokenpanel/account/budgets')
      .then(unwrap<{ items: AccountBudget[] }>);
  },

  updateBudget(
    id: string,
    patch: { amountMicros?: number; alertThresholds?: number[] }
  ): Promise<ApiResponse<AccountBudget>> {
    return api
      .patch(`/tokenpanel/account/budgets/${id}`, patch)
      .then(unwrap<AccountBudget>);
  },

  limits(): Promise<ApiResponse<{ items: AccountLimit[] }>> {
    return api
      .get('/tokenpanel/account/limits')
      .then(unwrap<{ items: AccountLimit[] }>);
  },

  updateLimits(
    spendingCap: AccountSpendingCap | null
  ): Promise<ApiResponse<AccountLimit>> {
    return api
      .patch('/tokenpanel/account/limits', { spendingCap })
      .then(unwrap<AccountLimit>);
  },

  profile(): Promise<ApiResponse<AccountProfile>> {
    return api.get('/tokenpanel/account/profile').then(unwrap<AccountProfile>);
  },

  updateProfile(patch: {
    name?: string;
    email?: string;
  }): Promise<ApiResponse<AccountProfile>> {
    return api
      .patch('/tokenpanel/account/profile', patch)
      .then(unwrap<AccountProfile>);
  },
};
