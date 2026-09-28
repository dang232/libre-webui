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

/**
 * Billing micros helpers (todo 21): integer-exact money display for the
 * Libre billing UI. Amounts arrive from the BFF in integer micros plus an
 * ISO currency code and are rendered with integer division + remainder only
 * — never floats. The QR TTL is server-authoritative (`qrExpiresAt`); these
 * helpers only derive display state (remaining ms, expired?) from it.
 */

export const MICROS_PER_MAJOR = 1_000_000;

/** True for positive integer micros (the only shape the BFF accepts). */
export const isPositiveIntegerMicros = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value > 0 &&
  Number.isSafeInteger(value);

/**
 * Format integer micros as `123.456789 CUR` with exact fraction digits
 * (integer division + zero-padded remainder, no float math).
 */
export const formatMicros = (
  amountMicros: number,
  currency: string
): string => {
  if (!Number.isSafeInteger(amountMicros)) return `— ${currency}`;
  const sign = amountMicros < 0 ? '-' : '';
  const abs = Math.abs(amountMicros);
  const major = Math.trunc(abs / MICROS_PER_MAJOR);
  const minor = abs % MICROS_PER_MAJOR;
  return `${sign}${major}.${String(minor).padStart(6, '0')} ${currency}`;
};

/** Parse a major-unit decimal string to integer micros (string split only). */
export const parseMajorToMicros = (text: string): number | null => {
  const trimmed = text.trim();
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(trimmed);
  if (!match) return null;
  const major = Number(match[1]);
  const fraction = (match[2] ?? '').padEnd(6, '0');
  const micros = major * MICROS_PER_MAJOR + Number(fraction);
  if (!Number.isSafeInteger(micros) || micros <= 0) return null;
  return micros;
};

export interface QrExpiryState {
  /** Milliseconds until expiry (<= 0 means expired). Server clock assumed. */
  remainingMs: number;
  expired: boolean;
}

/** Derive QR display state from the server-issued `qrExpiresAt`. */
export const qrExpiryState = (
  qrExpiresAt: string | null | undefined,
  nowMs = Date.now()
): QrExpiryState | null => {
  if (!qrExpiresAt) return null;
  const expiresMs = Date.parse(qrExpiresAt);
  if (Number.isNaN(expiresMs)) return null;
  const remainingMs = expiresMs - nowMs;
  return { remainingMs, expired: remainingMs <= 0 };
};

/** Format a remaining-ms countdown as `MM:SS` (clamped at zero). */
export const formatCountdown = (remainingMs: number): string => {
  const totalSeconds = Math.max(0, Math.trunc(remainingMs / 1000));
  const minutes = Math.trunc(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};
