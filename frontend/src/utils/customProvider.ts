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

const MAX_PROVIDER_ID_LENGTH = 40;
const FALLBACK_PROVIDER_ID = 'custom-api';

/**
 * Derive a backend-safe plugin id from a free-form provider name. The result
 * only uses lowercase letters, digits, and single dashes, so it always passes
 * the backend install-time id check and `sanitize-filename` unchanged.
 * Collisions with `takenIds` get `-2`, `-3`, … suffixes.
 */
export function customProviderId(
  name: string,
  takenIds: readonly string[]
): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_PROVIDER_ID_LENGTH)
    .replace(/-+$/, '');
  const base = slug || FALLBACK_PROVIDER_ID;
  if (!takenIds.includes(base)) {
    return base;
  }
  let suffix = 2;
  while (takenIds.includes(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

/**
 * Derive the credential env key for a provider id
 * (`my-provider` becomes `MY_PROVIDER_API_KEY`).
 */
export function customKeyEnv(id: string): string {
  return `${id.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}
