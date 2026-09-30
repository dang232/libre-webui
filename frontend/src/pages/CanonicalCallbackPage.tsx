/*
 * Alcore
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { useAuthStore } from '@/store/authStore';
import { authApi } from '@/utils/api';
import {
  completeCanonicalCallback,
  type StateRejection,
} from '@/utils/canonicalHandoff';

type Phase = 'working' | 'failed';

/**
 * Landing route for the Auth browser handoff.
 *
 * Auth redirects here with `code` and `state` only. This page validates the CSRF
 * state against the value stored when the handoff began, redeems the code with
 * the Libre backend, and establishes a Libre session. Auth session credentials
 * never reach JavaScript: the browser only ever holds the one-time code.
 */
export const CanonicalCallbackPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { login } = useAuthStore();
  const [searchParams] = useSearchParams();
  const [phase, setPhase] = useState<Phase>('working');
  const [reason, setReason] = useState<
    StateRejection | 'exchange_failed' | null
  >(null);
  const started = useRef(false);

  useEffect(() => {
    // React 18 StrictMode double-invokes effects in development; the state has
    // already been consumed by then, so a second run must not redeem again.
    if (started.current) return;
    started.current = true;

    void (async () => {
      try {
        const outcome = await completeCanonicalCallback(
          {
            code: searchParams.get('code'),
            state: searchParams.get('state'),
            origin: window.location.origin,
          },
          (c, redirectUri, s) => authApi.canonicalExchange(c, redirectUri, s)
        );
        if (!outcome.ok) {
          setReason(outcome.reason);
          setPhase('failed');
          return;
        }
        const data = outcome.data.data;
        if (!data) {
          setReason('exchange_failed');
          setPhase('failed');
          return;
        }
        login(data.user, data.token, data.systemInfo);
        // Replace the URL so the spent code cannot be reloaded or bookmarked.
        navigate('/', { replace: true });
      } catch {
        setReason('exchange_failed');
        setPhase('failed');
      }
    })();
  }, [searchParams, login, navigate]);

  if (phase === 'failed') {
    return (
      <div className='mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4'>
        <div className='rounded-3xl border border-line bg-surface-raised p-6 shadow-card sm:p-8'>
          <h1 className='mb-2 text-2xl font-light tracking-[-0.04em] text-ink'>
            {t('auth.callback.failedTitle', 'Sign-in could not be completed')}
          </h1>
          <p className='mb-6 text-sm leading-6 text-ink-muted'>
            {reason === 'state_expired'
              ? t(
                  'auth.callback.expired',
                  'This sign-in link expired. Please try again.'
                )
              : t(
                  'auth.callback.invalid',
                  'This sign-in link is no longer valid. Please start again.'
                )}
          </p>
          <button
            type='button'
            onClick={() => navigate('/login', { replace: true })}
            className='flex h-11 w-full items-center justify-center rounded-xl border border-transparent bg-ink px-4 text-sm font-medium text-ink-inverse shadow-subtle transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas'
          >
            {t('auth.callback.backToLogin', 'Back to sign in')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className='mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4'>
      <div className='rounded-3xl border border-line bg-surface-raised p-6 shadow-card sm:p-8'>
        <h1 className='mb-2 text-2xl font-light tracking-[-0.04em] text-ink'>
          {t('auth.callback.working', 'Signing you in…')}
        </h1>
        <p role='status' className='text-sm leading-6 text-ink-muted'>
          {t('auth.callback.workingHint', 'Please wait while we finish.')}
        </p>
      </div>
    </div>
  );
};

export default CanonicalCallbackPage;
