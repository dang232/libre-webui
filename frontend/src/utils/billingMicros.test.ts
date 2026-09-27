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
  formatCountdown,
  formatMicros,
  isPositiveIntegerMicros,
  parseMajorToMicros,
  qrExpiryState,
} from './billingMicros.ts';

test('formatMicros renders integer micros without floats', () => {
  assert.equal(formatMicros(192_000_000, 'VND'), '192.000000 VND');
  assert.equal(formatMicros(1, 'USD'), '0.000001 USD');
  assert.equal(formatMicros(-6_000, 'USD'), '-0.006000 USD');
  assert.equal(formatMicros(5_000_000, 'USD'), '5.000000 USD');
});

test('isPositiveIntegerMicros gates the intent boundary', () => {
  assert.equal(isPositiveIntegerMicros(1_000_000), true);
  assert.equal(isPositiveIntegerMicros(0), false);
  assert.equal(isPositiveIntegerMicros(-5), false);
  assert.equal(isPositiveIntegerMicros(1.5), false);
  assert.equal(isPositiveIntegerMicros('100'), false);
  assert.equal(isPositiveIntegerMicros(Number.NaN), false);
});

test('parseMajorToMicros uses string math only', () => {
  assert.equal(parseMajorToMicros('192'), 192_000_000);
  assert.equal(parseMajorToMicros('0.000001'), 1);
  assert.equal(parseMajorToMicros('  2.5 '), 2_500_000);
  assert.equal(parseMajorToMicros('0'), null);
  assert.equal(parseMajorToMicros('-3'), null);
  assert.equal(parseMajorToMicros('1.2345678'), null);
  assert.equal(parseMajorToMicros('abc'), null);
  assert.equal(parseMajorToMicros(''), null);
});

test('qrExpiryState honors the server TTL', () => {
  const now = Date.parse('2026-09-27T00:00:00.000Z');
  const live = qrExpiryState('2026-09-27T00:15:00.000Z', now);
  assert.ok(live && !live.expired && live.remainingMs === 900_000);
  const dead = qrExpiryState('2026-09-26T23:59:00.000Z', now);
  assert.ok(dead && dead.expired && dead.remainingMs < 0);
  assert.equal(qrExpiryState(null, now), null);
  assert.equal(qrExpiryState('not-a-date', now), null);
});

test('formatCountdown renders MM:SS clamped at zero', () => {
  assert.equal(formatCountdown(900_000), '15:00');
  assert.equal(formatCountdown(61_000), '01:01');
  assert.equal(formatCountdown(0), '00:00');
  assert.equal(formatCountdown(-5_000), '00:00');
});
