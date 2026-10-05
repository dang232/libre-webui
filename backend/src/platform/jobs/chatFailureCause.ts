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

export type ChatFailureCause =
  'rate-limited' | 'unverified' | 'model-unavailable' | 'upstream-incomplete';

/**
 * Classify a chat generation failure into a user-actionable cause from the
 * underlying provider/auth error text. Returns null when nothing matches
 * so callers keep the generic message. Pure: unit-tested with prod-log
 * fixtures, no logging or I/O inside.
 */
export function classifyChatFailureCause(
  error: unknown
): ChatFailureCause | null {
  const text =
    error instanceof Error
      ? `${error.name} ${error.message}`
      : String(error ?? '');
  if (/rate_limited|rate[ -]?limit|\b429\b/i.test(text)) return 'rate-limited';
  if (/email_unverified|email verification/i.test(text)) return 'unverified';
  if (
    /model_not_found|model .*not (available|supported)|not in .*package|không có trong gói|no active plugin|no provider candidate/i.test(
      text
    )
  )
    return 'model-unavailable';
  if (/\b403\b|\b401\b|unauthorized|invalid_credential|forbidden/i.test(text))
    return null;
  if (
    /incomplete|truncat|timeout|timed out|connection|malformed|empty.*(response|body)|no response|upstream|provider_rejected|provider.*unavailable|5\d\d/i.test(
      text
    )
  )
    return 'upstream-incomplete';
  return null;
}
