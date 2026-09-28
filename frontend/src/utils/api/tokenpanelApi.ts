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

export interface PortalTokenGrant {
  token: string;
  expiresAt: string;
  customerId: string;
  linked: 'existing' | 'created';
}

/**
 * Single-login bridge into the TokenPanel portal. Mints a 120s viewer JWT
 * for the caller's linked customer (created on first use). The token is
 * handed to the portal in a one-time URL fragment, never stored here.
 *
 * Billing parity (todo 21) goes through the Libre BFF instead
 * (`/api/tokenpanel/billing/*`): the browser never holds TokenPanel
 * credentials, amounts travel as integer micros, and settlement stays
 * server-side. QR payloads and `qrExpiresAt` TTLs pass through verbatim.
 */
export const tokenpanelApi = {
  exchangePortalToken(): Promise<ApiResponse<PortalTokenGrant>> {
    return api
      .post('/auth/tokenpanel/portal-token', {})
      .then(response => response.data);
  },
};

export interface BillingPageQuery {
  limit?: number;
  skip?: number;
}

export interface TopupIntentShape {
  _id?: string;
  id?: string;
  orderCode?: string;
  amountMicros: number;
  currency: string;
  method?: string;
  status?: string;
  qrExpiresAt?: string | null;
  vietqr?: string | null;
  qrPayload?: string | null;
  qrLink?: string | null;
}

const billingQuery = (query?: BillingPageQuery): string => {
  const params = new URLSearchParams();
  if (query?.limit !== undefined) params.set('limit', String(query.limit));
  if (query?.skip !== undefined) params.set('skip', String(query.skip));
  const suffix = params.toString();
  return suffix ? `?${suffix}` : '';
};

/** Billing history + recharge intents + redeem via the Libre BFF. */
export const tokenpanelBillingApi = {
  history(query?: BillingPageQuery): Promise<ApiResponse<unknown>> {
    return api
      .get(`/tokenpanel/billing/history${billingQuery(query)}`)
      .then(response => response.data);
  },
  invoices(query?: BillingPageQuery): Promise<ApiResponse<unknown>> {
    return api
      .get(`/tokenpanel/billing/invoices${billingQuery(query)}`)
      .then(response => response.data);
  },
  intents(query?: BillingPageQuery): Promise<ApiResponse<unknown>> {
    return api
      .get(`/tokenpanel/billing/topup-intents${billingQuery(query)}`)
      .then(response => response.data);
  },
  intent(id: string): Promise<ApiResponse<unknown>> {
    return api
      .get(`/tokenpanel/billing/topup-intents/${id}`)
      .then(response => response.data);
  },
  createIntent(
    amountMicros: number,
    idempotencyKey?: string
  ): Promise<ApiResponse<unknown>> {
    return api
      .post(
        '/tokenpanel/billing/topup-intents',
        { amountMicros },
        idempotencyKey
          ? { headers: { 'Idempotency-Key': idempotencyKey } }
          : undefined
      )
      .then(response => response.data);
  },
  cancelIntent(id: string): Promise<ApiResponse<unknown>> {
    return api
      .post(`/tokenpanel/billing/topup-intents/${id}/cancel`, {})
      .then(response => response.data);
  },
  redeem(code: string): Promise<ApiResponse<unknown>> {
    return api
      .post('/tokenpanel/billing/redeem', { code })
      .then(response => response.data);
  },
};

export interface TokenpanelKey {
  _id: string;
  name: string;
  prefix: string;
  fingerprint?: string;
  status: string;
  quotaMicros?: number | null;
  createdAt?: string;
}

export interface TokenpanelKeySecret {
  apiKey: TokenpanelKey;
  /** Full `tp_live_*` secret, returned exactly once per mint. */
  key: string;
  graceExpiresAt?: string | null;
}

export interface TokenpanelKeyReveal {
  key: string;
}

export interface TokenpanelProject {
  id: string;
  name: string;
  slug: string;
  status: string;
  keyCount: number;
}

export interface CreateKeyInput {
  name: string;
  /** Integer micros only — never floats. */
  quotaMicros?: number;
}

export interface UpdateKeyInput {
  name?: string;
  status?: 'active' | 'revoked';
}

/**
 * Libre-native keys + projects over the BFF (`/api/tokenpanel`, Wave4 todo
 * 19). The browser sends its Libre session only; the backend attaches the
 * management credential server-side. No management credential value is
 * ever present in browser code, requests, or responses here.
 */
export const tokenpanelKeysApi = {
  list(): Promise<ApiResponse<{ items: TokenpanelKey[]; total: number }>> {
    return api
      .get('/tokenpanel/keys', { params: { limit: 100 } })
      .then(response => response.data);
  },
  create(input: CreateKeyInput): Promise<ApiResponse<TokenpanelKeySecret>> {
    return api.post('/tokenpanel/keys', input).then(response => response.data);
  },
  reveal(keyId: string): Promise<ApiResponse<TokenpanelKeyReveal>> {
    return api
      .post(`/tokenpanel/keys/${keyId}/reveal`, {})
      .then(response => response.data);
  },
  update(
    keyId: string,
    patch: UpdateKeyInput
  ): Promise<ApiResponse<TokenpanelKey>> {
    return api
      .patch(`/tokenpanel/keys/${keyId}`, patch)
      .then(response => response.data);
  },
  revoke(keyId: string): Promise<ApiResponse<TokenpanelKey>> {
    return api
      .delete(`/tokenpanel/keys/${keyId}`)
      .then(response => response.data);
  },
  rotate(keyId: string): Promise<ApiResponse<TokenpanelKeySecret>> {
    return api
      .post(`/tokenpanel/keys/${keyId}/rotate`, {})
      .then(response => response.data);
  },
};

export const tokenpanelProjectsApi = {
  list(): Promise<ApiResponse<{ items: TokenpanelProject[] }>> {
    return api.get('/tokenpanel/projects').then(response => response.data);
  },
};
