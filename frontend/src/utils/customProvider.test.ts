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

import assert from 'node:assert/strict';
import test from 'node:test';
import { customKeyEnv, customProviderId } from './customProvider';

test('slugifies provider names into backend-safe ids', () => {
  assert.equal(customProviderId('acme.gateway', []), 'acme-gateway');
  assert.equal(customProviderId('LM Studio', []), 'lm-studio');
  assert.equal(customProviderId('vLLM', []), 'vllm');
  assert.equal(customProviderId('alcore-local', []), 'alcore-local');
  assert.equal(customProviderId('  My__Gateway!! v2  ', []), 'my-gateway-v2');
});

test('truncates long names and falls back when empty', () => {
  assert.equal(customProviderId('', []), 'custom-api');
  assert.equal(customProviderId('!!!', []), 'custom-api');
  assert.equal(customProviderId('---', []), 'custom-api');
  assert.equal(customProviderId('a'.repeat(60), []), 'a'.repeat(40));
  assert.equal(customProviderId(`${'a'.repeat(39)}!!!`, []), 'a'.repeat(39));
});

test('dedupes collisions with numeric suffixes', () => {
  assert.equal(
    customProviderId('acme.gateway', ['acme-gateway']),
    'acme-gateway-2'
  );
  assert.equal(
    customProviderId('acme.gateway', ['acme-gateway', 'acme-gateway-2']),
    'acme-gateway-3'
  );
  assert.equal(customProviderId('custom', ['custom-api']), 'custom');
});

test('derives key env names from ids', () => {
  assert.equal(customKeyEnv('acme-gateway'), 'ACME_GATEWAY_API_KEY');
  assert.equal(customKeyEnv('my-gateway-2'), 'MY_GATEWAY_2_API_KEY');
  assert.equal(customKeyEnv('custom-api'), 'CUSTOM_API_API_KEY');
});
