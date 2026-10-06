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
 * Admin-only provider credential detection and validation.
 *
 * Thin HTTP surface over the Phase 1 engine
 * (`services/providerDetection.ts`): request bodies are bounded and
 * sanitized here, every user-supplied base URL passes an egress check
 * before any live probe, and neither logs nor responses ever carry
 * secret material. The engine owns timeouts, redirect refusal, and
 * the validation taxonomy; this module owns admission only.
 *
 * SSRF discipline (ported from `utils/toolEgress.ts`): the base URL
 * host resolves to ALL DNS answers and the request is refused when
 * ANY answer is non-unicast (loopback, link-local, multicast,
 * reserved, or metadata space such as 169.254.169.254). Redirects
 * are refused by the engine's `providerRequest` default
 * (`redirect: 'error'`), so keys never follow a 3xx. A full
 * connection pin is not possible without changing the frozen Phase 1
 * engine, so the check runs immediately before the probe to keep the
 * resolve-to-use window minimal.
 *
 * Loopback and other private targets are allowed ONLY when
 * `ALLOW_PRIVATE_PROVIDER_ENDPOINTS=true` is set explicitly
 * (self-hosted gateways on trusted networks). The default is deny.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import express, { Request, Response } from 'express';
import rateLimit from '../middleware/sharedRateLimit.js';
import {
  authenticate,
  requireAdmin,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import {
  PROVIDER_DETECTION_TIMEOUT_MS,
  detectCredential,
  validateCredential,
  type CredentialInput,
  type CredentialValidationResult,
  type DetectionResult,
} from '../services/providerDetection.js';
import {
  deriveProviderHealth,
  diffDisappearedModels,
  getProviderSync,
  normalizeStoredCatalog,
  recordProviderSync,
} from '../services/providerCapabilities.js';
import pluginService from '../services/pluginService.js';
import pluginUsageService from '../services/pluginUsageService.js';
import { assertSafePluginEndpoint } from '../utils/pluginValidation.js';
import { isPublicIpAddress } from '../utils/webpageFetcher.js';
import { createLogger } from '../utils/logger.js';
import { getErrorMessage } from '../types/index.js';

export type { CredentialValidationResult };

const router = express.Router();
const logger = createLogger('routes:admin-providers');

// Admin onboarding is a detect-validate-retry flow, so this bucket is
// roomier than the login bucket (5 per 15 minutes) while staying far
// stricter than the neighboring admin and data limiters (audit at
// 120, plugin operations at 100 per 15 minutes).
const adminProvidersRateLimiter = rateLimit({
  keyPrefix: 'admin-providers',
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    success: false,
    error: 'Too many provider validation requests, try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(adminProvidersRateLimiter, authenticate, requireAdmin);

const MAX_API_KEY_CHARS = 2000;
const MAX_BASE_URL_CHARS = 2048;
const MAX_HEADERS = 10;
const MAX_HEADER_CHARS = 500;
const MAX_PROVIDER_ID_CHARS = 128;

// The engine budget plus a small margin, so the route always answers
// first instead of leaving the caller hanging on a stalled probe.
const REQUEST_CEILING_MS = PROVIDER_DETECTION_TIMEOUT_MS + 2000;

/** Header names that are never forwarded to a provider candidate. */
const DROPPED_HEADER_NAMES = new Set(['authorization', 'cookie']);

/** Set `ALLOW_PRIVATE_PROVIDER_ENDPOINTS=true` to probe trusted LAN. */
export const ALLOW_PRIVATE_PROVIDER_ENDPOINTS_ENV =
  'ALLOW_PRIVATE_PROVIDER_ENDPOINTS';

export class ProviderInputError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'ProviderInputError';
    this.reason = reason;
  }
}

export interface ParsedCredentialBody {
  input: CredentialInput;
  providerId?: string;
}

const optionalTrimmedString = (
  value: unknown,
  reason: string,
  label: string
): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ProviderInputError(reason, `${label} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Bound and sanitize a detect/validate body. Never throws on secret
 * content: length checks run before any other handling, and the
 * returned input carries the key only for the engine call.
 */
export const parseCredentialBody = (
  body: unknown,
  options: { allowProviderId: boolean }
): ParsedCredentialBody => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ProviderInputError(
      'invalid_body',
      'Request body must be a JSON object'
    );
  }
  const record = body as Record<string, unknown>;

  const rawApiKey = record.apiKey;
  if (
    rawApiKey !== undefined &&
    rawApiKey !== null &&
    typeof rawApiKey !== 'string'
  ) {
    throw new ProviderInputError('invalid_api_key', 'apiKey must be a string');
  }
  if (typeof rawApiKey === 'string' && rawApiKey.length > MAX_API_KEY_CHARS) {
    throw new ProviderInputError(
      'api_key_too_long',
      'apiKey exceeds the 2000 character limit'
    );
  }
  const apiKey = optionalTrimmedString(rawApiKey, 'invalid_api_key', 'apiKey');

  const rawBaseUrl = record.baseUrl;
  if (
    rawBaseUrl !== undefined &&
    rawBaseUrl !== null &&
    typeof rawBaseUrl !== 'string'
  ) {
    throw new ProviderInputError(
      'invalid_base_url',
      'baseUrl must be a string'
    );
  }
  if (
    typeof rawBaseUrl === 'string' &&
    rawBaseUrl.length > MAX_BASE_URL_CHARS
  ) {
    throw new ProviderInputError(
      'base_url_too_long',
      'baseUrl exceeds the 2048 character limit'
    );
  }
  const baseUrl = optionalTrimmedString(
    rawBaseUrl,
    'invalid_base_url',
    'baseUrl'
  );
  if (baseUrl !== undefined) {
    try {
      assertSafePluginEndpoint(baseUrl, 'provider base URL');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '';
      if (message.startsWith('Unsupported')) {
        throw new ProviderInputError(
          'unsupported_protocol',
          'baseUrl must be an http(s) URL'
        );
      }
      throw new ProviderInputError(
        'invalid_base_url',
        'baseUrl is not a valid URL'
      );
    }
  }

  if (apiKey === undefined && baseUrl === undefined) {
    throw new ProviderInputError(
      'missing_credential',
      'Provide at least one of apiKey or baseUrl'
    );
  }

  let headers: Record<string, string> | undefined;
  if (record.headers !== undefined && record.headers !== null) {
    const rawHeaders = record.headers;
    if (typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
      throw new ProviderInputError(
        'invalid_headers',
        'headers must be an object'
      );
    }
    const entries = Object.entries(rawHeaders);
    if (entries.length > MAX_HEADERS) {
      throw new ProviderInputError(
        'too_many_headers',
        'headers accepts at most 10 entries'
      );
    }
    headers = {};
    for (const [name, value] of entries) {
      if (typeof value !== 'string') {
        throw new ProviderInputError(
          'invalid_header',
          'header values must be strings'
        );
      }
      const cleanName = name.trim();
      const cleanValue = value.trim();
      if (cleanName.length === 0) {
        throw new ProviderInputError(
          'invalid_header',
          'header names must be non-empty'
        );
      }
      if (
        cleanName.length > MAX_HEADER_CHARS ||
        cleanValue.length > MAX_HEADER_CHARS
      ) {
        throw new ProviderInputError(
          'header_too_long',
          'header names and values are capped at 500 characters'
        );
      }
      if (DROPPED_HEADER_NAMES.has(cleanName.toLowerCase())) {
        continue;
      }
      headers[cleanName] = cleanValue;
    }
    if (Object.keys(headers).length === 0) {
      headers = undefined;
    }
  }

  let providerId: string | undefined;
  if (options.allowProviderId) {
    const rawProviderId = optionalTrimmedString(
      record.providerId,
      'invalid_provider_id',
      'providerId'
    );
    if (
      rawProviderId !== undefined &&
      rawProviderId.length > MAX_PROVIDER_ID_CHARS
    ) {
      throw new ProviderInputError(
        'provider_id_too_long',
        'providerId exceeds the 128 character limit'
      );
    }
    providerId = rawProviderId;
  }

  return {
    input: {
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(headers !== undefined ? { headers } : {}),
    },
    ...(providerId !== undefined ? { providerId } : {}),
  };
};

export interface ProviderEgressDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Refuse private, local, or unresolvable base URL targets before any
 * live probe. IP literals are classified directly; hostnames resolve
 * to every DNS answer and fail when any answer is non-unicast.
 */
export const checkProviderEgress = async (
  rawBaseUrl: string
): Promise<ProviderEgressDecision> => {
  let url: URL;
  try {
    url = new URL(rawBaseUrl.trim());
  } catch {
    return { allowed: false, reason: 'invalid_base_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: 'unsupported_protocol' };
  }
  if (url.username || url.password) {
    return { allowed: false, reason: 'credentials_in_url' };
  }
  const allowPrivate =
    process.env[ALLOW_PRIVATE_PROVIDER_ENDPOINTS_ENV] === 'true';
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  try {
    const literalKind = isIP(hostname);
    const resolved =
      literalKind !== 0
        ? [{ address: hostname }]
        : await lookup(hostname, { all: true });
    if (resolved.length === 0) {
      return { allowed: false, reason: 'dns_resolution_failed' };
    }
    for (const { address } of resolved) {
      if (!allowPrivate && !isPublicIpAddress(address)) {
        return { allowed: false, reason: 'private_network_blocked' };
      }
    }
    return { allowed: true };
  } catch {
    return { allowed: false, reason: 'dns_resolution_failed' };
  }
};

const withRequestCeiling = async <T>(work: Promise<T>): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), REQUEST_CEILING_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const sendInputError = (res: Response, error: unknown): void => {
  if (error instanceof ProviderInputError) {
    res.status(400).json({
      success: false,
      error: error.message,
      reason: error.reason,
    });
    return;
  }
  res.status(500).json({
    success: false,
    error: getErrorMessage(error, 'Failed to process the request'),
    reason: 'internal_error',
  });
};

export interface DetectResponseBody {
  candidates: DetectionResult[];
  resolved?: {
    provider: DetectionResult;
    validation: CredentialValidationResult;
  };
}

router.post('/detect', async (req: Request, res: Response): Promise<void> => {
  let parsed: ParsedCredentialBody;
  try {
    parsed = parseCredentialBody(req.body, { allowProviderId: false });
  } catch (error: unknown) {
    sendInputError(res, error);
    return;
  }

  if (parsed.input.baseUrl !== undefined) {
    const egress = await checkProviderEgress(parsed.input.baseUrl);
    if (!egress.allowed) {
      logger.debug(
        'Provider detect refused an unsafe base URL (%s)',
        egress.reason ?? 'unknown'
      );
      res.status(400).json({
        success: false,
        error: 'Provider base URL is not allowed',
        reason: egress.reason ?? 'egress_blocked',
      });
      return;
    }
  }

  const timeoutMs = PROVIDER_DETECTION_TIMEOUT_MS;
  const settled = await withRequestCeiling(
    (async (): Promise<DetectResponseBody> => {
      const candidates = await detectCredential(parsed.input, {
        timeoutMs,
      });
      // A validation probe authenticates, so it only runs when the
      // caller supplied a key; table-only matches answer directly.
      if (candidates.length === 0 || parsed.input.apiKey === undefined) {
        return { candidates };
      }
      const provider = candidates[0];
      const validation = await validateCredential(
        parsed.input,
        parsed.input.baseUrl ?? '',
        {
          timeoutMs,
          providerId:
            provider.providerId === 'openai-compatible'
              ? undefined
              : provider.providerId,
        }
      );
      return { candidates, resolved: { provider, validation } };
    })()
  );
  if (settled === null) {
    res.status(504).json({
      success: false,
      error: 'Provider detection timed out',
      reason: 'request_timed_out',
    });
    return;
  }
  logger.debug(
    'Provider detect ranked %d candidate(s)',
    settled.candidates.length
  );
  res.json({ success: true, data: settled });
});

router.post('/validate', async (req: Request, res: Response): Promise<void> => {
  let parsed: ParsedCredentialBody;
  try {
    parsed = parseCredentialBody(req.body, { allowProviderId: true });
  } catch (error: unknown) {
    sendInputError(res, error);
    return;
  }

  const baseUrl = parsed.input.baseUrl;
  if (baseUrl === undefined) {
    res.status(400).json({
      success: false,
      error: 'baseUrl is required for validation',
      reason: 'missing_base_url',
    });
    return;
  }
  const egress = await checkProviderEgress(baseUrl);
  if (!egress.allowed) {
    logger.debug(
      'Provider validate refused an unsafe base URL (%s)',
      egress.reason ?? 'unknown'
    );
    res.status(400).json({
      success: false,
      error: 'Provider base URL is not allowed',
      reason: egress.reason ?? 'egress_blocked',
    });
    return;
  }

  const timeoutMs = PROVIDER_DETECTION_TIMEOUT_MS;
  const settled = await withRequestCeiling(
    validateCredential(parsed.input, baseUrl, {
      timeoutMs,
      ...(parsed.providerId !== undefined
        ? { providerId: parsed.providerId }
        : {}),
    })
  );
  if (settled === null) {
    res.status(504).json({
      success: false,
      error: 'Provider validation timed out',
      reason: 'request_timed_out',
    });
    return;
  }
  logger.debug('Provider validate finished with status %s', settled.status);
  res.json({ success: true, data: settled });
});

/**
 * Phase 3 provider inventory. Read-only rollup over installed plugin
 * providers: no live probes (so listing never stalls on a slow
 * provider), no secrets (only a has-credential boolean), and health
 * derived from the active flag, the last on-demand sync outcome, and
 * best-effort usage aggregates.
 */
const requestUserId = (req: Request): string | undefined =>
  (req as AuthenticatedRequest).user?.userId;

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = requestUserId(req);
    const statuses = await pluginService.getPluginStatus(userId);

    // Analytics are best effort: when they are unavailable every
    // provider simply reports health from its other signals.
    const usageByPlugin = new Map<
      string,
      { calls: number; errors: number; averageLatencyMs: number }
    >();
    try {
      const analytics = await pluginUsageService.getAnalytics(7);
      for (const row of analytics.plugins) {
        usageByPlugin.set(row.pluginId, {
          calls: row.calls,
          errors: row.errors,
          averageLatencyMs: row.averageLatencyMs,
        });
      }
    } catch (error) {
      logger.debug('Provider list skipped usage aggregates:', error);
    }

    const providers = statuses.map(status => {
      const sync = getProviderSync(status.id);
      const health = deriveProviderHealth({
        active: status.active,
        ...(sync !== undefined ? { lastOutcome: sync.outcome } : {}),
        ...(sync?.reason !== undefined ? { lastReason: sync.reason } : {}),
        ...(usageByPlugin.get(status.id) !== undefined
          ? { usage: usageByPlugin.get(status.id) }
          : {}),
      });
      return {
        id: status.id,
        active: status.active,
        // Mirrors PluginStatus: usable means a credential is present
        // or none is required — never the credential itself.
        available: status.available,
        health: health.status,
        healthDetails: health.details,
        lastSync: sync ?? null,
      };
    });
    logger.debug('Provider list reported %d provider(s)', providers.length);
    res.json({ success: true, data: { providers } });
  } catch (error: unknown) {
    res.status(500).json({
      success: false,
      error: getErrorMessage(error, 'Failed to list providers'),
      reason: 'internal_error',
    });
  }
});

/**
 * Normalized models for one installed provider, from the stored
 * catalog only. Capabilities the catalog does not record stay
 * `'unknown'`; use POST sync-models to refresh the catalog first.
 */
router.get(
  '/:id/models',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = req.params.id as string;
      const plugin = await pluginService.getPlugin(id, requestUserId(req));
      if (!plugin) {
        res.status(404).json({
          success: false,
          error: `Provider not found: ${id}`,
          reason: 'provider_not_found',
        });
        return;
      }
      const models = normalizeStoredCatalog(
        plugin.model_map,
        plugin.model_context,
        plugin.model_reasoning,
        plugin.model_details
      );
      res.json({
        success: true,
        data: { providerId: plugin.id, models, count: models.length },
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to read provider models'),
        reason: 'internal_error',
      });
    }
  }
);

/**
 * On-demand model sync. Reuses the `discoverModelsResult` persist
 * path, so a retry is identical to a first run (idempotent by
 * construction). No caller-supplied URL is accepted — discovery
 * reuses the stored, already-validated endpoint, so no new egress
 * check is needed. Models the fresh catalog drops are named in
 * `unavailableMarked`; they render picker-level unavailable on the
 * next read and no record is deleted.
 */
router.post(
  '/:id/sync-models',
  async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id as string;
    const userId = requestUserId(req);
    try {
      const before = await pluginService.getPlugin(id, userId);
      if (!before) {
        res.status(404).json({
          success: false,
          error: `Provider not found: ${id}`,
          reason: 'provider_not_found',
        });
        return;
      }
      const settled = await withRequestCeiling(
        pluginService.discoverModelsResult(id, userId)
      );
      if (settled === null) {
        res.status(504).json({
          success: false,
          error: 'Provider model sync timed out',
          reason: 'request_timed_out',
        });
        return;
      }
      recordProviderSync(id, settled.outcome, settled.reason);
      const after = await pluginService.getPlugin(id, userId);
      const afterIds = after?.model_map ?? settled.models;
      const unavailableMarked = diffDisappearedModels(
        before.model_map,
        afterIds
      );
      const models = normalizeStoredCatalog(
        afterIds,
        after?.model_context,
        after?.model_reasoning,
        after?.model_details
      );
      logger.debug(
        'Provider model sync for %s finished with outcome %s (%d models)',
        id,
        settled.outcome,
        models.length
      );
      res.json({
        success: true,
        data: {
          providerId: id,
          models,
          outcome: settled.outcome,
          reason: settled.reason,
          unavailableMarked,
        },
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to sync provider models'),
        reason: 'internal_error',
      });
    }
  }
);

export default router;
