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
 * Usage micros display (todo 20): the single audited formatter for the
 * Libre usage/requests panel. Raw integer micros flow BFF → frontend
 * untouched; major-unit rendering happens ONLY here, at the render boundary,
 * with string slicing + remainder — zero float arithmetic anywhere in this
 * file (integer string ops only: no division operator, no float parsing,
 * no fixed-notation formatting). Currency is pinned: it is
 * always the server-returned ISO code, never converted or defaulted.
 *
 * 1 major = 1,000,000 micros (TokenPanel `money-micros.ts:23`).
 */

const MICROS_DIGITS = 6;
const HALF_MAJOR_MICROS = '500000';

const isMicros = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);

/** Split integer micros into sign + major digits + 6-digit fraction digits. */
const splitMicros = (
  amountMicros: number
): { sign: string; major: string; fraction: string } | null => {
  if (!isMicros(amountMicros)) return null;
  const sign = amountMicros < 0 ? '-' : '';
  const digits = String(Math.abs(amountMicros));
  const major =
    digits.length > MICROS_DIGITS
      ? digits.slice(0, digits.length - MICROS_DIGITS)
      : '0';
  const fraction =
    digits.length > MICROS_DIGITS
      ? digits.slice(digits.length - MICROS_DIGITS)
      : digits.padStart(MICROS_DIGITS, '0');
  return { sign, major, fraction };
};

/** Group major-unit digits in threes (ASCII-safe, RTL-neutral). */
export const groupMajorDigits = (major: string): string =>
  major.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * Format integer micros as `1,234.56789 CUR` with exact fraction digits
 * (trailing zeros trimmed, so whole majors render as `192 CUR`).
 */
export const formatSpendMicros = (
  amountMicros: number,
  currency: string
): string => {
  const parts = splitMicros(amountMicros);
  if (!parts) return `— ${currency}`;
  const fraction = parts.fraction.replace(/0+$/, '');
  const major = groupMajorDigits(parts.major);
  return fraction
    ? `${parts.sign}${major}.${fraction} ${currency}`
    : `${parts.sign}${major} ${currency}`;
};

/**
 * fmtMicrosVnd-equivalent: integer micros → whole major units, half-up
 * (string comparison + BigInt carry, no floats). `1,499,999` → `1 CUR`,
 * `1,500,000` → `2 CUR`.
 */
export const formatSpendWhole = (
  amountMicros: number,
  currency: string
): string => {
  const parts = splitMicros(amountMicros);
  if (!parts) return `— ${currency}`;
  const major =
    parts.fraction >= HALF_MAJOR_MICROS
      ? String(BigInt(parts.major) + 1n)
      : parts.major;
  return `${parts.sign}${groupMajorDigits(major)} ${currency}`;
};

/** Format an integer token/request count with grouping (no floats). */
export const formatCount = (value: number): string => {
  if (!isMicros(value)) return '—';
  const sign = value < 0 ? '-' : '';
  return `${sign}${groupMajorDigits(String(Math.abs(value)))}`;
};
