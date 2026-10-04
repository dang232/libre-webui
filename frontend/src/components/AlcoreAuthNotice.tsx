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
} from '@/utils/canonicalHandoff';
import { AUTH_BASE_URL } from '@/utils/config';
import { authApi } from '@/utils/api/authApi';
import { AlcoreDirectSignIn } from './AlcoreDirectSignIn';

// Re-exported from the leaf-backed handoff module so every existing importer
// keeps one path to the ONE state key, while the component itself no longer
// owns a declaration the state machine would have to import back (that cycle
// broke the production bundle — task-8-e2e evidence).
export { ALCORE_AUTH_STATE_KEY };

/**
 * Alcore-mode sign-in panel: one primary email+password form (inline,
 * always visible, browser-direct to Auth) plus Google-via-Auth.
 *
 * Deliberately spare: a heading, one short helper line, the inline
 * form, and the Google button. No architecture explanation lives here —
 * Local-mode login (LoginForm / SignupForm) is untouched and branches
 * on the same server-advertised `systemInfo.authMode` flag from
 * LoginPage, which also owns the create-account link and the quiet
 * link-existing-account entry below this panel.
 */
export const AlcoreAuthNotice: React.FC = () => {
  const { t } = useTranslation();
  const [error, setError] = React.useState<string | null>(null);
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

  const handleGoogleViaAuth = (): void => {
    try {
      const state = generateState();
      rememberHandoffState(state);
      const redirectUri = canonicalCallbackUrl(window.location.origin);
      window.location.assign(
        buildGoogleStartUrl(AUTH_BASE_URL, 'libre', redirectUri, state)
      );
    } catch {
      setError(t('auth.alcore.signin.failed'));
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

      <AlcoreDirectSignIn />

      {googleEnabled ? (
        <button
          type='button'
          data-testid='alcore-google-button'
          onClick={handleGoogleViaAuth}
          className='mt-6 flex h-11 w-full items-center justify-center rounded-xl border border-line bg-surface px-4 text-sm font-medium text-ink shadow-subtle transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 motion-reduce:transition-none'
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

      {error && (
        <p role='alert' className='mt-3 text-[13px] text-red-600'>
          {error}
        </p>
      )}
    </div>
  );
};
