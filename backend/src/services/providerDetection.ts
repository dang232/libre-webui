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
 * Phase 1 provider detection: a multi-signal engine plus a registry
 * facade that plugs into the existing plugin architecture.
 *
 * Detection never creates tables, routes, or a parallel provider
 * abstraction. It only reads installed plugin definitions and probes
 * caller-supplied credentials. Detection results never carry secret
 * material: only masked lengths reach the logs, never return values.
 *
 * Deviation from the enterprise spec, by design: `CredentialInput`
 * carries a single `apiKey` (Alcore credentials are single API keys
 * bound to a routing fingerprint); there is no `accessToken` field.
 */

import { createLogger } from '../utils/logger.js';
import {
  assertSafePluginEndpoint,
  resolvePluginModelsEndpoint,
} from '../utils/pluginValidation.js';
import {
  isProviderHttpError,
  isProviderTimeout,
  ProviderNetworkError,
  providerRequest,
} from '../utils/providerFetch.js';
import type { Plugin } from '../types/index.js';
import pluginService from './pluginService.js';

const logger = createLogger('services:provider-detection');

/** Default probe budget, mirroring model-discovery timeouts. */
export const PROVIDER_DETECTION_TIMEOUT_MS = 5000;

/** Fallback identity for reachable endpoints outside the table. */
export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible';

/**
 * Caller-supplied credential under test. Alcore stores one API key
 * per plugin/user binding, so only a single key is accepted here.
 */
export interface CredentialInput {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export type DetectionMethod =
  | 'explicit'
  | 'base_url'
  | 'credential_format'
  | 'validation'
  | 'model_discovery';

export interface DetectionResult {
  providerId: string;
  confidence: number;
  method: DetectionMethod;
  reason: string;
}

export type CredentialValidationStatus =
  'valid' | 'invalid' | 'rate_limited' | 'unreachable' | 'timeout';

export interface CredentialValidationResult {
  status: CredentialValidationStatus;
  providerId?: string;
  latencyMs?: number;
  reason?: string;
}

/** Minimal probe transport so tests never touch the network. */
export interface DetectionFetchResponse {
  status: number;
  statusText?: string;
}

export type DetectionFetchImpl = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    timeoutMs: number;
  }
) => Promise<DetectionFetchResponse>;

export interface DetectionOptions {
  timeoutMs?: number;
  fetchImpl?: DetectionFetchImpl;
}

export interface ValidateOptions extends DetectionOptions {
  providerId?: string;
}

/** One row of the canonical table derived from plugins/*.json. */
export interface KnownProvider {
  providerId: string;
  baseUrl: string;
  endpoint: string;
  host: string;
  authHeader: string;
  keyEnv: string;
}

// Only the bundled alcore manifest ships now. Every other endpoint is
// probed generically and reported as `openai-compatible` when reachable,
// so the canonical table below stays empty by design.
const KNOWN_PROVIDERS: KnownProvider[] = [];

// No vendor key prefixes remain: every reachable endpoint is validated
// generically (see detectCredential) instead of being matched to a vendor.
const CREDENTIAL_HINTS: Array<{
  prefix: string;
  providerId: string;
  boost: number;
}> = [];

export class ProviderDetectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProviderDetectionError';
    this.code = code;
  }
}

const normalizeUrl = (raw: string): string | null => {
  try {
    const url = new URL(raw.trim());
    url.hash = '';
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${path}`.toLowerCase();
  } catch {
    return null;
  }
};

const hostOf = (raw: string): string | null => {
  try {
    return new URL(raw.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const tableMatchExact = (normalized: string): KnownProvider | null => {
  for (const entry of KNOWN_PROVIDERS) {
    if (
      normalizeUrl(entry.baseUrl) === normalized ||
      normalizeUrl(entry.endpoint) === normalized
    ) {
      return entry;
    }
  }
  return null;
};

const tableMatchHost = (host: string): KnownProvider | null => {
  for (const entry of KNOWN_PROVIDERS) {
    if (host === entry.host || host.endsWith(`.${entry.host}`)) {
      return entry;
    }
  }
  return null;
};

const roundConfidence = (value: number): number =>
  Math.min(1, Math.round(value * 100) / 100);

const mapHttpStatusToValidation = (
  status: number,
  providerId: string | undefined
): CredentialValidationResult => {
  if (status >= 200 && status < 300) {
    // Latency is attached by the caller, which owns the timer.
    return { status: 'valid', providerId };
  }
  if (status === 401) {
    return {
      status: 'invalid',
      providerId,
      reason: 'authentication_failed',
    };
  }
  if (status === 403) {
    return {
      status: 'invalid',
      providerId,
      reason: 'authorization_failed',
    };
  }
  if (status === 429) {
    return { status: 'rate_limited', providerId, reason: 'rate_limited' };
  }
  if (status >= 500) {
    return {
      status: 'unreachable',
      providerId,
      reason: `provider_error_${status}`,
    };
  }
  return {
    status: 'invalid',
    providerId,
    reason: `unexpected_status_${status}`,
  };
};

/**
 * Live check of one credential against one base URL: an authed
 * GET of the derived `/models` endpoint. Scheme checks come from
 * pluginValidation and the timeout/error taxonomy from
 * providerRequest, which refuses redirects by default so keys never
 * follow a 3xx. Never returns secret material.
 */
export async function validateCredential(
  input: CredentialInput,
  resolvedBaseUrl: string,
  options: ValidateOptions = {}
): Promise<CredentialValidationResult> {
  const timeoutMs = options.timeoutMs ?? PROVIDER_DETECTION_TIMEOUT_MS;
  const providerId = options.providerId;

  let modelsUrl: string;
  try {
    assertSafePluginEndpoint(resolvedBaseUrl, 'provider base URL');
    modelsUrl = resolvePluginModelsEndpoint(resolvedBaseUrl);
    assertSafePluginEndpoint(modelsUrl, 'provider models endpoint');
  } catch {
    return { status: 'unreachable', providerId, reason: 'invalid_base_url' };
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (input.apiKey) {
    headers.Authorization = `Bearer ${input.apiKey}`;
  }
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers[name] = value;
  }

  const started = Date.now();
  try {
    if (options.fetchImpl) {
      const response = await options.fetchImpl(modelsUrl, {
        method: 'GET',
        headers,
        timeoutMs,
      });
      const result = mapHttpStatusToValidation(response.status, providerId);
      if (result.status === 'valid') {
        result.latencyMs = Date.now() - started;
      }
      return result;
    }
    const response = await providerRequest<unknown>({
      url: modelsUrl,
      headers,
      timeoutMs,
    });
    const result = mapHttpStatusToValidation(response.status, providerId);
    if (result.status === 'valid') {
      result.latencyMs = Date.now() - started;
    }
    return result;
  } catch (error: unknown) {
    if (isProviderTimeout(error)) {
      return { status: 'timeout', providerId, reason: 'request_timed_out' };
    }
    if (isProviderHttpError(error)) {
      return mapHttpStatusToValidation(error.response.status, providerId);
    }
    if (
      error instanceof ProviderNetworkError ||
      (typeof error === 'object' && error !== null && 'request' in error)
    ) {
      return {
        status: 'unreachable',
        providerId,
        reason: 'host_unreachable',
      };
    }
    return { status: 'unreachable', providerId, reason: 'request_failed' };
  }
}

/**
 * Rank provider candidates for a credential, highest confidence
 * first: exact table match (1.0/explicit), host match (0.9/base_url),
 * then at most +0.1 from an auth-format hint, then one live
 * validation/discovery probe when a key and URL are both present.
 * Unknown-but-reachable endpoints yield `openai-compatible`, never a
 * forced vendor fit. A bare key with an unknown URL yields nothing.
 */
export async function detectCredential(
  input: CredentialInput,
  options: DetectionOptions = {}
): Promise<DetectionResult[]> {
  const candidates: DetectionResult[] = [];
  const rawUrl = input.baseUrl?.trim() || undefined;
  const normalized = rawUrl ? normalizeUrl(rawUrl) : null;
  const host = rawUrl ? hostOf(rawUrl) : null;

  if (normalized) {
    const exact = tableMatchExact(normalized);
    if (exact) {
      candidates.push({
        providerId: exact.providerId,
        confidence: 1,
        method: 'explicit',
        reason: `base_url_matches_${exact.providerId}_table_entry`,
      });
    } else if (host) {
      const hostMatch = tableMatchHost(host);
      if (hostMatch) {
        candidates.push({
          providerId: hostMatch.providerId,
          confidence: 0.9,
          method: 'base_url',
          reason: `host_matches_${hostMatch.providerId}_endpoint`,
        });
      }
    }
  }

  if (input.apiKey) {
    for (const hint of CREDENTIAL_HINTS) {
      if (!input.apiKey.startsWith(hint.prefix)) continue;
      for (const candidate of candidates) {
        if (candidate.providerId !== hint.providerId) continue;
        candidate.confidence = roundConfidence(
          candidate.confidence + hint.boost
        );
        candidate.reason += '+credential_format_hint';
      }
      break;
    }
  }

  if (rawUrl && input.apiKey) {
    const top = candidates[0];
    const validation = await validateCredential(input, rawUrl, {
      ...options,
      providerId: top?.providerId,
    });
    if (validation.status === 'valid') {
      const confirmed = validation.providerId ?? top?.providerId;
      if (confirmed) {
        candidates.push({
          providerId: confirmed,
          confidence: 0.95,
          method: 'validation',
          reason: 'live_models_request_succeeded',
        });
      } else {
        candidates.push({
          providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
          confidence: 0.7,
          method: 'model_discovery',
          reason: 'reachable_openai_compatible_models_endpoint',
        });
      }
    } else if (
      (validation.status === 'invalid' ||
        validation.status === 'rate_limited') &&
      candidates.length === 0
    ) {
      candidates.push({
        providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
        confidence: 0.5,
        method: 'model_discovery',
        reason: `reachable_but_${validation.reason ?? 'unauthorized'}`,
      });
    }
    // The enclosing branch already establishes that a key was supplied;
    // its length is key-derived metadata and stays out of the logs.
    logger.debug(
      'Provider detection probed a candidate endpoint: %s',
      validation.status
    );
  }

  return candidates.sort((a, b) => b.confidence - a.confidence);
}

export interface ResolvedProvider {
  provider: DetectionResult;
  validation: CredentialValidationResult;
}

/**
 * Top detection candidate plus its live validation. Throws a typed
 * error when detection yields nothing reachable.
 */
export async function resolveProvider(
  input: CredentialInput,
  options: DetectionOptions = {}
): Promise<ResolvedProvider> {
  const candidates = await detectCredential(input, options);
  if (candidates.length === 0) {
    logger.debug(
      'Provider detection found no candidate (baseUrl length %d)',
      input.baseUrl?.length ?? 0
    );
    throw new ProviderDetectionError(
      'no_candidate',
      'No provider candidate is reachable for the supplied credential'
    );
  }
  const provider = candidates[0];
  const validation = await validateCredential(input, input.baseUrl ?? '', {
    ...options,
    providerId:
      provider.providerId === OPENAI_COMPATIBLE_PROVIDER_ID
        ? undefined
        : provider.providerId,
  });
  return { provider, validation };
}

/** Registry facade: the canonical table, safe to expose. */
export function listKnownProviders(): KnownProvider[] {
  return KNOWN_PROVIDERS.map(entry => ({ ...entry }));
}

export interface InstalledPluginScore {
  pluginId: string;
  providerId: string | null;
  score: number;
  reason: string;
}

/**
 * Rank already-installed plugin definitions against a credential
 * URL. Read-only reuse of pluginService: no writes, no behavior
 * changes. Callers may inject fixtures via `options.plugins`.
 */
export async function scoreInstalledPlugins(
  input: CredentialInput,
  options: { userId?: string; plugins?: Plugin[] } = {}
): Promise<InstalledPluginScore[]> {
  const plugins =
    options.plugins ?? (await pluginService.getAllPlugins(options.userId));
  const normalized = input.baseUrl?.trim()
    ? normalizeUrl(input.baseUrl.trim())
    : null;
  const host = input.baseUrl?.trim() ? hostOf(input.baseUrl.trim()) : null;

  const scored = plugins.map((plugin): InstalledPluginScore => {
    const refs = [plugin.base_url, plugin.endpoint].filter(
      (ref): ref is string => typeof ref === 'string' && ref.length > 0
    );
    let best: InstalledPluginScore = {
      pluginId: plugin.id,
      providerId: null,
      score: 0,
      reason: 'no_url_match',
    };
    for (const ref of refs) {
      const refNormalized = normalizeUrl(ref);
      if (normalized && refNormalized && refNormalized === normalized) {
        const table = tableMatchExact(refNormalized);
        return {
          pluginId: plugin.id,
          providerId: table?.providerId ?? null,
          score: 1,
          reason: 'installed_endpoint_matches_input',
        };
      }
      const refHost = hostOf(ref);
      if (host && refHost && refHost === host) {
        const table = tableMatchHost(refHost);
        best = {
          pluginId: plugin.id,
          providerId: table?.providerId ?? null,
          score: 0.9,
          reason: 'installed_host_matches_input',
        };
      }
    }
    return best;
  });

  return scored.sort((a, b) => b.score - a.score);
}
