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
import {
  formatCount,
  formatSpendMicros,
  formatSpendWhole,
  groupMajorDigits,
} from './usageMicros.ts';

test('formatSpendMicros renders exact fractions without floats', () => {
  assert.equal(formatSpendMicros(192_000_000, 'VND'), '192 VND');
  assert.equal(formatSpendMicros(1, 'USD'), '0.000001 USD');
  assert.equal(formatSpendMicros(-6_000, 'USD'), '-0.006 USD');
  assert.equal(formatSpendMicros(5_000_000, 'USD'), '5 USD');
  assert.equal(formatSpendMicros(2_675_000, 'USD'), '2.675 USD');
  assert.equal(
    formatSpendMicros(1_234_567_890_123, 'USD'),
    '1,234,567.890123 USD'
  );
});

test('formatSpendMicros pins the server currency and guards non-integers', () => {
  assert.equal(formatSpendMicros(1_000_000, 'EUR'), '1 EUR');
  assert.equal(formatSpendMicros(Number.NaN, 'USD'), '— USD');
  assert.equal(formatSpendMicros(1.5, 'USD'), '— USD');
  assert.equal(formatSpendMicros(Number.MAX_SAFE_INTEGER + 1, 'USD'), '— USD');
});

test('formatSpendWhole rounds half-up like fmtMicrosVnd', () => {
  assert.equal(formatSpendWhole(1_499_999, 'VND'), '1 VND');
  assert.equal(formatSpendWhole(1_500_000, 'VND'), '2 VND');
  assert.equal(formatSpendWhole(192_000_000, 'VND'), '192 VND');
  assert.equal(formatSpendWhole(999_999_500_000, 'USD'), '1,000,000 USD');
  assert.equal(formatSpendWhole(0, 'USD'), '0 USD');
});

test('formatCount groups integer counts without floats', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(1_234_567), '1,234,567');
  assert.equal(formatCount(-42), '-42');
  assert.equal(formatCount(1.5), '—');
  assert.equal(formatCount(Number.NaN), '—');
});

test('groupMajorDigits groups in threes', () => {
  assert.equal(groupMajorDigits('0'), '0');
  assert.equal(groupMajorDigits('1000'), '1,000');
  assert.equal(groupMajorDigits('1000000'), '1,000,000');
});
