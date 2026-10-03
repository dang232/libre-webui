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
import {
  alcoreDirectPassword,
  alcoreDirectProductCode,
  authApi,
} from '@/utils/api/authApi';
import { isAuthBrowserHandoffEnabled } from '@/utils/canonicalHandoff';

/**
 * Incumbent claim form (unified-auth-core todo 19).
 *
 * For a pre-existing Libre-only account: the Libre username + password
 * prove row ownership (verified server-side without minting a local
 * session), and one Auth password sign-in fetches the single-use product
 * code that proves the Auth subject. The server links the two (or reports
 * a manual-link conflict) and returns a normal Auth-derived session.
 * Auth accounts created with Google resolve to manual linking instead
 * (contact support) — this form covers the single password-based live
 * path only.
 */
export const AlcoreClaimForm: React.FC = () => {
  const { t } = useTranslation();
  const login = useAuthStore(state => state.login);
  const [open, setOpen] = React.useState(false);
  const [libreUsername, setLibreUsername] = React.useState('');
  const [librePassword, setLibrePassword] = React.useState('');
  const [authEmail, setAuthEmail] = React.useState('');
  const [authPassword, setAuthPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submitClaim = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    let authAccessToken: string | null = null;
    try {
      const signIn = await alcoreDirectPassword(
        'login',
        authEmail.trim(),
        authPassword
      );
      authAccessToken = signIn.authAccessToken ?? null;
      if (authAccessToken === null) {
        throw new Error(t('auth.alcore.claim.redirectUnsupported'));
      }
      const code = await alcoreDirectProductCode(authAccessToken);
      authAccessToken = null;
      const response = await authApi.alcoreClaim({
        username: libreUsername.trim(),
        password: librePassword,
        code,
      });
      if (!response.success || !response.data) {
        throw new Error(t('auth.alcore.claim.failed'));
      }
      login(response.data.user, response.data.token, response.data.systemInfo);
      toast.success(t('auth.alcore.claim.success'));
    } catch (err) {
      if (
        err instanceof Error &&
        /contact support to link it/i.test(err.message)
      ) {
        setError(t('auth.alcore.claim.manual'));
      } else {
        setError(
          err instanceof Error ? err.message : t('auth.alcore.claim.failed')
        );
      }
    } finally {
      authAccessToken = null;
      setLibrePassword('');
      setAuthPassword('');
      setBusy(false);
    }
  };

  const inputClass =
    'h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink shadow-subtle outline-none transition-[border-color,box-shadow,background-color] placeholder:text-ink-muted focus:border-line-strong focus:ring-2 focus:ring-primary-500/35 disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-ink-muted motion-reduce:transition-none';

  return (
    <div
      className='mx-auto mt-6 w-full max-w-md'
      data-testid='alcore-claim-form'
    >
      <button
        type='button'
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        className='w-full text-center text-sm font-medium text-ink-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500'
      >
        {t('auth.alcore.claim.title')}
      </button>
      {open && (
        <form onSubmit={submitClaim} className='mt-4 space-y-5'>
          <p className='text-sm leading-6 text-ink-muted'>
            {t('auth.alcore.claim.body')}
          </p>
          <div>
            <label
              htmlFor='alcore-claim-username'
              className='mb-2 block text-sm font-medium text-ink'
            >
              {t('auth.alcore.claim.libreUsername')}
            </label>
            <input
              id='alcore-claim-username'
              type='text'
              required
              autoComplete='username'
              value={libreUsername}
              onChange={event => setLibreUsername(event.target.value)}
              placeholder={t('auth.alcore.claim.libreUsername')}
              className={inputClass}
              disabled={busy}
            />
          </div>
          <div>
            <label
              htmlFor='alcore-claim-password'
              className='mb-2 block text-sm font-medium text-ink'
            >
              {t('auth.alcore.claim.librePassword')}
            </label>
            <input
              id='alcore-claim-password'
              type='password'
              required
              autoComplete='current-password'
              value={librePassword}
              onChange={event => setLibrePassword(event.target.value)}
              placeholder={t('auth.alcore.claim.librePassword')}
              className={inputClass}
              disabled={busy}
            />
          </div>
          <div>
            <label
              htmlFor='alcore-claim-email'
              className='mb-2 block text-sm font-medium text-ink'
            >
              {t('auth.alcore.claim.authEmail')}
            </label>
            <input
              id='alcore-claim-email'
              type='email'
              required
              autoComplete='email'
              value={authEmail}
              onChange={event => setAuthEmail(event.target.value)}
              placeholder={t('auth.alcore.claim.authEmail')}
              className={inputClass}
              disabled={busy}
            />
          </div>
          <div>
            <label
              htmlFor='alcore-claim-auth-password'
              className='mb-2 block text-sm font-medium text-ink'
            >
              {t('auth.alcore.claim.authPassword')}
            </label>
            <input
              id='alcore-claim-auth-password'
              type='password'
              required
              autoComplete='current-password'
              value={authPassword}
              onChange={event => setAuthPassword(event.target.value)}
              placeholder={t('auth.alcore.claim.authPassword')}
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
              ? t('auth.alcore.claim.claiming')
              : t('auth.alcore.claim.submit')}
          </button>
          {error && (
            <p role='alert' className='mt-3 text-[13px] text-red-600'>
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
};
