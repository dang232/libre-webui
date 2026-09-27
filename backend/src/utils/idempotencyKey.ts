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
 * Shared Idempotency-Key handling for the Libre BFF (plan Wave4 todo 23).
 *
 * Rule: every mutating BFF→TokenPanel call carries an Idempotency-Key.
 * A browser-supplied key is forwarded verbatim when valid; when the browser
 * sends none, the BFF mints a CSPRNG UUID so retries at the BFF layer still
 * dedupe upstream. Garbage is never forwarded — invalid keys answer 400 at
 * the boundary.
 *
 * Bounds mirror the upstream contract (`IDEMPOTENCY_KEY_MAX_CHARS = 128` in
 * TokenPanel `lib/idempotency.ts`, same bound on bridge-resolve/provision):
 * non-empty after trim, at most 128 chars, visible ASCII only (rejects
 * CR/LF smuggling, control bytes, and whitespace). An absent header and a
 * blank header are equivalent — both mint. Keys are opaque tokens: they are
 * never logged (fingerprint only if observability ever needs them).
 */

import { randomUUID } from 'node:crypto';
import type express from 'express';

/** Mirrors the upstream 128-char bound (lane 19/21/22 tests pin this). */
export const IDEMPOTENCY_KEY_MAX_CHARS = 128;

/** Visible ASCII, no whitespace: `!` (0x21) through `~` (0x7E). */
const VISIBLE_ASCII_PATTERN = /^[\x21-\x7E]+$/;

/**
 * A supplied key is valid when it is a non-empty, ≤128-char visible-ASCII
 * token after trimming. Trimming is identity for valid keys (they cannot
 * contain spaces), so forwarding the trimmed form is verbatim.
 */
export const isValidIdempotencyKey = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const key = value.trim();
  return (
    key.length > 0 &&
    key.length <= IDEMPOTENCY_KEY_MAX_CHARS &&
    VISIBLE_ASCII_PATTERN.test(key)
  );
};

export type IdempotencyHeaderRead =
  | { readonly status: 'present'; readonly key: string }
  | { readonly status: 'absent' }
  | { readonly status: 'invalid' };

/**
 * Read the inbound `Idempotency-Key` header. Array forms (duplicate
 * headers) use the first entry; missing or blank means absent (mint
 * downstream), anything else malformed means invalid (400 downstream).
 */
export const readIdempotencyKeyHeader = (
  req: express.Request
): IdempotencyHeaderRead => {
  const raw = req.headers['idempotency-key'];
  if (raw === undefined) return { status: 'absent' };
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first === undefined || first === null || String(first).trim() === '') {
    return { status: 'absent' };
  }
  const key = String(first).trim();
  if (!isValidIdempotencyKey(key)) return { status: 'invalid' };
  return { status: 'present', key };
};

export type ForwardOrMint =
  { readonly key: string } | { readonly invalid: true };

/**
 * Route-level helper: forward the browser key verbatim when present and
 * valid, mint a CSPRNG UUID when absent, signal invalid for a 400.
 */
export const forwardOrMintIdempotencyKey = (
  req: express.Request
): ForwardOrMint => {
  const read = readIdempotencyKeyHeader(req);
  if (read.status === 'invalid') return { invalid: true as const };
  if (read.status === 'present') return { key: read.key };
  return { key: randomUUID() };
};

/**
 * Service-level helper: resolve a caller-supplied key to the value that
 * rides upstream. Absent/blank mints a CSPRNG UUID; invalid returns null
 * so the service can raise its own typed 400 (never forward garbage).
 */
export const resolveServiceIdempotencyKey = (
  provided: unknown
): string | null => {
  if (provided === undefined || provided === null) return randomUUID();
  if (typeof provided !== 'string' || provided.trim() === '') {
    return randomUUID();
  }
  const key = provided.trim();
  if (!isValidIdempotencyKey(key)) return null;
  return key;
};
