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
 * Libre BFF for TokenPanel keys + projects (plan Wave4 todo 19).
 *
 * Boundary: the browser presents its Libre user session only
 * (`authenticate`); the management key (`tp_mgmt_*`) lives in backend
 * env/config and is attached to upstream calls server-side by
 * `tokenpanelCustomerService`. Every response on this router sets
 * `Cache-Control: no-store` so key material never sits in caches; full
 * secrets are returned exactly once (create/reveal/rotate) and never
 * logged.
 *
 * Upstream contract (read-only): TokenPanel
 * `routes/public/customers-public.ts` keys (`:1223-1391`) + projects
 * (`:1035-1071`). Project create does not exist upstream (parity-matrix
 * gap) and is NOT invented here.
 */

import express from 'express';
import rateLimit from '../middleware/sharedRateLimit.js';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import {
  TokenpanelCustomerError,
  callTokenpanelAsCustomer,
  upstreamErrorCode,
} from '../services/tokenpanelCustomerService.js';
import {
  hashClientIp,
  recordAuditEvent,
} from '../services/securityAuditService.js';
import { forwardOrMintIdempotencyKey } from '../utils/idempotencyKey.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('routes:tokenpanel');
const router = express.Router();

const tokenpanelRateLimiter = rateLimit({
  keyPrefix: 'tokenpanel-bff',
  windowMs: 5 * 60 * 1000,
  max: 120,
  message: {
    success: false,
    message: 'Too many API Platform requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(tokenpanelRateLimiter, authenticate);

// Secret-adjacent surface: nothing here may be cached or stored.
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const getClientIp = (req: express.Request): string | undefined => {
  const cfConnectingIp = req.headers['cf-connecting-ip'];
  if (typeof cfConnectingIp === 'string' && cfConnectingIp.trim()) {
    return cfConnectingIp.trim();
  }
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0]?.trim();
  }
  return req.ip || undefined;
};

const KEY_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

const fail = (res: express.Response, error: unknown): void => {
  if (error instanceof TokenpanelCustomerError) {
    if (error.status >= 500) logger.error('TokenPanel BFF failed', error);
    res.status(error.status).json({ success: false, message: error.message });
    return;
  }
  logger.error('TokenPanel BFF failed', error);
  res
    .status(502)
    .json({ success: false, message: 'TokenPanel is temporarily unavailable' });
};

/**
 * Pass an upstream 4xx through with its status (404/409/422/429/402/403
 * are caller-actionable); collapse upstream 5xx to a generic 502 so
 * internals never leak. Upstream error codes are safe identifiers.
 */
const passThrough = (
  res: express.Response,
  upstream: { status: number; body: unknown }
): void => {
  const code = upstreamErrorCode(upstream.body);
  if (upstream.status >= 200 && upstream.status < 300) {
    res.status(upstream.status).json({ success: true, data: upstream.body });
    return;
  }
  if (upstream.status >= 500) {
    logger.warn('TokenPanel upstream 5xx on BFF path', {
      status: upstream.status,
    });
    res.status(502).json({
      success: false,
      message: 'TokenPanel is temporarily unavailable',
    });
    return;
  }
  res.status(upstream.status).json({
    success: false,
    message: code ?? 'TokenPanel request failed',
    ...(code !== null ? { code } : {}),
  });
};

const auditKeyOp = (
  req: express.Request,
  action: string,
  result: 'success' | 'denied',
  details?: Record<string, unknown>
): void => {
  const user = (req as AuthenticatedRequest).user;
  void recordAuditEvent({
    action,
    result,
    actorUserId: user?.userId ?? null,
    ipHash: hashClientIp(getClientIp(req)),
    ...(details !== undefined ? { details } : {}),
  });
};

// --- Query/body validation (mirrors upstream bounds, fail-closed) ---

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const buildKeysQuery = (query: Record<string, unknown>): string | 'invalid' => {
  const params = new URLSearchParams();
  const projectId = asString(query.projectId);
  if (projectId !== undefined) {
    if (projectId.length === 0 || projectId.length > 64) return 'invalid';
    params.set('projectId', projectId);
  }
  const q = asString(query.q);
  if (q !== undefined) {
    if (q.length > 160) return 'invalid';
    params.set('q', q);
  }
  const status = asString(query.status);
  if (status !== undefined) {
    if (status !== 'active' && status !== 'revoked' && status !== 'expired') {
      return 'invalid';
    }
    params.set('status', status);
  }
  const sort = asString(query.sort);
  if (sort !== undefined) {
    if (
      sort !== 'createdAt' &&
      sort !== 'lastUsedAt' &&
      sort !== 'name' &&
      sort !== 'usage'
    ) {
      return 'invalid';
    }
    params.set('sort', sort);
  }
  const order = asString(query.order);
  if (order !== undefined) {
    if (order !== 'asc' && order !== 'desc') return 'invalid';
    params.set('order', order);
  }
  const limitRaw = asString(query.limit);
  if (limitRaw !== undefined) {
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return 'invalid';
    params.set('limit', String(limit));
  }
  const skipRaw = asString(query.skip);
  if (skipRaw !== undefined) {
    const skip = Number(skipRaw);
    if (!Number.isInteger(skip) || skip < 0) return 'invalid';
    params.set('skip', String(skip));
  }
  return params.toString();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Allowlisted key create/patch body; integer-micros enforced (no floats). */
const buildKeyBody = (
  input: unknown,
  opts: { requireName: boolean }
): Record<string, unknown> | 'invalid' => {
  if (!isRecord(input)) return 'invalid';
  const out: Record<string, unknown> = {};
  const name = input.name;
  if (name !== undefined) {
    if (typeof name !== 'string' || name.length < 1 || name.length > 120) {
      return 'invalid';
    }
    out.name = name;
  } else if (opts.requireName) {
    return 'invalid';
  }
  const status = input.status;
  if (status !== undefined) {
    if (status !== 'active' && status !== 'revoked') return 'invalid';
    out.status = status;
  }
  const modelWhitelist = input.modelWhitelist;
  if (modelWhitelist !== undefined) {
    if (
      !Array.isArray(modelWhitelist) ||
      !modelWhitelist.every(
        entry =>
          typeof entry === 'string' && entry.length >= 1 && entry.length <= 80
      )
    ) {
      return 'invalid';
    }
    out.modelWhitelist = modelWhitelist;
  }
  const expiresAt = input.expiresAt;
  if (expiresAt !== undefined) {
    // ISO date string or explicit null (clear); upstream validates.
    if (
      expiresAt !== null &&
      (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt)))
    ) {
      return 'invalid';
    }
    out.expiresAt = expiresAt;
  }
  const quotaMicros = input.quotaMicros;
  if (quotaMicros !== undefined) {
    // Integer micros only — floats are rejected at the BFF boundary.
    if (!Number.isInteger(quotaMicros) || (quotaMicros as number) < 0) {
      return 'invalid';
    }
    out.quotaMicros = quotaMicros;
  }
  const rateLimits = input.rateLimits;
  if (rateLimits !== undefined) {
    if (!isRecord(rateLimits)) return 'invalid';
    out.rateLimits = rateLimits;
  }
  for (const list of ['ipWhitelist', 'ipBlacklist'] as const) {
    const entries = input[list];
    if (entries !== undefined) {
      if (
        !Array.isArray(entries) ||
        !entries.every(
          entry =>
            typeof entry === 'string' && entry.length >= 1 && entry.length <= 64
        )
      ) {
        return 'invalid';
      }
      out[list] = entries;
    }
  }
  const concurrencyLimit = input.concurrencyLimit;
  if (concurrencyLimit !== undefined) {
    if (
      concurrencyLimit !== null &&
      (!Number.isInteger(concurrencyLimit) || (concurrencyLimit as number) < 1)
    ) {
      return 'invalid';
    }
    out.concurrencyLimit = concurrencyLimit;
  }
  const groupAlias = input.groupAlias;
  if (groupAlias !== undefined) {
    if (
      groupAlias !== null &&
      (typeof groupAlias !== 'string' ||
        groupAlias.length < 1 ||
        groupAlias.length > 120)
    ) {
      return 'invalid';
    }
    out.groupAlias = groupAlias;
  }
  return out;
};

// --- Keys ---

router.get('/keys', async (req: AuthenticatedRequest, res) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  const query = buildKeysQuery(req.query as Record<string, unknown>);
  if (query === 'invalid') {
    res.status(400).json({ success: false, message: 'Invalid query' });
    return;
  }
  try {
    const upstream = await callTokenpanelAsCustomer(userId, '/keys', {
      method: 'GET',
      ...(query !== '' ? { query } : {}),
    });
    passThrough(res, upstream);
  } catch (error) {
    fail(res, error);
  }
});

router.post('/keys', async (req: AuthenticatedRequest, res) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  const body = buildKeyBody(req.body, { requireName: true });
  if (body === 'invalid') {
    res.status(400).json({ success: false, message: 'Invalid key payload' });
    return;
  }
  const keyOr = forwardOrMintIdempotencyKey(req);
  if ('invalid' in keyOr) {
    res
      .status(400)
      .json({ success: false, message: 'Invalid idempotency key' });
    return;
  }
  try {
    const upstream = await callTokenpanelAsCustomer(userId, '/keys', {
      method: 'POST',
      body,
      idempotencyKey: keyOr.key,
    });
    if (upstream.status >= 200 && upstream.status < 300) {
      auditKeyOp(req, 'tokenpanel.key.create', 'success', {});
    } else if (upstream.status < 500) {
      auditKeyOp(req, 'tokenpanel.key.create', 'denied', {
        status: upstream.status,
      });
    }
    // 201 carries the full secret exactly once; no-store is set above.
    passThrough(res, upstream);
  } catch (error) {
    auditKeyOp(req, 'tokenpanel.key.create', 'denied', {});
    fail(res, error);
  }
});

router.post('/keys/:id/reveal', async (req: AuthenticatedRequest, res) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  const keyId = String(req.params.id);
  if (!KEY_ID_PATTERN.test(keyId)) {
    res.status(404).json({ success: false, message: 'API key not found' });
    return;
  }
  const keyOr = forwardOrMintIdempotencyKey(req);
  if ('invalid' in keyOr) {
    res
      .status(400)
      .json({ success: false, message: 'Invalid idempotency key' });
    return;
  }
  try {
    const upstream = await callTokenpanelAsCustomer(
      userId,
      `/keys/${keyId}/reveal`,
      { method: 'POST', idempotencyKey: keyOr.key }
    );
    if (upstream.status >= 200 && upstream.status < 300) {
      auditKeyOp(req, 'tokenpanel.key.reveal', 'success', { keyId });
    } else if (upstream.status < 500) {
      auditKeyOp(req, 'tokenpanel.key.reveal', 'denied', {
        keyId,
        status: upstream.status,
      });
    }
    // Full secret exactly once; no-store is set above.
    passThrough(res, upstream);
  } catch (error) {
    auditKeyOp(req, 'tokenpanel.key.reveal', 'denied', { keyId });
    fail(res, error);
  }
});

router.patch('/keys/:id', async (req: AuthenticatedRequest, res) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  const keyId = String(req.params.id);
  if (!KEY_ID_PATTERN.test(keyId)) {
    res.status(404).json({ success: false, message: 'API key not found' });
    return;
  }
  const body = buildKeyBody(req.body, { requireName: false });
  if (body === 'invalid') {
    res.status(400).json({ success: false, message: 'Invalid key payload' });
    return;
  }
  const keyOr = forwardOrMintIdempotencyKey(req);
  if ('invalid' in keyOr) {
    res
      .status(400)
      .json({ success: false, message: 'Invalid idempotency key' });
    return;
  }
  try {
    const upstream = await callTokenpanelAsCustomer(userId, `/keys/${keyId}`, {
      method: 'PATCH',
      body,
      idempotencyKey: keyOr.key,
    });
    passThrough(res, upstream);
  } catch (error) {
    fail(res, error);
  }
});

router.delete('/keys/:id', async (req: AuthenticatedRequest, res) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  const keyId = String(req.params.id);
  if (!KEY_ID_PATTERN.test(keyId)) {
    res.status(404).json({ success: false, message: 'API key not found' });
    return;
  }
  const keyOr = forwardOrMintIdempotencyKey(req);
  if ('invalid' in keyOr) {
    res
      .status(400)
      .json({ success: false, message: 'Invalid idempotency key' });
    return;
  }
  // Revoke (default) or hard-delete (?purge=true); both stay server-side.
  const purge =
    (req.query as Record<string, unknown>).purge === 'true'
      ? '?purge=true'
      : '';
  try {
    const upstream = await callTokenpanelAsCustomer(
      userId,
      `/keys/${keyId}${purge}`,
      {
        method: 'DELETE',
        idempotencyKey: keyOr.key,
      }
    );
    if (upstream.status >= 200 && upstream.status < 300) {
      auditKeyOp(req, 'tokenpanel.key.revoke', 'success', {
        keyId,
        purge: purge !== '',
      });
    } else if (upstream.status < 500) {
      auditKeyOp(req, 'tokenpanel.key.revoke', 'denied', {
        keyId,
        status: upstream.status,
      });
    }
    passThrough(res, upstream);
  } catch (error) {
    auditKeyOp(req, 'tokenpanel.key.revoke', 'denied', { keyId });
    fail(res, error);
  }
});

router.post('/keys/:id/rotate', async (req: AuthenticatedRequest, res) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  const keyId = String(req.params.id);
  if (!KEY_ID_PATTERN.test(keyId)) {
    res.status(404).json({ success: false, message: 'API key not found' });
    return;
  }
  const keyOr = forwardOrMintIdempotencyKey(req);
  if ('invalid' in keyOr) {
    res
      .status(400)
      .json({ success: false, message: 'Invalid idempotency key' });
    return;
  }
  try {
    const upstream = await callTokenpanelAsCustomer(
      userId,
      `/keys/${keyId}/rotate`,
      {
        method: 'POST',
        idempotencyKey: keyOr.key,
      }
    );
    if (upstream.status >= 200 && upstream.status < 300) {
      auditKeyOp(req, 'tokenpanel.key.rotate', 'success', { keyId });
    } else if (upstream.status < 500) {
      auditKeyOp(req, 'tokenpanel.key.rotate', 'denied', {
        keyId,
        status: upstream.status,
      });
    }
    // New secret exactly once (old row revoked upstream); no-store above.
    passThrough(res, upstream);
  } catch (error) {
    auditKeyOp(req, 'tokenpanel.key.rotate', 'denied', { keyId });
    fail(res, error);
  }
});

// --- Projects (list only: no upstream create exists — parity gap, TBD) ---

router.get('/projects', async (req: AuthenticatedRequest, res) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  try {
    const upstream = await callTokenpanelAsCustomer(userId, '/me/projects', {
      method: 'GET',
    });
    passThrough(res, upstream);
  } catch (error) {
    fail(res, error);
  }
});

export default router;
