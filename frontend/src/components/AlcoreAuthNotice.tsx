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
import {
  ALCORE_AUTH_STATE_KEY,
  buildGoogleStartUrl,
  canonicalCallbackUrl,
  generateState,
  rememberHandoffState,
  startAuthHandoff,
} from '@/utils/canonicalHandoff';
import { AUTH_BASE_URL } from '@/utils/config';
import { authApi } from '@/utils/api/authApi';

// Re-exported from the leaf-backed handoff module so every existing importer
// keeps one path to the ONE state key, while the component itself no longer
// owns a declaration the state machine would have to import back (that cycle
// broke the production bundle — task-8-e2e evidence).
export { ALCORE_AUTH_STATE_KEY };

/**
 * Alcore-mode sign-in panel (Auth-only).
 *
 * The ONLY ways in are the Auth redirect handoff and Google-via-Auth.
 * There is deliberately no email/password form here: passwords are
 * created and entered at Auth only, never transit the Libre UI, and no
 * Libre client call posts a password anywhere in this panel. The handoff
 * hands the browser to Auth (`GET /oidc/exchange/redirect`); Auth 302s
 * back to `/auth/alcore/callback` with a single-use code that the
 * callback page redeems at the BFF. Local-mode login (LoginForm /
 * SignupForm) is untouched and branches on the same server-advertised
 * `systemInfo.authMode` flag from LoginPage.
 */
export const AlcoreAuthNotice: React.FC = () => {
  const { t } = useTranslation();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  // R18: the Google entry renders only while Auth reports it configured.
  // Default true so the first paint (and SSR) keeps the working path;
  // a failed probe fails open rather than stranding the user.
  const [googleEnabled, setGoogleEnabled] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    authApi
      .googleStatus()
      .then(response => {
        if (!cancelled && response.success && response.data) {
          setGoogleEnabled(response.data.configured === true);
        }
      })
      .catch(() => {
        // Fail open: a status probe that cannot answer must not remove
        // the only human-completable path on this panel.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleContinueWithAuth = (): void => {
    try {
      setBusy(true);
      setError(null);
      setNotice(t('auth.alcore.redirecting'));
      window.location.assign(
        startAuthHandoff(AUTH_BASE_URL, window.location.origin)
      );
    } catch {
      setBusy(false);
      setNotice(null);
      setError('Sign-in failed. Please try again.');
    }
  };

  const handleGoogleViaAuth = (): void => {
    try {
      const state = generateState();
      rememberHandoffState(state);
      const redirectUri = canonicalCallbackUrl(window.location.origin);
      window.location.assign(
        buildGoogleStartUrl(AUTH_BASE_URL, 'libre', redirectUri, state)
      );
    } catch {
      setError('Sign-in failed. Please try again.');
    }
  };

  return (
    <div className='mx-auto w-full max-w-md' data-testid='alcore-auth-notice'>
      <div className='mb-8 text-start'>
        <h1 className='mb-2 text-3xl font-light tracking-[-0.04em] text-ink'>
          {t('auth.login.title')}
        </h1>
        <p className='text-sm leading-6 text-ink-muted'>
          {t('auth.login.subtitle')}
        </p>
      </div>

      <button
        type='button'
        data-testid='alcore-continue-button'
        onClick={handleContinueWithAuth}
        disabled={busy}
        className='flex h-11 w-full items-center justify-center rounded-xl border border-transparent bg-ink px-4 text-sm font-medium text-ink-inverse shadow-subtle transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none'
      >
        {t('auth.alcore.continue')}
      </button>

      {googleEnabled ? (
        <button
          type='button'
          data-testid='alcore-google-button'
          onClick={handleGoogleViaAuth}
          disabled={busy}
          className='mt-3 flex h-11 w-full items-center justify-center rounded-xl border border-line bg-surface px-4 text-sm font-medium text-ink shadow-subtle transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none'
        >
          {t('auth.oauth.continueWith', { provider: 'Google' })}
        </button>
      ) : (
        <p
          role='status'
          data-testid='alcore-google-unavailable'
          className='mt-3 text-[13px] leading-6 text-ink-muted'
        >
          {t('auth.alcore.googleUnavailable')}
        </p>
      )}

      <p className='mt-3 text-[13px] leading-6 text-ink-muted'>
        {t('auth.alcore.noSessionHint')}
      </p>

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
