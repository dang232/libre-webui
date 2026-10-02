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

import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import { AUTH_BASE_URL } from '@/utils/config';
import {
  alcoreDirectPassword,
  alcoreDirectProductCode,
  alcoreDirectResetRequest,
  authApi,
} from '@/utils/api/authApi';

/** Session-storage key binding the redirect-handoff state to this tab. */
export const ALCORE_AUTH_STATE_KEY = 'alcore-auth-state';

const randomState = (): string => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
};

/**
 * Alcore-mode sign-in panel (todo 45).
 *
 * Email/password forms POST browser→Auth directly (Auth verifies; Libre
 * never sees the password). The Auth access token lives in a local just
 * long enough to fetch the opaque single-use product code, then is
 * discarded — Libre stores only its own product session. Google sign-in
 * happens in Auth too: a returning Google subject resolves to the same Auth
 * user, hence the same Libre profile. "Continue with Auth" covers the
 * redirect handoff for browsers already holding an Auth session.
 */
export const AlcoreAuthNotice: React.FC = () => {
  const { t } = useTranslation();
  const login = useAuthStore(state => state.login);
  const [mode, setMode] = React.useState<'login' | 'signup' | 'reset'>('login');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const finishWithCode = async (code: string): Promise<void> => {
    const response = await authApi.alcoreExchange({ code });
    if (!response.success || !response.data) {
      throw new Error('Auth sign-in failed; try again.');
    }
    login(response.data.user, response.data.token, response.data.systemInfo);
  };

  const submitPassword = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    let authAccessToken: string | null = null;
    try {
      const signIn = await alcoreDirectPassword(
        mode === 'signup' ? 'register' : 'login',
        email.trim(),
        password
      );
      authAccessToken = signIn.authAccessToken;
      const code = await alcoreDirectProductCode(authAccessToken);
      authAccessToken = null;
      await finishWithCode(code);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Auth sign-in failed.');
    } finally {
      authAccessToken = null;
      setPassword('');
      setBusy(false);
    }
  };

  const submitReset = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await alcoreDirectResetRequest(email.trim());
      setNotice(t('auth.alcore.resetSent'));
    } catch {
      setError('Auth sign-in failed; try again.');
    } finally {
      setBusy(false);
    }
  };

  const continueWithAuth = (): void => {
    // Redirect handoff (TARGET-ARCHITECTURE §3c): Auth 302s back to the
    // Libre callback with an opaque ?code=&state=. The state binds the
    // handoff to this tab; the callback verifies it before redeeming.
    const state = randomState();
    try {
      sessionStorage.setItem(ALCORE_AUTH_STATE_KEY, state);
    } catch {
      setError('This browser blocks sign-in state; try again.');
      return;
    }
    const redirectUri = `${window.location.origin}/auth/alcore/callback`;
    const url =
      `${AUTH_BASE_URL}/oidc/exchange/redirect` +
      `?audience=libre&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}`;
    window.location.href = url;
  };

  return (
    <div
      className='rounded-2xl border border-line bg-surface p-6 text-center'
      data-testid='alcore-auth-notice'
    >
      <p className='text-base font-medium text-ink'>{t('auth.alcore.title')}</p>
      <p className='mt-2 text-[13px] leading-relaxed text-ink-muted'>
        {t('auth.alcore.body')}
      </p>

      {mode === 'reset' ? (
        <form onSubmit={submitReset} className='mt-4 space-y-3 text-left'>
          <input
            type='email'
            required
            autoComplete='email'
            value={email}
            onChange={event => setEmail(event.target.value)}
            placeholder={t('auth.alcore.email')}
            aria-label={t('auth.alcore.email')}
            className='w-full rounded-xl border border-line bg-canvas px-4 py-2.5 text-sm text-ink'
          />
          <button
            type='submit'
            disabled={busy}
            className='w-full rounded-xl bg-ink px-4 py-2.5 text-sm font-medium text-canvas disabled:opacity-60'
          >
            {t('auth.alcore.sendReset')}
          </button>
          <button
            type='button'
            onClick={() => setMode('login')}
            className='w-full text-center text-[13px] text-ink-muted'
          >
            {t('auth.alcore.backToLogin')}
          </button>
        </form>
      ) : (
        <form onSubmit={submitPassword} className='mt-4 space-y-3 text-left'>
          <input
            type='email'
            required
            autoComplete='email'
            value={email}
            onChange={event => setEmail(event.target.value)}
            placeholder={t('auth.alcore.email')}
            aria-label={t('auth.alcore.email')}
            className='w-full rounded-xl border border-line bg-canvas px-4 py-2.5 text-sm text-ink'
          />
          <input
            type='password'
            required
            minLength={8}
            autoComplete={
              mode === 'signup' ? 'new-password' : 'current-password'
            }
            value={password}
            onChange={event => setPassword(event.target.value)}
            placeholder={t('auth.alcore.password')}
            aria-label={t('auth.alcore.password')}
            className='w-full rounded-xl border border-line bg-canvas px-4 py-2.5 text-sm text-ink'
          />
          <button
            type='submit'
            disabled={busy}
            className='w-full rounded-xl bg-ink px-4 py-2.5 text-sm font-medium text-canvas disabled:opacity-60'
          >
            {mode === 'signup'
              ? t('auth.alcore.signUp')
              : t('auth.alcore.signIn')}
          </button>
          <div className='flex items-center justify-between text-[13px] text-ink-muted'>
            <button
              type='button'
              onClick={() => setMode(mode === 'signup' ? 'login' : 'signup')}
            >
              {mode === 'signup'
                ? t('auth.alcore.haveAccount')
                : t('auth.alcore.needAccount')}
            </button>
            <button type='button' onClick={() => setMode('reset')}>
              {t('auth.alcore.forgot')}
            </button>
          </div>
        </form>
      )}

      <div className='my-4 border-t border-line' />

      <button
        type='button'
        onClick={continueWithAuth}
        className='w-full rounded-xl bg-ink-subtle px-4 py-2.5 text-sm font-medium text-ink'
      >
        {t('auth.alcore.continue')}
      </button>

      {error && (
        <p role='alert' className='mt-3 text-[13px] text-red-600'>
          {error}
        </p>
      )}
      {notice && (
        <p role='status' className='mt-3 text-[13px] text-ink-muted'>
          {notice}
        </p>
      )}
    </div>
  );
};
