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
 * TokenPanel single-login bridge (plan §5, local-first step).
 *
 * A signed-in Libre user opens the TokenPanel portal without a second
 * password prompt. This service runs S2S: it resolves the matching
 * TokenPanel customer through the fail-closed bridge-resolve endpoint
 * (exact identity match by authUserId, else exact single email match with
 * collision → 409, never first-row-wins), then mints a 120s viewer JWT
 * through the management mint endpoint. The browser only ever sees the
 * short-lived token inside a URL fragment it consumes once.
 *
 * The management key (tp_mgmt_*, customers:read+write) lives server-side in
 * TOKENPANEL_MGMT_KEY and is never sent to the browser.
 *
 * TODO(bridge-sunset,todo29): temporary bridge — remove with the Phase 8
 * sunset (after parity 100% + migration verified + Auth login verified +
 * rollback window green). Grep marker: bridge-sunset.
 */

import { randomUUID } from 'node:crypto';
import {
  AUTH_SUBJECT_SEPARATOR,
  normalizeAuthSubject,
} from '../config/authMode.js';
import { createLogger } from '../utils/logger.js';
import { isValidIdempotencyKey } from '../utils/idempotencyKey.js';
import { userModel } from '../models/userModel.js';

const logger = createLogger('services:tokenpanel-bridge');

export const DEFAULT_TOKENPANEL_API_URL = 'https://alcore.io.vn';

export class TokenpanelBridgeError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = 'TokenpanelBridgeError';
    this.status = status;
  }
}

const apiBase = (): string =>
  (process.env.TOKENPANEL_API_URL || DEFAULT_TOKENPANEL_API_URL).replace(
    /\/+$/,
    ''
  );

const mgmtKey = (): string => {
  const key = (process.env.TOKENPANEL_MGMT_KEY || '').trim();
  if (!key) {
    throw new TokenpanelBridgeError(
      'TokenPanel bridge is not configured on this server',
      503
    );
  }
  return key;
};

async function tokenpanelFetch(
  path: string,
  init: RequestInit & { auth?: string }
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${apiBase()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init.auth ? { Authorization: `Bearer ${init.auth}` } : {}),
        ...(init.headers || {}),
      },
    });
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body };
  } catch (error) {
    throw new TokenpanelBridgeError(
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

export interface PortalTokenGrant {
  token: string;
  expiresAt: string;
  customerId: string;
  linked: 'existing' | 'created';
}

export interface BridgeExchangeOptions {
  /** Client replay key, forwarded as Idempotency-Key. Generated when absent. */
  idempotencyKey?: string;
}

const BRIDGE_IDEMPOTENCY_KEY_MAX_CHARS = 128;

// TODO(bridge-sunset,todo29): temporary bridge resolve — exact-match only.
// `limit=1` without deterministic ordering is forbidden on this path: the
// server resolves by authUserId/email with collision → 409, so this client
// never picks among rows itself.
export const exchangePortalToken = async (
  userId: string,
  options?: BridgeExchangeOptions
): Promise<PortalTokenGrant> => {
  const user = await userModel.getUserById(userId);
  if (!user) {
    throw new TokenpanelBridgeError('Account not found', 401);
  }
  const email = (user.email || '').trim().toLowerCase();
  if (!email) {
    throw new TokenpanelBridgeError(
      'Add an email address to your profile before opening the API Platform',
      400
    );
  }
  const key = mgmtKey();
  const idempotencyKey = (options?.idempotencyKey ?? randomUUID()).trim();
  if (
    idempotencyKey.length === 0 ||
    idempotencyKey.length > BRIDGE_IDEMPOTENCY_KEY_MAX_CHARS ||
    !isValidIdempotencyKey(idempotencyKey)
  ) {
    throw new TokenpanelBridgeError('Invalid idempotency key', 400);
  }

  // Libre-first identity (auth-only bridge finding): an Auth-linked row
  // stores `auth_subject` as `issuer|sub` while TokenPanel keys customers
  // by the bare Auth `sub`. Send the subject suffix when linked so a row
  // the bridge auto-creates converges with the later real Auth callback
  // instead of 409-colliding on email. Pure-local rows (NULL subject, or
  // a malformed value) keep sending the Libre id, exactly as before.
  const full = await userModel.getUserByUsername(user.username);
  const canonical = normalizeAuthSubject((full?.auth_subject ?? '').trim());
  const bridgeIdentity =
    canonical === null
      ? userId
      : canonical.slice(canonical.lastIndexOf(AUTH_SUBJECT_SEPARATOR) + 1);

  const resolved = await tokenpanelFetch(
    '/api/management/customers/bridge-resolve',
    {
      method: 'POST',
      auth: key,
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({
        authUserId: bridgeIdentity,
        email,
        name: user.username || email,
      }),
    }
  );
  if (resolved.status === 409) {
    const code = asRecord(resolved.body).error;
    logger.warn('TokenPanel bridge resolve denied', {
      status: resolved.status,
      code: typeof code === 'string' ? code : 'collision',
    });
    throw new TokenpanelBridgeError(
      'This sign-in matches multiple accounts; contact support to link it',
      409
    );
  }
  if (resolved.status === 401 || resolved.status === 403) {
    logger.warn('TokenPanel bridge resolve rejected the management key', {
      status: resolved.status,
    });
    throw new TokenpanelBridgeError(
      'TokenPanel bridge is not configured correctly',
      503
    );
  }
  if (resolved.status !== 200) {
    logger.warn('TokenPanel bridge resolve failed', {
      status: resolved.status,
    });
    throw new TokenpanelBridgeError('TokenPanel account linking failed');
  }
  const resolvedBody = asRecord(resolved.body);
  const resolvedCustomer = asRecord(resolvedBody.customer);
  const customerId = String(
    resolvedBody.customerId || resolvedCustomer._id || resolvedCustomer.id || ''
  );
  if (!customerId) {
    throw new TokenpanelBridgeError('TokenPanel account linking failed');
  }
  // Server reports created|linked|existing; the browser-facing shape stays
  // binary (a linked identity is an existing relationship).
  const linked: PortalTokenGrant['linked'] =
    resolvedBody.linked === 'created' ? 'created' : 'existing';

  const minted = await tokenpanelFetch(
    `/api/management/customers/${customerId}/portal-token`,
    { method: 'POST', auth: key }
  );
  if (minted.status !== 200) {
    logger.warn('TokenPanel portal-token mint failed', {
      status: minted.status,
    });
    throw new TokenpanelBridgeError('TokenPanel session minting failed');
  }
  const mintedBody = asRecord(minted.body);
  if (typeof mintedBody.token !== 'string' || !mintedBody.token) {
    throw new TokenpanelBridgeError('TokenPanel session minting failed');
  }
  return {
    token: mintedBody.token,
    expiresAt: String(mintedBody.expiresAt || ''),
    customerId,
    linked,
  };
};
