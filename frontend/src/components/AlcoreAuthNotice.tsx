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
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import { CanonicalGoogleButton } from '@/components/CanonicalGoogleButton';
import {
  alcoreDirectPassword,
  alcoreDirectProductCode,
  alcoreDirectResetRequest,
  authApi,
} from '@/utils/api/authApi';
import { cn } from '@/utils';
import {
  ALCORE_AUTH_STATE_KEY,
  isAuthBrowserHandoffEnabled,
  startAuthHandoff,
} from '@/utils/canonicalHandoff';
import { AUTH_BASE_URL } from '@/utils/config';

// Re-exported from the leaf-backed handoff module so every existing importer
// keeps one path to the ONE state key, while the component itself no longer
// owns a declaration the state machine would have to import back (that cycle
// broke the production bundle — task-8-e2e evidence).
export { ALCORE_AUTH_STATE_KEY };

/**
 * Alcore-mode sign-in panel.
 *
 * Deliberately the same visual form as the local LoginForm (heading, email +
 * password, submit, Google button, create-account / forgot-password links).
 * Every action is Auth-backed: email/password forms POST browser→Auth
 * directly (Auth verifies; Libre never sees the password). The Auth access
 * token lives in a local just long enough to fetch the opaque single-use
 * product code, then is discarded — Libre stores only its own product
 * session. Google sign-in resolves to the same Auth subject, hence the same
 * Libre profile (never a dupe row). No interstitial copy, no disabled
 * buttons: when Google is not configured the button renders nothing.
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
      throw new Error('Sign-in failed. Please try again.');
    }
    login(response.data.user, response.data.token, response.data.systemInfo);
    toast.success(t('auth.login.loginSuccess'));
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
      if (isAuthBrowserHandoffEnabled()) {
        setNotice(t('auth.alcore.redirecting'));
        window.location.assign(
          startAuthHandoff(AUTH_BASE_URL, window.location.origin)
        );
      } else {
        authAccessToken = signIn.authAccessToken ?? null;
        if (authAccessToken === null) {
          throw new Error('Sign-in failed. Please try again.');
        }
        const code = await alcoreDirectProductCode(authAccessToken);
        authAccessToken = null;
        await finishWithCode(code);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
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
      setError('Sign-in failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const signingUp = mode === 'signup';
  const resetting = mode === 'reset';

  const inputClass =
    'h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink shadow-subtle outline-none transition-[border-color,box-shadow,background-color] placeholder:text-ink-muted focus:border-line-strong focus:ring-2 focus:ring-primary-500/35 disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-ink-muted motion-reduce:transition-none';

  return (
    <div className='mx-auto w-full max-w-md' data-testid='alcore-auth-notice'>
      <div className='mb-8 text-start'>
        <h1 className='mb-2 text-3xl font-light tracking-[-0.04em] text-ink'>
          {signingUp ? t('auth.signup.title') : t('auth.login.title')}
        </h1>
        <p className='text-sm leading-6 text-ink-muted'>
          {signingUp ? t('auth.signup.subtitle') : t('auth.login.subtitle')}
        </p>
      </div>

      {resetting ? (
        <form onSubmit={submitReset} className='space-y-5'>
          <div>
            <label
              htmlFor='alcore-email'
              className='mb-2 block text-sm font-medium text-ink'
            >
              {t('auth.alcore.email')}
            </label>
            <input
              id='alcore-email'
              type='email'
              required
              autoComplete='email'
              value={email}
              onChange={event => setEmail(event.target.value)}
              placeholder={t('auth.alcore.email')}
              className={inputClass}
              disabled={busy}
            />
          </div>
          <button
            type='submit'
            disabled={busy}
            className='flex h-11 w-full items-center justify-center rounded-xl border border-transparent bg-ink px-4 text-sm font-medium text-ink-inverse shadow-subtle transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none'
          >
            {t('auth.alcore.sendReset')}
          </button>
          <button
            type='button'
            onClick={() => setMode('login')}
            className='w-full text-center text-sm font-medium text-ink-muted transition-colors hover:text-ink'
          >
            {t('auth.alcore.backToLogin')}
          </button>
        </form>
      ) : (
        <form onSubmit={submitPassword} className='space-y-5'>
          <div>
            <label
              htmlFor='alcore-email'
              className='mb-2 block text-sm font-medium text-ink'
            >
              {t('auth.alcore.email')}
            </label>
            <input
              id='alcore-email'
              type='email'
              required
              autoComplete='email'
              value={email}
              onChange={event => setEmail(event.target.value)}
              placeholder={t('auth.alcore.email')}
              className={inputClass}
              disabled={busy}
            />
          </div>
          <div>
            <label
              htmlFor='alcore-password'
              className='mb-2 block text-sm font-medium text-ink'
            >
              {t('auth.alcore.password')}
            </label>
            <input
              id='alcore-password'
              type='password'
              required
              autoComplete={signingUp ? 'new-password' : 'current-password'}
              value={password}
              onChange={event => setPassword(event.target.value)}
              placeholder={t('auth.alcore.password')}
              className={inputClass}
              disabled={busy}
            />
          </div>
          <button
            type='submit'
            disabled={busy}
            className='flex h-11 w-full items-center justify-center rounded-xl border border-transparent bg-ink px-4 text-sm font-medium text-ink-inverse shadow-subtle transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none'
          >
            {busy
              ? signingUp
                ? t('auth.signup.creatingAccount')
                : t('auth.login.signingIn')
              : signingUp
                ? t('auth.signup.createAccount')
                : t('auth.login.signIn')}
          </button>
          <div
            className={cn(
              'flex items-center text-sm font-medium text-ink-muted',
              'justify-between'
            )}
          >
            <button
              type='button'
              onClick={() => setMode(signingUp ? 'login' : 'signup')}
              className='transition-colors hover:text-ink'
            >
              {signingUp
                ? t('auth.alcore.haveAccount')
                : t('auth.alcore.needAccount')}
            </button>
            <button
              type='button'
              onClick={() => setMode('reset')}
              className='transition-colors hover:text-ink'
            >
              {t('auth.alcore.forgot')}
            </button>
          </div>
        </form>
      )}

      {!resetting && <CanonicalGoogleButton />}

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
