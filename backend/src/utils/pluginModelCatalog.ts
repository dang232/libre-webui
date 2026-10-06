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
 * What a provider's model listing says about its models.
 *
 * Discovery used to keep only the identifiers. A context window is worth
 * keeping too: without it the application can count the tokens a conversation
 * spends but has nothing to measure them against, which is the difference
 * between a number and a gauge.
 *
 * Providers name the field differently and some do not report it at all, so
 * every known spelling is read and a missing one is simply absent.
 */

/** Context-window fields, in the order providers are most likely to mean. */
const CONTEXT_LENGTH_KEYS = [
  'context_length',
  'context_window',
  'max_context_length',
  'max_context_tokens',
  'max_input_tokens',
  'inputTokenLimit',
] as const;

/**
 * Reported windows are token counts. A value that is not a positive whole
 * number is a provider quirk rather than a window, and is dropped instead of
 * being shown as a budget the user cannot trust.
 */
const asContextLength = (value: unknown): number | undefined => {
  const length = typeof value === 'string' ? Number(value) : value;
  return typeof length === 'number' &&
    Number.isFinite(length) &&
    Number.isInteger(length) &&
    length > 0
    ? length
    : undefined;
};

/**
 * The context window from one entry of a model listing. OpenRouter repeats it
 * under `top_provider`, where it reflects the provider actually serving the
 * model, so that copy wins when the two disagree.
 */
export function readModelContextLength(
  entry: Record<string, unknown> | undefined
): number | undefined {
  if (!entry) return undefined;

  const topProvider = entry.top_provider;
  if (topProvider && typeof topProvider === 'object') {
    const nested = asContextLength(
      (topProvider as Record<string, unknown>).context_length
    );
    if (nested !== undefined) return nested;
  }

  for (const key of CONTEXT_LENGTH_KEYS) {
    const length = asContextLength(entry[key]);
    if (length !== undefined) return length;
  }

  return undefined;
}

/** Context windows by model id, for the models that report one. */
export type PluginModelContextMap = Record<string, number>;

/** Reasoning support by model id, for the models where it is knowable. */
export type PluginModelReasoningMap = Record<string, boolean>;

/** Per-million-token price in micro-currency units, as providers report it. */
export interface PluginModelPricing {
  currency?: string;
  inputMicrosPerMillion?: number;
  outputMicrosPerMillion?: number;
}

/**
 * What a provider's listing says about one model beyond its identifier.
 * Every field is present only when the provider stated it: absent means
 * unknown, never "no" — except an explicit boolean `false`, which is the
 * provider's own denial and is kept as such.
 */
export interface PluginModelDetails {
  tools?: boolean;
  jsonMode?: boolean;
  structuredOutput?: boolean;
  availability?: string;
  deprecated?: boolean;
  pricing?: PluginModelPricing;
}

/** Per-model details by model id, for the models that report any. */
export type PluginModelDetailsMap = Record<string, PluginModelDetails>;

/**
 * Whether one listing entry says its model can reason. OpenRouter publishes
 * `supported_parameters` for every model, so on entries that carry the array
 * its silence is a real "no"; other providers say nothing, and nothing is
 * recorded rather than guessed here — the name heuristic below is the
 * fallback, kept separate because a listing's own answer must win.
 */
export function readModelReasoningSupport(
  entry: Record<string, unknown> | undefined
): boolean | undefined {
  if (!entry) return undefined;

  const supportedParameters = entry.supported_parameters;
  if (Array.isArray(supportedParameters)) {
    return supportedParameters.some(
      parameter =>
        parameter === 'reasoning' ||
        parameter === 'include_reasoning' ||
        parameter === 'reasoning_effort'
    );
  }

  const capabilities = entry.capabilities;
  if (
    Array.isArray(capabilities) &&
    capabilities.some(
      capability => capability === 'reasoning' || capability === 'thinking'
    )
  ) {
    return true;
  }

  if (entry.reasoning === true) return true;

  return undefined;
}

/**
 * What a model's name says about reasoning, for the providers whose listings
 * say nothing. This is a maintained table of the major families: a wrong
 * "true" costs a provider error the user can act on, a wrong "false" hides a
 * working control, and an unknown name stays undefined — offered, like an
 * Ollama model that reports no capabilities.
 */
export function inferReasoningFromModelId(id: string): boolean | undefined {
  const name = id.toLowerCase();
  const tail = name.split('/').pop() ?? name;

  // OpenAI: the o-series, gpt-5 family, and gpt-oss reason; the gpt-4/4o and
  // earlier chat families do not.
  if (/^o[134](-|$)/.test(tail) || tail.startsWith('gpt-5')) return true;
  if (tail.includes('gpt-oss')) return true;
  if (/^(chatgpt-|gpt-4|gpt-3)/.test(tail)) return false;

  // Anthropic: extended thinking exists from Claude 3.7 on. Everything older
  // — Claude 3.x, Claude 2, Instant — predates it.
  if (tail.includes('claude')) {
    return !/claude-(3-[05]|3-(haiku|sonnet|opus)|2|instant)/.test(tail);
  }

  // Open reasoning families served through providers.
  if (/(^|[^a-z])r1([^a-z]|$)/.test(tail) || tail.includes('qwq')) return true;

  return undefined;
}

export function readModelReasoningMap(
  entries: readonly unknown[]
): PluginModelReasoningMap {
  const reasoning: PluginModelReasoningMap = {};

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const support =
      readModelReasoningSupport(record) ?? inferReasoningFromModelId(id);
    if (support !== undefined) reasoning[id] = support;
  }

  return reasoning;
}

export function readModelContextMap(
  entries: readonly unknown[]
): PluginModelContextMap {
  const contexts: PluginModelContextMap = {};

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const contextLength = readModelContextLength(record);
    if (contextLength !== undefined) contexts[id] = contextLength;
  }

  return contexts;
}

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const asNonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

/**
 * Pricing block shared by the listing and stored forms. Listings use
 * snake_case keys, the persisted catalog the camelCase normalization —
 * both spellings are accepted, the listing's winning on conflict.
 */
function readModelPricing(value: unknown): PluginModelPricing | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const currency = asNonEmptyString(record.currency);
  const inputMicros = asNonNegativeNumber(
    record.input_micros_per_million ?? record.inputMicrosPerMillion
  );
  const outputMicros = asNonNegativeNumber(
    record.output_micros_per_million ?? record.outputMicrosPerMillion
  );
  const parsed: PluginModelPricing = {
    ...(currency !== undefined ? { currency } : {}),
    ...(inputMicros !== undefined
      ? { inputMicrosPerMillion: inputMicros }
      : {}),
    ...(outputMicros !== undefined
      ? { outputMicrosPerMillion: outputMicros }
      : {}),
  };
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

/**
 * The per-model details of one listing entry. Besides the OpenAI-style
 * `supported_parameters` array, some providers (Alcore included) publish
 * capabilities as an object (`{ tools: true, json_mode: true, ... }`);
 * only explicit booleans are recorded, so an absent key stays unknown.
 * Pricing, availability, and deprecation travel verbatim when present.
 */
export function readModelDetails(
  entry: Record<string, unknown> | undefined
): PluginModelDetails | undefined {
  if (!entry) return undefined;
  const details: PluginModelDetails = {};

  const capabilities = entry.capabilities;
  if (
    capabilities &&
    typeof capabilities === 'object' &&
    !Array.isArray(capabilities)
  ) {
    const record = capabilities as Record<string, unknown>;
    for (const [source, target] of [
      ['tools', 'tools'],
      ['json_mode', 'jsonMode'],
      ['structured_output', 'structuredOutput'],
    ] as const) {
      const flag = record[source];
      if (typeof flag === 'boolean') {
        details[target] = flag;
      }
    }
  }

  const availability = asNonEmptyString(entry.availability);
  if (availability !== undefined) details.availability = availability;
  if (typeof entry.deprecated === 'boolean') {
    details.deprecated = entry.deprecated;
  }

  const pricing = readModelPricing(entry.pricing);
  if (pricing !== undefined) details.pricing = pricing;

  return Object.keys(details).length > 0 ? details : undefined;
}

/**
 * Details in the shape discovery persists them (camelCase keys, no
 * `capabilities` wrapper). Listings are normalized into this shape by
 * `readModelDetails`; this validates the stored copy back without
 * requiring the listing's field names.
 */
export function readStoredModelDetails(
  value: unknown
): PluginModelDetails | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const details: PluginModelDetails = {};
  for (const key of ['tools', 'jsonMode', 'structuredOutput'] as const) {
    const flag = record[key];
    if (typeof flag === 'boolean') details[key] = flag;
  }
  const availability = asNonEmptyString(record.availability);
  if (availability !== undefined) details.availability = availability;
  if (typeof record.deprecated === 'boolean') {
    details.deprecated = record.deprecated;
  }
  const pricing = readModelPricing(record.pricing);
  if (pricing !== undefined) details.pricing = pricing;
  return Object.keys(details).length > 0 ? details : undefined;
}

export function readModelDetailsMap(
  entries: readonly unknown[]
): PluginModelDetailsMap {
  const details: PluginModelDetailsMap = {};

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const parsed = readModelDetails(record);
    if (parsed !== undefined) details[id] = parsed;
  }

  return details;
}

export interface DiscoveredPluginCatalog {
  models: string[];
  modelContext?: PluginModelContextMap;
  modelReasoning?: PluginModelReasoningMap;
  modelDetails?: PluginModelDetailsMap;
  /**
   * Whether the catalog was written before context windows were captured. Such
   * a catalog cannot be told apart from a provider that simply publishes none,
   * so it is refreshed once rather than left without windows until its next
   * scheduled refresh.
   */
  legacy?: boolean;
}

/**
 * Discovery used to be stored as a plain array of identifiers. It is now an
 * object that still carries that array, so an older build reads it as "nothing
 * discovered" and re-discovers rather than misreading a catalog, and a newer
 * one can tell a catalog with no windows from one written before windows were
 * kept at all.
 */
export function serializeDiscoveredCatalog(
  catalog: DiscoveredPluginCatalog
): string {
  return JSON.stringify({
    version: 1,
    models: catalog.models,
    context: catalog.modelContext ?? {},
    reasoning: catalog.modelReasoning ?? {},
    details: catalog.modelDetails ?? {},
  });
}

export function parseDiscoveredCatalog(
  serialized: string
): DiscoveredPluginCatalog {
  const parsed = JSON.parse(serialized) as unknown;

  const uniqueModels = (values: unknown[]): string[] =>
    Array.from(
      new Set(
        values.filter(
          (model): model is string =>
            typeof model === 'string' && model.length > 0
        )
      )
    );

  if (Array.isArray(parsed)) {
    return { models: uniqueModels(parsed), legacy: true };
  }

  // An object catalog missing the reasoning key was written before reasoning
  // support was captured; like the plain-array form it earns one refresh.

  if (!parsed || typeof parsed !== 'object') {
    return { models: [] };
  }

  const record = parsed as Record<string, unknown>;
  const models = Array.isArray(record.models)
    ? uniqueModels(record.models)
    : [];
  const context =
    record.context && typeof record.context === 'object'
      ? (record.context as Record<string, unknown>)
      : undefined;

  const modelContext: PluginModelContextMap = {};
  if (context) {
    for (const [model, length] of Object.entries(context)) {
      const contextLength = asContextLength(length);
      if (contextLength !== undefined) modelContext[model] = contextLength;
    }
  }

  const reasoning =
    record.reasoning && typeof record.reasoning === 'object'
      ? (record.reasoning as Record<string, unknown>)
      : undefined;
  const modelReasoning: PluginModelReasoningMap = {};
  if (reasoning) {
    for (const [model, support] of Object.entries(reasoning)) {
      if (typeof support === 'boolean') modelReasoning[model] = support;
    }
  }

  const stored =
    record.details && typeof record.details === 'object'
      ? (record.details as Record<string, unknown>)
      : undefined;
  const modelDetails: PluginModelDetailsMap = {};
  if (stored) {
    for (const [model, entry] of Object.entries(stored)) {
      const parsed = readStoredModelDetails(entry);
      if (parsed !== undefined) modelDetails[model] = parsed;
    }
  }

  return {
    models,
    ...(Object.keys(modelContext).length > 0 ? { modelContext } : {}),
    ...(Object.keys(modelReasoning).length > 0 ? { modelReasoning } : {}),
    ...(Object.keys(modelDetails).length > 0 ? { modelDetails } : {}),
    ...('reasoning' in record ? {} : { legacy: true }),
  };
}
