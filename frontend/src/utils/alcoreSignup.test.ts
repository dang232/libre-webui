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
 * Signup route validation plus the register-then-exchange flow.
 *
 * Dependencies are injected fakes: no network, no accounts created, and
 * every failure path asserts its collaborator was (or was not) called.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runAlcoreSignup,
  validateAlcoreSignup,
  type AlcoreSignupDeps,
} from './alcoreSignup.ts';

const STRONG = 'Sunrise-Bridge-42';

const happyDeps = (calls: string[]): AlcoreSignupDeps => ({
  registerDirect: async email => {
    calls.push(`register:${email}`);
    return { authAccessToken: 'auth-token' };
  },
  fetchProductCode: async token => {
    calls.push(`code:${token}`);
    return 'product-code';
  },
  exchangeCode: async code => {
    calls.push(`exchange:${code}`);
    return { user: { id: 'u1' }, token: 'libre-token', systemInfo: {} };
  },
  startRedirectHandoff: () => {
    calls.push('redirect');
  },
});

describe('validateAlcoreSignup', () => {
  it('accepts a well-formed email with a strong matching password', () => {
    const result = validateAlcoreSignup({
      email: '  ada@example.com ',
      password: STRONG,
      confirmPassword: STRONG,
    });
    assert.equal(result.ok, true);
    assert.equal(result.email, 'ada@example.com');
  });

  it('rejects a malformed email', () => {
    for (const email of ['', 'ada', 'ada@', 'ada@example', 'a d@x.com']) {
      const result = validateAlcoreSignup({
        email,
        password: STRONG,
        confirmPassword: STRONG,
      });
      assert.equal(result.ok, false, email || '(empty)');
      assert.equal(result.code, 'emailInvalid');
    }
  });

  it('rejects mismatched passwords before any policy check', () => {
    const result = validateAlcoreSignup({
      email: 'ada@example.com',
      password: STRONG,
      confirmPassword: `${STRONG}-other`,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'passwordMismatch');
  });

  it('rejects a weak password with the policy detail', () => {
    const result = validateAlcoreSignup({
      email: 'ada@example.com',
      password: 'short-1-A',
      confirmPassword: 'short-1-A',
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'passwordPolicy');
    assert.match(result.detail ?? '', /12 characters/);
  });
});

describe('runAlcoreSignup', () => {
  it('happy path: register at Auth, then exchange into a Libre session', async () => {
    const calls: string[] = [];
    const result = await runAlcoreSignup(
      {
        email: 'ada@example.com',
        password: STRONG,
        confirmPassword: STRONG,
      },
      happyDeps(calls)
    );
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      'register:ada@example.com',
      'code:auth-token',
      'exchange:product-code',
    ]);
    assert.equal(
      (result as { session: { token: string } }).session.token,
      'libre-token'
    );
  });

  it('duplicate: a taken email fails with a safe message and never exchanges', async () => {
    const calls: string[] = [];
    const deps = happyDeps(calls);
    deps.registerDirect = async () => {
      calls.push('register');
      throw new Error('An account with this email already exists.');
    };
    const result = await runAlcoreSignup(
      {
        email: 'taken@example.com',
        password: STRONG,
        confirmPassword: STRONG,
      },
      deps
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'register');
    assert.equal(
      (result as { message: string }).message,
      'An account with this email already exists.'
    );
    assert.deepEqual(calls, ['register']);
  });

  it('mismatch: validation blocks before any Auth call', async () => {
    const calls: string[] = [];
    const result = await runAlcoreSignup(
      {
        email: 'ada@example.com',
        password: STRONG,
        confirmPassword: 'different-password-1A',
      },
      happyDeps(calls)
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'passwordMismatch');
    assert.deepEqual(calls, []);
  });

  it('redirect path: registration without a token starts the Auth handoff', async () => {
    const calls: string[] = [];
    const deps = happyDeps(calls);
    deps.registerDirect = async () => ({});
    const result = await runAlcoreSignup(
      {
        email: 'hop@example.com',
        password: STRONG,
        confirmPassword: STRONG,
      },
      deps
    );
    assert.equal(result.ok, true);
    assert.equal((result as { redirected: boolean }).redirected, true);
    assert.deepEqual(calls, ['redirect']);
  });
});
