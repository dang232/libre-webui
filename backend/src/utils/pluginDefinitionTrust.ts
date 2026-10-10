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
  // Only the ALCore and Bedrock bundled providers ship now; every other
  // manifest was removed by the keep-only-bundled-providers refactor.
  alcore: 'f6552cffe57ca9dd67e82f44f0dea83343bd301ac2ff5ab81a497bbde2a170db',
  bedrock: '22eaf01882bfbf2d911cb320103de97f534f3aef829001b982d21445a9ed4980',
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

const MODEL_PLACEHOLDER = '{model}';

/** True when every `{model}` sits after the host of an absolute URL. */
function modelPlaceholderStaysInPath(value: string): boolean {
  let index = value.indexOf(MODEL_PLACEHOLDER);
  while (index !== -1) {
    if (!/^[a-z][a-z\d+.-]*:\/\/[^/?#]*[/?#]/i.test(value.slice(0, index))) {
      return false;
    }
    index = value.indexOf(MODEL_PLACEHOLDER, index + MODEL_PLACEHOLDER.length);
  }
  return true;
}

function someString(
  value: unknown,
  predicate: (text: string) => boolean
): boolean {
  if (typeof value === 'string') return predicate(value);
  if (Array.isArray(value)) {
    return value.some(item => someString(item, predicate));
  }
  if (value && typeof value === 'object') {
    return Object.values(value).some(item => someString(item, predicate));
  }
  return false;
}

/** Model catalog fields: which models exist, never where a request goes. */
const MODEL_CATALOG_FIELDS = ['model_map', 'model_context', 'model_reasoning'];

/**
 * Definition fingerprint that binds a saved credential. The model catalogs,
 * top-level and per capability, are left out so adding a model does not
 * strand every saved key. When a `{model}` placeholder could pick the
 * destination host, the catalog is routing and stays bound.
 */
export function getCredentialBindingDefinitionFingerprint(
  plugin: Plugin,
  connectionValues: unknown = []
): string {
  if (
    someString(
      [plugin, connectionValues],
      text => !modelPlaceholderStaysInPath(text)
    )
  ) {
    return getPluginDefinitionFingerprint(plugin);
  }
  const withoutCatalog = (value: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(value).filter(
        ([key]) => !MODEL_CATALOG_FIELDS.includes(key)
      )
    );
  const definition = withoutCatalog(
    plugin as unknown as Record<string, unknown>
  );
  const capabilities = definition.capabilities;
  if (capabilities && typeof capabilities === 'object') {
    definition.capabilities = Object.fromEntries(
      Object.entries(capabilities as Record<string, unknown>).map(
        ([name, capability]) => [
          name,
          capability && typeof capability === 'object'
            ? withoutCatalog(capability as Record<string, unknown>)
            : capability,
        ]
      )
    );
  }
  return getPluginDefinitionFingerprint(definition as unknown as Plugin);
}

export function matchesBundledPluginTrustAnchor(plugin: Plugin): boolean {
  return (
    BUNDLED_PLUGIN_DEFINITION_FINGERPRINTS[plugin.id] ===
    getPluginDefinitionFingerprint(plugin)
  );
}
