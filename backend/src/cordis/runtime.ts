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
 * Process-wide owner of the Cordis host.
 *
 * The host is started lazily rather than during boot: an operator who has not
 * enabled the bridge must not pay for an engine they do not run, and a failure
 * inside the engine must not be able to stop Libre WebUI from serving the rest
 * of its features. Startup therefore happens on first use and reports its own
 * failure through the route layer, where an operator can see it.
 *
 * @module cordis/runtime
 */

import type { CordisHost, CordisHostConfig, DshEngine } from './index.js';
import {
  resolveCordisHostConfig,
  startCordisHost,
  DSH_ENGINE_SERVICE,
} from './index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('cordis-runtime');

/** Why the bridge cannot serve a request. */
export type CordisUnavailableReason =
  /** The operator has not enabled the bridge. */
  | 'disabled'
  /** Startup is still in flight. */
  | 'starting'
  /** Startup failed; `detail` carries the reason. */
  | 'failed';

/** Result of asking the runtime for the engine. */
export type CordisEngineResult =
  | { readonly ok: true; readonly engine: DshEngine }
  | {
      readonly ok: false;
      readonly reason: CordisUnavailableReason;
      readonly detail?: string;
    };

let host: CordisHost | undefined;
let startPromise: Promise<void> | undefined;
let failure: string | undefined;
let overrides: Partial<CordisHostConfig> | undefined;

/**
 * Override resolution inputs, for tests and for callers that own their own
 * paths. Values are merged over the resolved configuration.
 * @param next - partial configuration overriding resolved values.
 */
export function configureCordisRuntime(
  next: Partial<CordisHostConfig> | undefined
): void {
  overrides = next;
}

/** Resolve the configuration this runtime would start with. */
export function cordisRuntimeConfig(): CordisHostConfig {
  const resolved = resolveCordisHostConfig();
  return overrides ? { ...resolved, ...overrides } : resolved;
}

/** Whether the operator enabled the bridge. */
export function isCordisBridgeEnabled(): boolean {
  return cordisRuntimeConfig().features.enabled;
}

/**
 * Start the host if it is enabled and not already running.
 *
 * Concurrent callers share one startup: the first request begins the mount and
 * every other waiter observes the same promise, so the engine is never mounted
 * twice.
 * @returns the running host, or undefined when the bridge is disabled.
 * @throws when startup fails.
 */
export async function ensureCordisHost(): Promise<CordisHost | undefined> {
  if (host) return host;
  const config = cordisRuntimeConfig();
  if (!config.features.enabled) return undefined;
  if (!startPromise) {
    startPromise = (async () => {
      try {
        host = await startCordisHost(config);
        failure = undefined;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        logger.error('Cordis host failed to start', { error: failure });
        throw error;
      } finally {
        // Clear only the in-flight marker: a successful host stays in `host`,
        // and a failure stays in `failure` so later requests report it without
        // retrying a composition that cannot mount.
        startPromise = undefined;
      }
    })();
  }
  await startPromise;
  return host;
}

/**
 * Read the engine contract, starting the host on first use.
 * @returns the engine, or a typed reason the bridge cannot serve the request.
 */
export async function getCordisEngine(): Promise<CordisEngineResult> {
  const config = cordisRuntimeConfig();
  if (!config.features.enabled) return { ok: false, reason: 'disabled' };
  if (!host && !startPromise && failure !== undefined) {
    return { ok: false, reason: 'failed', detail: failure };
  }
  try {
    const running = await ensureCordisHost();
    if (!running) return { ok: false, reason: 'disabled' };
    const engine = running.context.get(DSH_ENGINE_SERVICE) as
      DshEngine | undefined;
    if (!engine) {
      return {
        ok: false,
        reason: 'failed',
        detail:
          'the composition mounted no libreDshEngine service; check the bridge row',
      };
    }
    return { ok: true, engine };
  } catch (error) {
    return {
      ok: false,
      reason: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The running host, if any. Used by diagnostics and tests. */
export function cordisHost(): CordisHost | undefined {
  return host;
}

/**
 * Stop the host and release every engine effect.
 *
 * Safe to call when the bridge was never started or is already stopped.
 * @returns a promise resolving once teardown has completed.
 */
export async function stopCordisHost(): Promise<void> {
  const running = host;
  host = undefined;
  startPromise = undefined;
  failure = undefined;
  if (running) await running.stop();
}
