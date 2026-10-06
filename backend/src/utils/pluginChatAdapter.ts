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

import type {
  ChatMessage,
  GenerationOptions,
  Plugin,
  PluginApiMode,
  PluginResponse,
  ProviderToolSpec,
} from '../types/index.js';
import {
  buildOpenAIResponsesPayload,
  normalizeOpenAIResponsesResponse,
} from './openAIResponsesAdapter.js';
import { thinkingEffort } from './thinkingOptions.js';

export type PluginVariables = Record<string, string | number | boolean>;

export interface PluginChatParameters {
  temperature: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  shouldStream: boolean;
}

export interface PluginChatPayloadResult {
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
}

type OpenAICompatibleSamplingParameters = Partial<{
  temperature: number;
  top_p: number;
  frequency_penalty: number;
  presence_penalty: number;
}>;

export function resolvePluginChatParameters(
  options: GenerationOptions = {},
  pluginVars: PluginVariables = {}
): PluginChatParameters {
  return {
    temperature:
      options.temperature ??
      (pluginVars.temperature as number | undefined) ??
      0.7,
    maxTokens:
      options.num_predict === -1
        ? undefined
        : (options.num_predict ??
          (pluginVars.max_tokens as number | undefined) ??
          undefined),
    topP:
      options.top_p ?? (pluginVars.top_p as number | undefined) ?? undefined,
    frequencyPenalty:
      (pluginVars.frequency_penalty as number | undefined) ?? undefined,
    presencePenalty:
      (pluginVars.presence_penalty as number | undefined) ?? undefined,
    shouldStream: (pluginVars.stream as boolean | undefined) ?? false,
  };
}

export function applyPluginDefinitionPolicy(plugin: Plugin): Plugin {
  return plugin;
}

export function getOpenAICompatibleSamplingParameters(
  _plugin: Pick<Plugin, 'id'>,
  params: PluginChatParameters
): OpenAICompatibleSamplingParameters {
  return {
    temperature: params.temperature,
    top_p: params.topP,
    frequency_penalty: params.frequencyPenalty,
    presence_penalty: params.presencePenalty,
  };
}

/**
 * Generic thinking toggle passthrough for OpenAI-compatible endpoints.
 */
export function getOpenAICompatibleThinkingParameters(
  _plugin: Pick<Plugin, 'id'>,
  _think: unknown
): Record<string, unknown> {
  return {};
}

/** OpenAI Chat Completions-style tool definitions from provider-neutral specs. */
export function toOpenAICompatibleTools(
  tools: readonly ProviderToolSpec[] | undefined
): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }));
}

export function toOpenAICompatibleMessages(
  messages: ChatMessage[],
  options: {
    preserveProviderMetadata?: boolean;
    includeReasoning?: boolean;
    /** Wire field for replayed reasoning. */
    reasoningField?: 'reasoning' | 'reasoning_content';
  } = {}
): Array<{
  role: string;
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >;
  providerMetadata?: Record<string, unknown>;
  reasoning?: string;
  reasoning_content?: string;
  tool_calls?: ChatMessage['tool_calls'];
  tool_call_id?: string;
}> {
  return messages.map(message => {
    const providerMetadata = options.preserveProviderMetadata
      ? message.providerMetadata
      : undefined;
    const reasoningWire =
      options.includeReasoning && message.thinking
        ? { [options.reasoningField ?? 'reasoning']: message.thinking }
        : {};
    const toolWire = {
      ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    };
    if (message.images && message.images.length > 0) {
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      > = [];

      for (const image of message.images) {
        const imageUrl = image.startsWith('data:')
          ? image
          : `data:image/jpeg;base64,${image}`;
        content.push({ type: 'image_url', image_url: { url: imageUrl } });
      }

      if (message.content) {
        content.push({ type: 'text', text: message.content });
      }

      return {
        role: message.role,
        content,
        ...reasoningWire,
        ...(providerMetadata ? { providerMetadata } : {}),
        ...toolWire,
      };
    }

    return {
      role: message.role,
      content: message.content,
      ...reasoningWire,
      ...(providerMetadata ? { providerMetadata } : {}),
      ...toolWire,
    };
  });
}

function buildOpenAICompatibleChatPayload(
  plugin: Pick<Plugin, 'id'>,
  model: string,
  messages: ChatMessage[],
  options: GenerationOptions,
  params: PluginChatParameters
): PluginChatPayloadResult {
  // OpenAI and the providers that copy its shape name the levels instead of
  // budgeting tokens. Nothing is sent unless thinking was asked for: the field
  // is unknown to models that do not reason.
  const thinkingLevel = thinkingEffort(options.think);
  const effort = thinkingLevel;
  const tools = toOpenAICompatibleTools(options.tools);

  return {
    payload: {
      model,
      messages: toOpenAICompatibleMessages(messages),
      ...getOpenAICompatibleSamplingParameters(plugin, params),
      max_tokens: params.maxTokens,
      stop: options.stop,
      stream: params.shouldStream,
      ...(effort ? { reasoning_effort: effort } : {}),
      ...getOpenAICompatibleThinkingParameters(plugin, options.think),
      ...(tools ? { tools } : {}),
    },
  };
}

export function buildPluginChatPayload(
  plugin: Plugin,
  model: string,
  messages: ChatMessage[],
  options: GenerationOptions = {},
  pluginVars: PluginVariables = {},
  streamOverride?: boolean,
  apiMode: PluginApiMode = 'chat_completions',
  providerStateScope?: string
): PluginChatPayloadResult {
  const params = resolvePluginChatParameters(options, pluginVars);
  if (streamOverride !== undefined) {
    params.shouldStream = streamOverride;
  }

  if (apiMode === 'responses') {
    return {
      payload: buildOpenAIResponsesPayload(
        model,
        toOpenAICompatibleMessages(messages, {
          preserveProviderMetadata: true,
        }),
        {
          max_tokens: params.maxTokens,
          temperature: params.temperature,
          top_p: params.topP,
          stream: params.shouldStream,
          stateScope: providerStateScope,
          reasoningEffort: thinkingEffort(options.think),
          ...(options.tools?.length
            ? { tools: toOpenAICompatibleTools(options.tools) }
            : {}),
        }
      ),
    };
  }

  return buildOpenAICompatibleChatPayload(
    plugin,
    model,
    messages,
    options,
    params
  );
}

export function convertProviderResponse(
  _plugin: Plugin,
  response: Record<string, unknown>,
  model: string,
  apiMode: PluginApiMode = 'chat_completions',
  providerStateScope?: string
): PluginResponse {
  if (apiMode === 'responses') {
    return normalizeOpenAIResponsesResponse(
      response,
      model,
      providerStateScope
    );
  }

  return response as unknown as PluginResponse;
}
