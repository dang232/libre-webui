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

import { ImageGenConfig, ImageGenResponse, Plugin } from '../types/index.js';
import {
  normalizeImageGenerationCount,
  normalizeImageMediaType,
} from '../utils/imageGenerationValidation.js';
import {
  assertSafePluginEndpoint,
  buildPluginAuthHeaders,
  resolvePluginOperationEndpoint,
  validatePluginModel,
} from '../utils/pluginValidation.js';
import {
  isProviderHttpError,
  isProviderRequestCancelled,
  ProviderHttpError,
  ProviderNetworkError,
  ProviderResponseTooLargeError,
  ProviderTimeoutError,
  providerRequest,
} from '../utils/providerFetch.js';
import type { PluginUsageEventInput } from './pluginUsageService.js';

type ImageGenImage = ImageGenResponse['images'][number];

/** A transport-layer failure of an outbound provider request. */
function isProviderTransportError(error: unknown): error is Error {
  return (
    error instanceof ProviderHttpError ||
    error instanceof ProviderTimeoutError ||
    error instanceof ProviderNetworkError ||
    error instanceof ProviderResponseTooLargeError
  );
}

type ProviderErrorBody = {
  error?: { message?: unknown } | string;
  message?: unknown;
};

function providerErrorBody(error: unknown): ProviderErrorBody | undefined {
  if (!isProviderHttpError(error)) return undefined;
  const data = error.response.data;
  return data && typeof data === 'object'
    ? (data as ProviderErrorBody)
    : undefined;
}

type PluginVariables = Record<string, string | number | boolean>;
type MaybePromise<T> = T | Promise<T>;

export interface ImageEditInputImage {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

export interface PluginImageGenerationServiceDependencies {
  getAllPlugins(userId?: string): MaybePromise<Plugin[]>;
  getPlugin(id: string, userId?: string): MaybePromise<Plugin | null>;
  getApiKey(plugin: Plugin, userId?: string): MaybePromise<string | null>;
  getPluginVariables(
    plugin: Plugin,
    userId?: string
  ): MaybePromise<PluginVariables>;
  validateEndpointUrl(endpoint: string): string;
  recordUsage?(usage: PluginUsageEventInput): void;
}

export class PluginImageGenerationService {
  constructor(
    private readonly deps: PluginImageGenerationServiceDependencies
  ) {}

  async getPluginForImageGen(
    model: string,
    pluginId: string,
    userId?: string
  ): Promise<Plugin | null> {
    const plugin = await this.deps.getPlugin(pluginId, userId);
    if (!plugin?.active) return null;

    const supportedModels =
      plugin.capabilities?.image?.model_map ??
      (plugin.type === 'image' ? plugin.model_map : []);
    if (supportedModels.includes(model)) {
      return plugin;
    }

    return null;
  }

  async getAvailableImageGenModels(userId?: string): Promise<
    {
      model: string;
      plugin: string;
      config?: ImageGenConfig;
    }[]
  > {
    const models: { model: string; plugin: string; config?: ImageGenConfig }[] =
      [];
    const allPlugins = await this.deps.getAllPlugins(userId);

    for (const plugin of allPlugins) {
      if (!plugin.active) continue;
      const imageCapability = plugin.capabilities?.image;
      const supportedModels =
        imageCapability?.model_map ??
        (plugin.type === 'image' ? plugin.model_map : []);
      if (supportedModels.length === 0) {
        continue;
      }

      const noAuthRequired =
        (imageCapability?.config as Record<string, unknown> | undefined)
          ?.no_auth_required === true;
      const apiKey = await this.deps.getApiKey(plugin, userId);
      if (apiKey || noAuthRequired) {
        for (const model of supportedModels) {
          models.push({
            model,
            plugin: plugin.id,
            config: imageCapability?.config,
          });
        }
      }
    }

    return models;
  }

  async executeImageGenRequest(
    model: string,
    prompt: string,
    options: {
      size?: string;
      quality?: string;
      style?: string;
      n?: number;
      response_format?: 'url' | 'b64_json';
      pluginId: string;
      userId?: string;
      signal?: AbortSignal;
    }
  ): Promise<ImageGenResponse> {
    validatePluginModel(model);

    if (!prompt || typeof prompt !== 'string') {
      throw new Error('Invalid prompt: must be a non-empty string');
    }

    const plugin = await this.getPluginForImageGen(
      model,
      options.pluginId,
      options.userId
    );
    if (!plugin) {
      throw new Error(
        `No image generation plugin found for model: ${model} in plugin ${options.pluginId}`
      );
    }

    let endpoint: string;
    let imageConfig: ImageGenConfig | undefined;

    if (plugin.capabilities?.image) {
      endpoint = plugin.capabilities.image.endpoint;
      imageConfig = plugin.capabilities.image.config;
    } else {
      endpoint = plugin.endpoint;
    }

    const imageVars = await this.deps.getPluginVariables(
      plugin,
      options.userId
    );
    const imageCount = normalizeImageGenerationCount(options.n);
    const endpointVariable =
      imageConfig?.endpoint_variable ||
      (plugin.type === 'image' ? 'endpoint' : 'image_endpoint');
    const endpointOverride = imageVars[endpointVariable];
    if (endpointVariable === 'endpoint') {
      endpoint = resolvePluginOperationEndpoint(endpoint, imageVars);
    } else if (
      typeof endpointOverride === 'string' &&
      endpointOverride.trim().length > 0
    ) {
      const validatedEndpoint = this.deps.validateEndpointUrl(
        endpointOverride.trim()
      );
      if (!validatedEndpoint) {
        throw new Error(
          `Invalid image endpoint override configured for plugin ${plugin.id}`
        );
      }
      endpoint = validatedEndpoint;
    }

    const noAuthRequired =
      (imageConfig as Record<string, unknown> | undefined)?.no_auth_required ===
      true;
    const apiKey = await this.deps.getApiKey(plugin, options.userId);
    if (!apiKey && !noAuthRequired) {
      throw new Error(
        `API key not found for plugin ${plugin.id} (save a provider credential in Settings)`
      );
    }

    if (
      imageConfig?.max_prompt_length &&
      prompt.length > imageConfig.max_prompt_length
    ) {
      throw new Error(
        `Prompt exceeds maximum length of ${imageConfig.max_prompt_length} characters`
      );
    }

    if (imageCount !== undefined) {
      if (imageConfig?.supports_n === false && imageCount !== 1) {
        throw new Error(
          `Plugin ${plugin.id} supports only one image per request`
        );
      }
      if (imageConfig?.max_n && imageCount > imageConfig.max_n) {
        throw new Error(
          `Image count exceeds maximum of ${imageConfig.max_n} for plugin ${plugin.id}`
        );
      }
    }

    const headers = buildPluginAuthHeaders(plugin, apiKey, endpoint);

    const payload: Record<string, unknown> = { model, prompt };
    const requestedSize = options.size || imageConfig?.default_size;
    if (requestedSize) {
      payload[imageConfig?.size_parameter || 'size'] = requestedSize;
    } else if (!imageConfig) {
      payload.size = '1024x1024';
    }

    if (!imageConfig?.omit_quality_when_empty) {
      payload.quality =
        options.quality || imageConfig?.default_quality || 'standard';
    }

    if (imageConfig?.supports_n !== false) {
      payload.n = imageCount ?? 1;
    }

    if (imageConfig?.supports_response_format !== false) {
      payload.response_format =
        options.response_format ||
        imageConfig?.default_response_format ||
        'url';
    }

    if (options.style || imageConfig?.default_style) {
      payload.style = options.style || imageConfig?.default_style;
    }

    const startedAt = Date.now();
    try {
      const response = await providerRequest({
        url: endpoint,
        method: 'POST',
        json: payload,
        headers,
        timeoutMs: 300000,
        maxResponseBytes: 80 * 1024 * 1024,
        signal: options.signal,
      });
      const result: ImageGenResponse = {
        images: normalizeImageGenerationResponse(response.data),
        model,
        pluginId: plugin.id,
      };

      this.deps.recordUsage?.({
        userId: options.userId,
        pluginId: plugin.id,
        pluginName: plugin.name,
        capability: 'image',
        model,
        status: 'success',
        durationMs: Date.now() - startedAt,
        outputUnits: result.images.length,
        unitKind: 'images',
      });
      return result;
    } catch (error) {
      const cancelled =
        isProviderRequestCancelled(error) || options.signal?.aborted;
      this.deps.recordUsage?.({
        userId: options.userId,
        pluginId: plugin.id,
        pluginName: plugin.name,
        capability: 'image',
        model,
        status: cancelled ? 'cancelled' : 'error',
        durationMs: Date.now() - startedAt,
        outputUnits: 0,
        unitKind: 'images',
      });
      if (cancelled) {
        throw options.signal?.reason instanceof Error
          ? options.signal.reason
          : new Error('Image provider request was cancelled');
      }
      if (isProviderTransportError(error)) {
        const body = providerErrorBody(error);
        const nested =
          body && typeof body.error === 'object'
            ? body.error?.message
            : undefined;
        const message = nested || body?.message || error.message;
        throw new Error(`Image generation failed: ${String(message)}`);
      }
      throw error;
    }
  }

  /**
   * Provider-neutral image edit/inpaint/composite (IMAGE-01) over the
   * OpenAI-compatible multipart edits contract: one or more reference
   * images, an optional transparency mask (transparent regions are
   * repainted), and a prompt. Only plugins that declare `edit_endpoint`
   * participate; capability limits are validated before any bytes leave
   * the process.
   */
  async executeImageEditRequest(
    model: string,
    prompt: string,
    images: ImageEditInputImage[],
    mask: ImageEditInputImage | null,
    options: {
      size?: string;
      pluginId: string;
      userId?: string;
      signal?: AbortSignal;
    }
  ): Promise<ImageGenResponse> {
    validatePluginModel(model);
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new Error('Invalid prompt: must be a non-empty string');
    }
    if (images.length === 0) {
      throw new Error('At least one source image is required');
    }

    const plugin = await this.getPluginForImageGen(
      model,
      options.pluginId,
      options.userId
    );
    if (!plugin) {
      throw new Error(
        `No image generation plugin found for model: ${model} in plugin ${options.pluginId}`
      );
    }
    const imageConfig = plugin.capabilities?.image?.config;
    const editEndpointTemplate = imageConfig?.edit_endpoint;
    if (!editEndpointTemplate) {
      throw new Error(`Plugin ${plugin.id} does not support image editing`);
    }
    if (mask && imageConfig?.supports_mask === false) {
      throw new Error(`Plugin ${plugin.id} does not support edit masks`);
    }
    const maxReferenceImages = Math.max(
      1,
      imageConfig?.max_reference_images ?? 1
    );
    if (images.length > maxReferenceImages) {
      throw new Error(
        `Plugin ${plugin.id} accepts at most ${maxReferenceImages} reference image(s)`
      );
    }
    if (
      imageConfig?.max_prompt_length &&
      prompt.length > imageConfig.max_prompt_length
    ) {
      throw new Error(
        `Prompt exceeds maximum length of ${imageConfig.max_prompt_length} characters`
      );
    }

    const imageVars = await this.deps.getPluginVariables(
      plugin,
      options.userId
    );
    // Edits always use the manifest's declared edit endpoint; the
    // generation endpoint-override variable never redirects them.
    const endpoint = resolvePluginOperationEndpoint(
      editEndpointTemplate,
      imageVars
    );
    assertSafePluginEndpoint(endpoint);

    const noAuthRequired =
      (imageConfig as Record<string, unknown> | undefined)?.no_auth_required ===
      true;
    const apiKey = await this.deps.getApiKey(plugin, options.userId);
    if (!apiKey && !noAuthRequired) {
      throw new Error(
        `API key not found for plugin ${plugin.id} (save a provider credential in Settings)`
      );
    }
    // Strip the JSON content type so the multipart boundary is generated.
    const { 'Content-Type': _jsonContentType, ...headers } =
      buildPluginAuthHeaders(plugin, apiKey, endpoint);

    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    for (const [index, image] of images.entries()) {
      const blob = new Blob([Uint8Array.from(image.buffer)], {
        type: image.mimeType,
      });
      form.append(
        images.length > 1 ? 'image[]' : 'image',
        blob,
        image.filename || `image-${index}.png`
      );
    }
    if (mask) {
      form.append(
        'mask',
        new Blob([Uint8Array.from(mask.buffer)], { type: mask.mimeType }),
        mask.filename || 'mask.png'
      );
    }
    const requestedSize = options.size || imageConfig?.default_size;
    if (requestedSize) form.append('size', requestedSize);
    if (imageConfig?.supports_response_format !== false) {
      form.append('response_format', 'b64_json');
    }

    const startedAt = Date.now();
    try {
      const response = await providerRequest({
        url: endpoint,
        method: 'POST',
        body: form,
        headers,
        timeoutMs: 300000,
        maxResponseBytes: 80 * 1024 * 1024,
        signal: options.signal,
      });
      const result: ImageGenResponse = {
        images: normalizeImageGenerationResponse(response.data),
        model,
        pluginId: plugin.id,
      };
      this.deps.recordUsage?.({
        userId: options.userId,
        pluginId: plugin.id,
        pluginName: plugin.name,
        capability: 'image',
        model,
        status: 'success',
        durationMs: Date.now() - startedAt,
        outputUnits: result.images.length,
        unitKind: 'images',
      });
      return result;
    } catch (error) {
      const cancelled =
        isProviderRequestCancelled(error) || options.signal?.aborted;
      this.deps.recordUsage?.({
        userId: options.userId,
        pluginId: plugin.id,
        pluginName: plugin.name,
        capability: 'image',
        model,
        status: cancelled ? 'cancelled' : 'error',
        durationMs: Date.now() - startedAt,
        outputUnits: 0,
        unitKind: 'images',
      });
      if (cancelled) {
        throw options.signal?.reason instanceof Error
          ? options.signal.reason
          : new Error('Image provider request was cancelled');
      }
      if (isProviderTransportError(error)) {
        const body = providerErrorBody(error);
        const nested =
          body && typeof body.error === 'object'
            ? body.error?.message
            : undefined;
        const message = nested || body?.message || error.message;
        throw new Error(`Image edit failed: ${String(message)}`);
      }
      throw error;
    }
  }

  async getImageGenConfig(
    pluginId: string,
    userId?: string
  ): Promise<ImageGenConfig | null> {
    const plugin = await this.deps.getPlugin(pluginId, userId);
    if (!plugin?.active) return null;

    if (plugin.capabilities?.image?.config) {
      return plugin.capabilities.image.config;
    }

    return null;
  }
}

export function normalizeImageGenerationResponse(
  responseData: unknown
): ImageGenImage[] {
  const candidates = getImageCandidates(responseData);
  const images = candidates.flatMap(candidate => {
    const image = normalizeImageCandidate(candidate);
    return image ? [image] : [];
  });

  if (images.length === 0) {
    throw new Error('Image provider returned no usable image data');
  }

  return images;
}

function getImageCandidates(responseData: unknown): unknown[] {
  if (Array.isArray(responseData)) {
    return responseData;
  }

  if (!isRecord(responseData)) {
    return [responseData];
  }

  if ('data' in responseData) {
    return Array.isArray(responseData.data)
      ? responseData.data
      : [responseData.data];
  }

  if ('images' in responseData) {
    return Array.isArray(responseData.images)
      ? responseData.images
      : [responseData.images];
  }

  return [responseData];
}

function normalizeImageCandidate(candidate: unknown): ImageGenImage | null {
  if (typeof candidate === 'string') {
    const dataUrl = normalizeImageDataUrl(candidate);
    if (dataUrl) {
      return {
        b64_json: dataUrl.b64Json,
        mime_type: dataUrl.mimeType,
      };
    }

    const url = normalizeHttpImageUrl(candidate);
    if (url) {
      return { url };
    }

    const b64Json = normalizeCanonicalBase64(candidate);
    return b64Json ? { b64_json: b64Json } : null;
  }

  if (!isRecord(candidate)) {
    return null;
  }

  const normalized: ImageGenImage = {};
  const b64DataUrl = normalizeImageDataUrl(candidate.b64_json);
  const b64Json =
    b64DataUrl?.b64Json || normalizeCanonicalBase64(candidate.b64_json);
  if (b64Json) {
    normalized.b64_json = b64Json;
    const mimeType =
      b64DataUrl?.mimeType ||
      normalizeImageMediaType(candidate.mime_type) ||
      normalizeImageMediaType(candidate.media_type);
    if (mimeType) {
      normalized.mime_type = mimeType;
    }
  }

  const urlData = normalizeImageDataUrl(candidate.url);
  if (urlData && !normalized.b64_json) {
    normalized.b64_json = urlData.b64Json;
    normalized.mime_type = urlData.mimeType;
  } else if (!urlData) {
    const url = normalizeHttpImageUrl(candidate.url);
    if (url) {
      normalized.url = url;
    }
  }

  if (!normalized.url && !normalized.b64_json) {
    return null;
  }

  if (typeof candidate.revised_prompt === 'string') {
    normalized.revised_prompt = candidate.revised_prompt;
  }

  return normalized;
}

function normalizeImageDataUrl(
  value: unknown
): { b64Json: string; mimeType: string } | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match =
    /^data:(image\/[a-z0-9.+-]+)(?:;[a-z0-9!#$&^_.+-]+=[^;,]*)*;base64,([a-z0-9+/]+={0,2})$/i.exec(
      value.trim()
    );
  if (!match) {
    return null;
  }

  const b64Json = normalizeCanonicalBase64(match[2]);
  const mimeType = normalizeImageMediaType(match[1]);
  return b64Json && mimeType ? { b64Json, mimeType } : null;
}

function normalizeCanonicalBase64(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      normalized
    )
  ) {
    return null;
  }

  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== normalized) {
    return null;
  }

  return normalized;
}

function normalizeHttpImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url.toString();
  } catch (_error) {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
