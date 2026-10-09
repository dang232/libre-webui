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
 * Public self-service signup through Auth (open registration).
 *
 * The credential is created at Auth and never at Libre: this module holds
 * no HTTP client of its own. Validation is pure and unit-tested; the
 * register-then-exchange orchestration takes injected dependencies so
 * tests cover happy/duplicate/mismatch without touching the network and
 * without creating accounts. The component supplies the real
 * Auth-driven dependencies (`alcoreDirectPassword('register')`,
 * `alcoreDirectProductCode`, `authApi.alcoreExchange`, redirect handoff).
 */

import { getPasswordPolicyErrorKey } from '@/utils/passwordPolicy';

export interface AlcoreSignupInput {
  email: string;
  password: string;
  confirmPassword: string;
}

export type AlcoreSignupValidationCode =
  'emailInvalid' | 'passwordMismatch' | 'passwordPolicy';

export interface AlcoreSignupValidation {
  ok: boolean;
  code?: AlcoreSignupValidationCode;
  /** Policy detail as an i18n key (same source as the local signup form). */
  detail?: string;
  /** Trimmed email, present only when validation passes. */
  email?: string;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateAlcoreSignup(
  input: AlcoreSignupInput
): AlcoreSignupValidation {
  const email = input.email.trim();
  if (!email || !EMAIL_SHAPE.test(email)) {
    return { ok: false, code: 'emailInvalid' };
  }
  if (input.password !== input.confirmPassword) {
    return { ok: false, code: 'passwordMismatch' };
  }
  const policyError = getPasswordPolicyErrorKey(input.password);
  if (policyError) {
    return { ok: false, code: 'passwordPolicy', detail: policyError };
  }
  return { ok: true, email };
}

export interface AlcoreSession {
  user: unknown;
  token: string;
  systemInfo: unknown;
}

export type AlcoreSignupResult =
  | { ok: true; session: AlcoreSession }
  | { ok: true; redirected: true }
  | { ok: false; code: AlcoreSignupValidationCode; detail?: string }
  | { ok: false; code: 'register'; message: string };

export interface AlcoreSignupDeps {
  /**
   * Register the credential at Auth. Resolves with the Auth session on
   * the bearer path, or without a token on the redirect-handoff path
   * (the HttpOnly cookie is the credential there). Rejects with an
   * Error carrying a safe, non-enumerating message.
   */
  registerDirect: (
    email: string,
    password: string
  ) => Promise<{ authAccessToken?: string }>;
  /** Redeem an Auth session for the single-use Libre product code. */
  fetchProductCode: (authAccessToken: string) => Promise<string>;
  /** Redeem the product code at the Libre BFF (lazy-provisions). */
  exchangeCode: (code: string) => Promise<AlcoreSession>;
  /** Start the redirect handoff (navigates away to Auth). */
  startRedirectHandoff: () => void;
}

/**
 * Register at Auth, then exchange into a Libre session.
 *
 * Same credential on both products: the Auth email/password created in
 * step one is the identity the BFF lazy-provisions in step three. No
 * Libre-local password is ever created. Duplicate emails surface Auth's
 * safe message without revealing whether an address is registered.
 */
export async function runAlcoreSignup(
  input: AlcoreSignupInput,
  deps: AlcoreSignupDeps
): Promise<AlcoreSignupResult> {
  const validation = validateAlcoreSignup(input);
  if (!validation.ok) {
    return {
      ok: false,
      code: validation.code as AlcoreSignupValidationCode,
      ...(validation.detail !== undefined ? { detail: validation.detail } : {}),
    };
  }
  const email = validation.email as string;

  let registration: { authAccessToken?: string };
  try {
    registration = await deps.registerDirect(email, input.password);
  } catch (error) {
    return {
      ok: false,
      code: 'register',
      message:
        error instanceof Error ? error.message : 'Sign-up failed. Try again.',
    };
  }

  // Redirect-handoff path: the Auth cookie set by registration is the
  // credential, so hand the browser to Auth to complete the exchange.
  if (!registration.authAccessToken) {
    deps.startRedirectHandoff();
    return { ok: true, redirected: true };
  }

  const code = await deps.fetchProductCode(registration.authAccessToken);
  const session = await deps.exchangeCode(code);
  return { ok: true, session };
}
