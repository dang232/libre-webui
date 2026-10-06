/*
 * Alcore
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createHash } from 'crypto';
import { Plugin } from '../types/index.js';

/**
 * These hashes are a build-shipped trust anchor outside writable plugin JSON.
 * Update the matching entry intentionally whenever a bundled manifest changes.
 */
export const BUNDLED_PLUGIN_DEFINITION_FINGERPRINTS: Readonly<
  Record<string, string>
> = Object.freeze({
  alcore: 'f6552cffe57ca9dd67e82f44f0dea83343bd301ac2ff5ab81a497bbde2a170db',
});

const RUNTIME_DEFINITION_FIELDS = new Set([
  'active',
  'created_at',
  'updated_at',
]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter(key => (value as Record<string, unknown>)[key] !== undefined)
        .map(key => [
          key,
          canonicalize((value as Record<string, unknown>)[key]),
        ])
    );
  }
  return value;
}

export function getPluginDefinitionFingerprint(plugin: Plugin): string {
  const definition = Object.fromEntries(
    Object.entries(plugin as unknown as Record<string, unknown>).filter(
      ([key]) => !RUNTIME_DEFINITION_FIELDS.has(key)
    )
  );
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(definition)))
    .digest('hex');
}

export function matchesBundledPluginTrustAnchor(plugin: Plugin): boolean {
  return (
    BUNDLED_PLUGIN_DEFINITION_FINGERPRINTS[plugin.id] ===
    getPluginDefinitionFingerprint(plugin)
  );
}
