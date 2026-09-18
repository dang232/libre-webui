/*
 * Libre WebUI
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
 * Runtime control over the engine's model adapter.
 *
 * The adapter is one row in the Cordis tree, so swapping providers is
 * `loader.remove` followed by `loader.create` on a single entry. Nothing else
 * in the composition is touched: the session store, tool registry, and agent
 * registry keep running while the provider changes, which is the whole point of
 * mounting the engine through Cordis instead of constructing it in process
 * startup code.
 *
 * Registering the adapter is an effect owned by its entry's fiber, so a failed
 * swap rolls back to "no adapter" rather than leaving the previous adapter's
 * registration attached to a provider route that no longer exists. A failed
 * swap therefore leaves the engine without model access, and the caller sees
 * the failure instead of silently talking to the wrong endpoint.
 *
 * @module cordis/host/model
 */

import type { Context } from '@deepseek-ai/cordis';
import { createLogger } from '../../utils/logger.js';
import type { CordisHostConfig, ModelAdapterConfig } from './config.js';
import { createLoaderEntry, hasLoaderEntry } from './loader-entry.js';

const logger = createLogger('cordis-model');

/** Loader entry id of the model adapter row. */
export const MODEL_ENTRY_ID = 'libre-webui-model-adapter';

/**
 * Package specifier of each supported adapter family.
 *
 * These are the only concrete DSH package names the host knows, and even here
 * they appear as data: the Loader resolves them at swap time, so a deployment
 * that never selects a provider never imports that adapter.
 */
const ADAPTER_PACKAGES: Record<string, string> = {
  deepseek: '@deepseek-ai/dsh-llm-deepseek',
  'pi-ai': '@deepseek-ai/dsh-llm-pi-ai',
};

/** Observable state of the model adapter row. */
export interface ModelAdapterState {
  /** Provider mode currently mounted. */
  readonly provider: string;
  /** Package specifier mounted, absent when no adapter is mounted. */
  readonly packageName?: string;
  /** Provider route the engine should name in requests. */
  readonly route: string;
  /** Env var the adapter resolves its key from at request time. */
  readonly apiKeyEnv: string;
  /** Base URL override, empty when the adapter default applies. */
  readonly baseUrl: string;
  /** Whether a swap is currently in flight. */
  readonly swapping: boolean;
  /** Number of successful swaps since the host started. */
  readonly swaps: number;
}

/** Raised when a requested adapter configuration cannot be mounted. */
export class ModelAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelAdapterError';
  }
}

/**
 * Owns the model adapter row of the Cordis tree.
 *
 * One controller belongs to one host and is not reusable across hosts: the
 * loader it drives is scoped to that host's root context.
 */
export class ModelAdapterController {
  private current: ModelAdapterConfig;
  private swapping = false;
  private swaps = 0;
  /** Removed adapter state retained only to roll back a failed swap. */
  private lastMounted: ModelAdapterConfig | undefined;

  constructor(
    private readonly context: Context,
    private readonly hostConfig: CordisHostConfig
  ) {
    this.current = hostConfig.model;
  }

  /** Snapshot the adapter's observable state. */
  state(): ModelAdapterState {
    return {
      provider: this.current.provider,
      packageName: ADAPTER_PACKAGES[this.current.provider],
      route: this.current.route,
      apiKeyEnv: this.current.apiKeyEnv,
      baseUrl: this.current.baseUrl,
      swapping: this.swapping,
      swaps: this.swaps,
    };
  }

  /** Mount the adapter named by the host configuration. */
  async mountInitial(): Promise<void> {
    if (this.current.provider === 'none') {
      logger.info('Model adapter disabled by configuration');
      return;
    }
    await this.mount(this.current);
  }

  /**
   * Replace the mounted adapter with a differently configured one.
   *
   * The previous row is removed before the new one is created so the new
   * adapter never competes with a stale registration for the same route. If
   * the new row fails to start, the previous configuration is restored, so a
   * rejected swap leaves the engine exactly as it was rather than in a state
   * that answers with the wrong provider.
   *
   * @param next - adapter configuration to mount.
   * @returns the state after the swap.
   * @throws {ModelAdapterError} when a swap is already running, or when the
   *   requested adapter cannot be mounted and restoring the previous one also
   *   fails.
   */
  async swap(next: ModelAdapterConfig): Promise<ModelAdapterState> {
    if (this.swapping) {
      throw new ModelAdapterError(
        'a model adapter swap is already in progress'
      );
    }
    const previous = this.current;
    this.swapping = true;
    try {
      await this.remove();
      if (next.provider !== 'none') {
        try {
          await this.mount(next);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          // Restore the previous adapter so a rejected swap is not also an
          // outage. A failure here is reported together with the original.
          try {
            if (previous.provider !== 'none') await this.mount(previous);
          } catch (restoreError) {
            const restoreDetail =
              restoreError instanceof Error
                ? restoreError.message
                : String(restoreError);
            throw new ModelAdapterError(
              `failed to mount model adapter "${next.provider}": ${detail}; ` +
                `restoring "${previous.provider}" also failed: ${restoreDetail}`
            );
          }
          throw new ModelAdapterError(
            `failed to mount model adapter "${next.provider}": ${detail}; ` +
              `restored "${previous.provider}"`
          );
        }
      }
      this.current = next;
      this.swaps += 1;
      logger.info('Model adapter swapped without restarting the engine', {
        provider: next.provider,
        route: next.route,
        baseUrl: next.baseUrl || '(adapter default)',
      });
    } finally {
      this.swapping = false;
    }
    // Reported after the flag is cleared: a state snapshot returned by a
    // completed swap must not claim the swap is still running.
    return this.state();
  }

  /** Remove the adapter row, leaving the engine running without model access. */
  async remove(): Promise<void> {
    const loader = this.context.get('loader');
    if (!loader) return;
    if (!hasLoaderEntry(loader, MODEL_ENTRY_ID)) return;
    // `remove` is async and only resolves once the entry's fiber has finished
    // unloading. Awaiting it is what guarantees the previous adapter's provider
    // registrations are gone before a new adapter claims the same routes;
    // without it the new row fails with "provider is already declared".
    await loader.remove(MODEL_ENTRY_ID);
    await loader.await();
    this.lastMounted = this.current;
  }

  /** Create the adapter row for one configuration. */
  private async mount(config: ModelAdapterConfig): Promise<void> {
    const packageName = ADAPTER_PACKAGES[config.provider];
    if (!packageName) {
      throw new ModelAdapterError(
        `unknown model provider "${config.provider}" (expected ${Object.keys(ADAPTER_PACKAGES).join(', ')}, or none)`
      );
    }
    const loader = this.context.get('loader');
    if (!loader) {
      throw new ModelAdapterError('the Cordis loader is not running');
    }
    await createLoaderEntry(loader, {
      id: MODEL_ENTRY_ID,
      name: packageName,
      config: buildAdapterConfig(config),
    });
    await loader.await();
  }
}

/**
 * Translate host configuration into the adapter's own config shape.
 *
 * `dsh-llm-pi-ai` takes a `providers` dict keyed by route; `dsh-llm-deepseek`
 * takes a flat base-URL override. Both resolve credentials per request from the
 * named environment variable, which is why no key is ever written into the
 * composition document.
 * @param config - resolved adapter configuration.
 * @returns the plugin config object handed to the adapter row.
 */
export function buildAdapterConfig(
  config: ModelAdapterConfig
): Record<string, unknown> {
  if (config.provider === 'deepseek') {
    const result: Record<string, unknown> = {};
    if (config.baseUrl) result.baseURL = config.baseUrl;
    if (config.apiKeyEnv) result.apiKeyEnv = config.apiKeyEnv;
    return result;
  }
  if (config.provider === 'pi-ai') {
    // A route declared here overrides a same-named row in the composition
    // document, because an explicit swap is a stronger statement of intent
    // than the file an operator wrote at deploy time.
    const declared = config.providers[config.route] ?? {};
    const route: Record<string, unknown> = {
      ...declared,
      apiKeyEnv: config.apiKeyEnv,
    };
    if (config.baseUrl) {
      route.baseURL = config.baseUrl;
      // A base URL only means something alongside a protocol. Default to the
      // OpenAI-compatible dialect, which is what Ollama and most self-hosted
      // gateways speak; an operator overrides it per route in the document.
      route.api ??= 'openai-completions';
    }
    return { providers: { ...config.providers, [config.route]: route } };
  }
  return {};
}
