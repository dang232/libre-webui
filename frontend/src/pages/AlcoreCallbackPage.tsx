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
import { useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import { authApi } from '@/utils/api/authApi';
import { ALCORE_AUTH_STATE_KEY } from '@/components/AlcoreAuthNotice';

/**
 * Auth redirect-handoff callback (todo 45).
 *
 * Auth 302s here with an opaque ?code=&state=. The state must match the tab
 * binding stored before the redirect (CSRF); the code is redeemed once at
 * the BFF and the URL is cleaned immediately so the code never lingers in
 * history. Auth error responses (?error=) fail closed with a retry link.
 */
export const AlcoreCallbackPage: React.FC = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const login = useAuthStore(state => state.login);
  const [error, setError] = React.useState<string | null>(null);
  const done = React.useRef(false);

  React.useEffect(() => {
    if (done.current) return;
    done.current = true;
    const params = new URLSearchParams(location.search);
    const finish = async (): Promise<void> => {
      const authError = params.get('error');
      if (authError) {
        setError('Sign-in failed. Please try again.');
        return;
      }
      const code = params.get('code') ?? '';
      const state = params.get('state') ?? '';
      let expected: string | null = null;
      try {
        expected = sessionStorage.getItem(ALCORE_AUTH_STATE_KEY);
        sessionStorage.removeItem(ALCORE_AUTH_STATE_KEY);
      } catch {
        expected = null;
      }
      if (!code || !state || expected === null || state !== expected) {
        setError('Sign-in failed. Please try again.');
        return;
      }
      try {
        const response = await authApi.alcoreExchange({
          code,
          redirectUri: `${window.location.origin}/auth/alcore/callback`,
          state,
        });
        if (!response.success || !response.data) {
          throw new Error('exchange failed');
        }
        login(
          response.data.user,
          response.data.token,
          response.data.systemInfo
        );
        navigate('/', { replace: true });
      } catch {
        setError('Sign-in failed. Please try again.');
      }
    };
    void finish().finally(() => {
      window.history.replaceState({}, document.title, location.pathname);
    });
  }, [location.pathname, location.search, login, navigate, t]);

  return (
    <div className='flex min-h-screen items-center justify-center bg-canvas px-5 text-ink'>
      <div className='w-full max-w-sm rounded-2xl border border-line bg-surface p-6 text-center'>
        {error ? (
          <>
            <p role='alert' className='text-sm text-red-600'>
              {error}
            </p>
            <button
              type='button'
              onClick={() => navigate('/login', { replace: true })}
              className='mt-4 w-full rounded-xl bg-ink px-4 py-2.5 text-sm font-medium text-canvas'
            >
              {t('auth.alcore.backToLogin')}
            </button>
          </>
        ) : (
          <p className='text-sm text-ink-muted'>{t('auth.login.signingIn')}</p>
        )}
      </div>
    </div>
  );
};

export default AlcoreCallbackPage;
