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
import {
  completeCanonicalCallback,
  consumeHandoffState,
  startAuthHandoff,
} from '@/utils/canonicalHandoff';
import { AUTH_BASE_URL } from '@/utils/config';

/**
 * Auth redirect-handoff callback (todo 45).
 *
 * Auth 302s here with an opaque ?code=&state=. The state must match the tab
 * binding stored before the redirect (CSRF); the code is redeemed once at
 * the BFF and the URL is cleaned immediately so the code never lingers in
 * history. Auth error returns (?error=, e.g. invalid_request when Auth-side
 * OIDC config rejects the handoff) fail closed: the page parses the error
 * below (mirroring the portal's parseAuthErrorSearch/authErrorGuidance
 * pattern) and renders recovery copy with a back-to-login button instead
 * of stranding the user.
 */
export interface CallbackAuthError {
  readonly error: string;
  readonly errorDescription: string | null;
}

/**
 * Parse an Auth OAuth error return (`?error=...`). Null when no error is
 * present so the normal code/state path runs. Mirrors the portal's
 * `parseAuthErrorSearch` (AlRepo/apps/portal/src/api/authExchange.ts).
 * NOTE: user-visible strings in this file stay inline literals — the
 * locale files are owned by a sibling copy-scrub lane right now.
 */
export function parseCallbackAuthError(
  search: string
): CallbackAuthError | null {
  const query = search.startsWith('?') ? search.slice(1) : search;
  const params = new URLSearchParams(query);
  const error = (params.get('error') ?? '').trim();
  if (error === '') return null;
  const description = (params.get('error_description') ?? '').trim();
  return { error, errorDescription: description === '' ? null : description };
}

/**
 * Recovery copy for an Auth error return. Every branch points back at
 * /login: Google availability depends on Auth-side config this page cannot
 * see, so it never promises a Google retry that may not exist.
 * `invalid_request` is covered explicitly as operator misconfiguration
 * (redirect/audience mismatch on the Auth service).
 */
export function callbackAuthErrorGuidance(error: string): string {
  switch (error) {
    case 'invalid_request':
      return (
        'Google sign-in was rejected by the Auth server (sign-in request ' +
        'invalid — operator-side redirect or audience misconfiguration). ' +
        'Go back to login and sign in another way, or contact your ' +
        'administrator.'
      );
    case 'access_denied':
      return 'You cancelled Google sign-in. Go back to login and try again.';
    default:
      return (
        `The Auth server refused the request (${error}). ` +
        'Go back to login and try again.'
      );
  }
}
export const AlcoreCallbackPage: React.FC = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const login = useAuthStore(state => state.login);
  const [failureReason, setFailureReason] = React.useState<string | null>(null);
  const done = React.useRef(false);

  // R9: an expired, consumed, or absent handoff binding is restartable in
  // place — no manual URL surgery. Anything else restarts from login.
  const handleTryAgain = (): void => {
    window.location.assign(
      startAuthHandoff(AUTH_BASE_URL, window.location.origin)
    );
  };

  React.useEffect(() => {
    if (done.current) return;
    done.current = true;
    const params = new URLSearchParams(location.search);
    const finish = async (): Promise<void> => {
      const authError = parseCallbackAuthError(location.search);
      if (authError) {
        // Keep the Auth error code in the reason (portal parity) so the
        // page can render the matching recovery copy below.
        setFailureReason(`auth_error:${authError.error}`);
        return;
      }
      try {
        const code = params.get('code');
        const state = params.get('state');
        const outcome = await completeCanonicalCallback(
          {
            code,
            state,
            origin: window.location.origin,
            consumeState: consumeHandoffState,
          },
          async (c, redirectUri, s) =>
            authApi.alcoreExchange({ code: c, redirectUri, state: s }),
          // R7: one automatic re-redemption inside the handoff TTL; the
          // server answer stays one generic message either way.
          { retryExchangeOnce: true }
        );
        if (!outcome.ok) {
          setFailureReason(outcome.reason);
          return;
        }
        const response = outcome.data;
        if (!response.success || !response.data) {
          setFailureReason('exchange_failed');
          return;
        }
        login(
          response.data.user,
          response.data.token,
          response.data.systemInfo
        );
        navigate('/', { replace: true });
      } catch {
        setFailureReason('exchange_failed');
      }
    };
    void finish().finally(() => {
      // Scrub the code only while this page still owns the address bar:
      // after a successful navigate('/') the router already replaced the
      // entry, and a replaceState back to the callback path would stomp
      // the final URL (the browser proof caught exactly that race).
      if (window.location.pathname === location.pathname) {
        window.history.replaceState({}, document.title, location.pathname);
      }
    });
  }, [location.pathname, location.search, login, navigate, t]);

  return (
    <div className='flex min-h-screen items-center justify-center bg-canvas px-5 text-ink'>
      <div className='w-full max-w-sm rounded-2xl border border-line bg-surface p-6 text-center'>
        {failureReason ? (
          <>
            <p role='alert' className='text-sm text-red-600'>
              {failureReason === 'state_expired' ||
              failureReason === 'missing_code' ||
              failureReason === 'missing_state'
                ? t('auth.callback.expiredHelp')
                : t('auth.callback.failedHelp')}
            </p>
            {failureReason.startsWith('auth_error:') ? (
              <p
                data-testid='callback-auth-error-guidance'
                className='mt-2 text-[13px] leading-6 text-ink-muted'
              >
                {callbackAuthErrorGuidance(
                  failureReason.slice('auth_error:'.length)
                )}
              </p>
            ) : null}
            <p
              data-testid='callback-failure-reason'
              className='mt-2 font-mono text-[11px] text-ink-muted'
            >
              {t('auth.callback.reason', { reason: failureReason })}
            </p>
            {failureReason === 'state_expired' ||
            failureReason === 'missing_code' ||
            failureReason === 'missing_state' ? (
              <button
                type='button'
                onClick={handleTryAgain}
                className='mt-4 w-full rounded-xl bg-ink px-4 py-2.5 text-sm font-medium text-canvas'
              >
                {t('auth.callback.tryAgain')}
              </button>
            ) : (
              <button
                type='button'
                onClick={() => navigate('/login', { replace: true })}
                className='mt-4 w-full rounded-xl bg-ink px-4 py-2.5 text-sm font-medium text-canvas'
              >
                {t('auth.callback.restart')}
              </button>
            )}
            <p className='mt-3 text-[13px] leading-6 text-ink-muted'>
              {t('auth.callback.support')}{' '}
              <a
                href='https://docs.librewebui.org'
                target='_blank'
                rel='noopener noreferrer'
                className='underline'
              >
                docs.librewebui.org
              </a>
            </p>
          </>
        ) : (
          <p className='text-sm text-ink-muted'>{t('auth.login.signingIn')}</p>
        )}
      </div>
    </div>
  );
};

export default AlcoreCallbackPage;
