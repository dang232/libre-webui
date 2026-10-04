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
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import {
  alcoreDirectPassword,
  alcoreDirectProductCode,
  authApi,
} from '@/utils/api/authApi';
import { AUTH_BASE_URL } from '@/utils/config';
import { startAuthHandoff } from '@/utils/canonicalHandoff';

/**
 * R4: Auth sign-in before the handoff.
 *
 * Always-visible primary sign-in for the simplified login panel: the
 * password travels browser→Auth only (never through Libre, exactly
 * like the claim and signup forms), the Auth session lands in Auth's
 * HttpOnly cookie, and a successful sign-in continues into the
 * redirect handoff automatically.
 */
export const AlcoreDirectSignIn: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const login = useAuthStore(state => state.login);
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submitSignIn = async (
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const signIn = await alcoreDirectPassword(
        'login',
        email.trim(),
        password
      );
      if (signIn.authAccessToken !== undefined) {
        // Legacy bearer handoff: redeem the product code at the BFF now.
        const code = await alcoreDirectProductCode(signIn.authAccessToken);
        const response = await authApi.alcoreExchange({ code });
        if (!response.success || !response.data) {
          throw new Error(t('auth.alcore.signin.failed'));
        }
        login(
          response.data.user,
          response.data.token,
          response.data.systemInfo
        );
        navigate('/', { replace: true });
        return;
      }
      // Redirect handoff: the Auth cookie set above is the credential —
      // hand off immediately, Auth 302s back with the single-use code.
      window.location.assign(
        startAuthHandoff(AUTH_BASE_URL, window.location.origin)
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t('auth.alcore.signin.failed')
      );
    } finally {
      setPassword('');
      setBusy(false);
    }
  };

  const inputClass =
    'h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink shadow-subtle outline-none transition-[border-color,box-shadow,background-color] placeholder:text-ink-muted focus:border-line-strong focus:ring-2 focus:ring-primary-500/35 disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-ink-muted motion-reduce:transition-none';

  return (
    <div className='w-full' data-testid='alcore-direct-signin'>
      <form onSubmit={submitSignIn} className='space-y-5'>
        <div>
          <label
            htmlFor='alcore-signin-email'
            className='mb-2 block text-sm font-medium text-ink'
          >
            {t('auth.alcore.signin.email')}
          </label>
          <input
            id='alcore-signin-email'
            type='email'
            required
            autoComplete='email'
            value={email}
            onChange={event => setEmail(event.target.value)}
            placeholder={t('auth.alcore.signin.email')}
            className={inputClass}
            disabled={busy}
          />
        </div>
        <div>
          <label
            htmlFor='alcore-signin-password'
            className='mb-2 block text-sm font-medium text-ink'
          >
            {t('auth.alcore.signin.password')}
          </label>
          <input
            id='alcore-signin-password'
            type='password'
            required
            autoComplete='current-password'
            value={password}
            onChange={event => setPassword(event.target.value)}
            placeholder={t('auth.alcore.signin.password')}
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
            ? t('auth.alcore.signin.signingIn')
            : t('auth.alcore.signin.submit')}
        </button>
        {error && (
          <p role='alert' className='mt-3 text-[13px] text-red-600'>
            {error}
          </p>
        )}
      </form>
    </div>
  );
};
