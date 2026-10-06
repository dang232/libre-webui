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
 * Phase 3 provider capabilities: normalization, derived health, and a
 * routing resolver helper.
 *
 * Normalization never invents: every capability defaults to `'unknown'`
 * and is only set from an explicit listing field. Discovery persists
 * just identifiers plus context/reasoning maps, so raw-entry fields
 * (OpenAI-style `supported_parameters`, Ollama `capabilities`) are read
 * here when a raw entry is available and stay `'unknown'` otherwise.
 *
 * Health is derived from existing telemetry only — the plugin active
 * flag, the last discovery/sync outcome, and usage aggregates. No new
 * tables, no new scheduler: sync is on-demand through the existing
 * `discoverModelsResult` persist path, and disappeared models surface
 * as picker-level unavailable (the stored catalog simply no longer
 * lists them) instead of being deleted.
 */

import type { Plugin } from '../types/index.js';
import {
  readModelContextLength,
  readModelReasoningSupport,
  type PluginModelContextMap,
  type PluginModelDetailsMap,
  type PluginModelReasoningMap,
} from '../utils/pluginModelCatalog.js';
import pluginService, {
  type PluginModelDiscoveryOutcome,
} from './pluginService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:provider-capabilities');

/** One capability: known true/false, or `'unknown'` when unreported. */
export type CapabilityValue = boolean | 'unknown';

export interface ProviderModelCapabilities {
  chat: CapabilityValue;
  streaming: CapabilityValue;
  vision: CapabilityValue;
  tools: CapabilityValue;
  structuredOutput: CapabilityValue;
  reasoning: CapabilityValue;
  embeddings: CapabilityValue;
  audioInput: CapabilityValue;
  audioOutput: CapabilityValue;
}

export interface ProviderModelLimits {
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface NormalizedProviderModel {
  id: string;
  capabilities: ProviderModelCapabilities;
  limits: ProviderModelLimits;
}

const unknownCapabilities = (): ProviderModelCapabilities => ({
  chat: 'unknown',
  streaming: 'unknown',
  vision: 'unknown',
  tools: 'unknown',
  structuredOutput: 'unknown',
  reasoning: 'unknown',
  embeddings: 'unknown',
  audioInput: 'unknown',
  audioOutput: 'unknown',
});

/**
 * Output-token fields worth trusting. `max_tokens` is deliberately
 * absent: providers use it for input budgets too, so reading it as an
 * output ceiling would invent a limit the provider never stated.
 */
const MAX_OUTPUT_TOKENS_KEYS = [
  'max_output_tokens',
  'max_completion_tokens',
] as const;

const REASONING_PARAMETERS = new Set([
  'reasoning',
  'include_reasoning',
  'reasoning_effort',
]);

const TOOL_PARAMETERS = new Set(['tools', 'tool_choice']);

const STRUCTURED_OUTPUT_PARAMETERS = new Set([
  'response_format',
  'structured_outputs',
  'json_schema',
]);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asPositiveInt = (value: unknown): number | undefined => {
  const numeric = typeof value === 'string' ? Number(value) : value;
  return typeof numeric === 'number' && Number.isInteger(numeric) && numeric > 0
    ? numeric
    : undefined;
};

const asStringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (item): item is string => typeof item === 'string'
  );
  return items;
};

/**
 * Normalize one raw model-listing entry. Accepts OpenAI-style entries
 * (`id`, `context_length`-family fields, `supported_parameters`) and
 * Ollama `/api/show`-style entries (`name`/`model`, `capabilities`
 * array). Returns null for entries without a usable identifier.
 *
 * Field mapping (response field -> capability):
 * - `context_length` (and the `pluginModelCatalog` spellings) ->
 *   `limits.contextWindow`
 * - `max_output_tokens` / `max_completion_tokens` ->
 *   `limits.maxOutputTokens`
 * - `supported_parameters` containing `reasoning` /
 *   `include_reasoning` / `reasoning_effort` -> `reasoning`
 * - `supported_parameters` containing `tools` / `tool_choice` ->
 *   `tools`
 * - `supported_parameters` containing `response_format` /
 *   `structured_outputs` / `json_schema` -> `structuredOutput`
 * - `capabilities` containing `completion` / `vision` / `tools` /
 *   `thinking` / `embedding(s)` -> `chat` / `vision` / `tools` /
 *   `reasoning` / `embeddings`
 * - `capabilities` as an object with boolean `tools` / `json_mode` /
 *   `structured_output` -> `tools` / `structuredOutput`
 * - `reasoning: true` -> `reasoning`
 *
 * A present `supported_parameters` array is an explicit provider
 * statement, so its silence on a checked parameter reads as false;
 * an absent array (or absent `capabilities`) leaves everything it
 * would have described at `'unknown'`. `chat`, `streaming`,
 * `audioInput`, and `audioOutput` have no listing-level signal and
 * stay `'unknown'`.
 */
export const normalizeListingEntry = (
  entry: unknown
): NormalizedProviderModel | null => {
  const record = asRecord(entry);
  if (!record) return null;
  const rawId = record.id ?? record.name ?? record.model;
  if (typeof rawId !== 'string' || rawId.length === 0) return null;

  const capabilities = unknownCapabilities();
  const limits: ProviderModelLimits = {};

  const contextWindow = readModelContextLength(record);
  if (contextWindow !== undefined) {
    limits.contextWindow = contextWindow;
  }
  for (const key of MAX_OUTPUT_TOKENS_KEYS) {
    const maxOutput = asPositiveInt(record[key]);
    if (maxOutput !== undefined) {
      limits.maxOutputTokens = maxOutput;
      break;
    }
  }

  const supportedParameters = asStringList(record.supported_parameters);
  if (supportedParameters !== undefined) {
    const parameters = new Set(supportedParameters);
    capabilities.reasoning = [...REASONING_PARAMETERS].some(parameter =>
      parameters.has(parameter)
    );
    capabilities.tools = [...TOOL_PARAMETERS].some(parameter =>
      parameters.has(parameter)
    );
    capabilities.structuredOutput = [...STRUCTURED_OUTPUT_PARAMETERS].some(
      parameter => parameters.has(parameter)
    );
  } else {
    // Without the array there is no provider statement to read, so
    // fall back to the entry's own reasoning signals only.
    const support = readModelReasoningSupport(record);
    if (support !== undefined) {
      capabilities.reasoning = support;
    }
  }

  // Ollama-style capability tokens only ever promote `'unknown'`
  // to true: an array that omits a token is not a denial.
  const tokens = asStringList(record.capabilities);
  if (tokens !== undefined) {
    const reported = new Set(tokens);
    if (reported.has('completion') && capabilities.chat === 'unknown') {
      capabilities.chat = true;
    }
    if (reported.has('vision') && capabilities.vision === 'unknown') {
      capabilities.vision = true;
    }
    if (reported.has('tools') && capabilities.tools === 'unknown') {
      capabilities.tools = true;
    }
    if (
      (reported.has('thinking') || reported.has('reasoning')) &&
      capabilities.reasoning === 'unknown'
    ) {
      capabilities.reasoning = true;
    }
    if (
      (reported.has('embedding') || reported.has('embeddings')) &&
      capabilities.embeddings === 'unknown'
    ) {
      capabilities.embeddings = true;
    }
  }

  // Object-form capabilities (`{ tools: true, json_mode: true }`, as
  // Alcore publishes) are explicit provider statements: a present
  // boolean is recorded, an absent key stays `'unknown'`.
  const capabilityFlags = asRecord(record.capabilities);
  if (capabilityFlags !== null && !Array.isArray(record.capabilities)) {
    const flag = (key: string): boolean | undefined => {
      const value = capabilityFlags[key];
      return typeof value === 'boolean' ? value : undefined;
    };
    const tools = flag('tools');
    if (tools !== undefined) capabilities.tools = tools;
    const structured = flag('structured_output') ?? flag('json_mode');
    if (structured !== undefined) capabilities.structuredOutput = structured;
  }

  return { id: rawId, capabilities, limits };
};

/**
 * Normalize a stored catalog: identifiers plus the context/reasoning
 * maps and per-model details discovery persists. Everything the maps do
 * not cover stays `'unknown'` — membership in a model list is not a
 * capability claim.
 */
export const normalizeStoredCatalog = (
  modelIds: readonly unknown[],
  contextMap?: PluginModelContextMap,
  reasoningMap?: PluginModelReasoningMap,
  detailsMap?: PluginModelDetailsMap
): NormalizedProviderModel[] => {
  const seen = new Set<string>();
  const normalized: NormalizedProviderModel[] = [];
  for (const candidate of modelIds) {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      continue;
    }
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const capabilities = unknownCapabilities();
    const limits: ProviderModelLimits = {};
    const contextWindow = contextMap?.[candidate];
    if (
      typeof contextWindow === 'number' &&
      Number.isInteger(contextWindow) &&
      contextWindow > 0
    ) {
      limits.contextWindow = contextWindow;
    }
    const reasoning = reasoningMap?.[candidate];
    if (typeof reasoning === 'boolean') {
      capabilities.reasoning = reasoning;
    }
    const details = detailsMap?.[candidate];
    if (typeof details?.tools === 'boolean') {
      capabilities.tools = details.tools;
    }
    const structured = details?.structuredOutput ?? details?.jsonMode;
    if (typeof structured === 'boolean') {
      capabilities.structuredOutput = structured;
    }
    normalized.push({ id: candidate, capabilities, limits });
  }
  return normalized;
};

export type ProviderHealthStatus =
  'healthy' | 'degraded' | 'rate_limited' | 'unavailable' | 'disabled';

/**
 * Minimum usage calls before an error share can move health. Below
 * this a single failure would flap a provider between states.
 */
export const HEALTH_MIN_CALLS_FOR_ERROR_SIGNAL = 5;

/** Error share at or above which a reachable provider reads degraded. */
export const HEALTH_ERROR_RATE_DEGRADED = 0.25;

/**
 * Average latency at or above this multiple of the caller's baseline
 * reads degraded. There is no recorded baseline in usage aggregates
 * (success/error/cancelled plus average latency only), so latency is
 * evaluated solely when the caller supplies one.
 */
export const HEALTH_LATENCY_DEGRADED_MULTIPLIER = 3;

const RATE_LIMIT_REASON_PATTERN = /rate.?limit|http\s*429|\b429\b/i;

export interface ProviderUsageSummary {
  calls: number;
  errors: number;
  averageLatencyMs: number;
}

export interface DeriveHealthInput {
  active: boolean;
  lastOutcome?: PluginModelDiscoveryOutcome;
  lastReason?: string;
  usage?: ProviderUsageSummary;
  baselineMs?: number;
}

export interface DerivedProviderHealth {
  status: ProviderHealthStatus;
  details: string[];
}

/** True when a discovery/sync reason reports provider throttling. */
export const isRateLimitReason = (reason?: string): boolean =>
  typeof reason === 'string' && RATE_LIMIT_REASON_PATTERN.test(reason);

/**
 * Derive provider health from existing telemetry. Precedence is
 * deliberate: an explicit admin deactivation wins, then the freshest
 * discovery signal, then usage evidence. Unknown usage is not a bad
 * signal — a provider with no adverse evidence reads healthy.
 */
export const deriveProviderHealth = (
  input: DeriveHealthInput
): DerivedProviderHealth => {
  if (!input.active) {
    return { status: 'disabled', details: ['plugin is not active'] };
  }
  if (input.lastOutcome === 'unavailable') {
    return {
      status: 'unavailable',
      details: [
        `last discovery could not reach the provider${input.lastReason ? `: ${input.lastReason}` : ''}`,
      ],
    };
  }
  if (isRateLimitReason(input.lastReason)) {
    return {
      status: 'rate_limited',
      details: [`provider reported throttling: ${input.lastReason}`],
    };
  }
  const usage = input.usage;
  if (
    usage &&
    usage.calls >= HEALTH_MIN_CALLS_FOR_ERROR_SIGNAL &&
    usage.calls > 0 &&
    usage.errors / usage.calls >= HEALTH_ERROR_RATE_DEGRADED
  ) {
    return {
      status: 'degraded',
      details: [
        `error share ${usage.errors}/${usage.calls} reaches the ${HEALTH_ERROR_RATE_DEGRADED} threshold`,
      ],
    };
  }
  if (
    usage &&
    input.baselineMs !== undefined &&
    input.baselineMs > 0 &&
    usage.averageLatencyMs >=
      input.baselineMs * HEALTH_LATENCY_DEGRADED_MULTIPLIER
  ) {
    return {
      status: 'degraded',
      details: [
        `average latency ${usage.averageLatencyMs}ms is ${HEALTH_LATENCY_DEGRADED_MULTIPLIER}x the ${input.baselineMs}ms baseline`,
      ],
    };
  }
  return { status: 'healthy', details: ['no adverse signals'] };
};

/**
 * Identifiers present before a sync but absent after it. The sync
 * persist path already replaces the stored catalog, so these models
 * render picker-level unavailable on the next read; this helper only
 * names them for the sync response. Records are never deleted here.
 */
export const diffDisappearedModels = (
  before: readonly string[],
  after: readonly string[]
): string[] => {
  const current = new Set(after);
  return before.filter(id => !current.has(id));
};

export interface ProviderSyncRecord {
  outcome: PluginModelDiscoveryOutcome;
  reason?: string;
  at: number;
}

const lastSyncByPlugin = new Map<string, ProviderSyncRecord>();

/** Remember the last on-demand sync per plugin (process-local). */
export const recordProviderSync = (
  pluginId: string,
  outcome: PluginModelDiscoveryOutcome,
  reason?: string
): void => {
  lastSyncByPlugin.set(pluginId, {
    outcome,
    ...(reason !== undefined ? { reason } : {}),
    at: Date.now(),
  });
};

export const getProviderSync = (
  pluginId: string
): ProviderSyncRecord | undefined => lastSyncByPlugin.get(pluginId);

export const clearProviderSyncRecords = (): void => {
  lastSyncByPlugin.clear();
};

export interface ModelRouteCandidate {
  pluginId: string;
  health: ProviderHealthStatus;
}

const HEALTH_PRECEDENCE: Record<ProviderHealthStatus, number> = {
  healthy: 0,
  degraded: 1,
  rate_limited: 2,
  unavailable: 3,
  disabled: 4,
};

/**
 * Order the plugins that serve a model, healthiest first. The input
 * order is the existing first-match scan order, which is preserved
 * within equal health so routing preferences never shuffle.
 */
export const orderModelCandidates = (
  modelId: string,
  candidates: ReadonlyArray<{
    pluginId: string;
    models: readonly string[];
    health: ProviderHealthStatus;
  }>
): ModelRouteCandidate[] => {
  const trimmed = modelId.trim();
  if (trimmed.length === 0) return [];
  return candidates
    .filter(candidate => candidate.models.includes(trimmed))
    .sort(
      (left, right) =>
        HEALTH_PRECEDENCE[left.health] - HEALTH_PRECEDENCE[right.health]
    )
    .map(candidate => ({
      pluginId: candidate.pluginId,
      health: candidate.health,
    }));
};

/**
 * Resolver helper for a future router integration: the ordered
 * plugins that can serve a model, healthiest first. Reuses the
 * `getActivePluginForModel` scan semantics (explicitly activated
 * plugins only, in scan order) without changing chat routing —
 * callers decide what to do with the ordering.
 */
export const resolveModel = async (
  modelId: string,
  userId?: string,
  healthOf?: (pluginId: string) => ProviderHealthStatus
): Promise<ModelRouteCandidate[]> => {
  const trimmed = modelId.trim();
  if (trimmed.length === 0) return [];
  let plugins: Plugin[];
  try {
    plugins = await pluginService.getActivePlugins(userId);
  } catch (error) {
    logger.warn('Model resolution could not list plugins:', error);
    return [];
  }
  const candidates = plugins.map(plugin => ({
    pluginId: plugin.id,
    models: plugin.model_map,
    health:
      healthOf?.(plugin.id) ?? deriveProviderHealth({ active: true }).status,
  }));
  return orderModelCandidates(trimmed, candidates);
};
