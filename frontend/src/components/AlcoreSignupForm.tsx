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
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { CircleAlert, Eye, EyeOff, UserPlus } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import {
  alcoreDirectPassword,
  alcoreDirectProductCode,
  authApi,
} from '@/utils/api/authApi';
import { AUTH_BASE_URL } from '@/utils/config';
import { startAuthHandoff } from '@/utils/canonicalHandoff';
import {
  runAlcoreSignup,
  type AlcoreSignupValidationCode,
} from '@/utils/alcoreSignup';
import { PasswordStrengthMeter } from '@/components/PasswordStrengthMeter';
import type { SystemInfo, User } from '@/types';

/**
 * Public self-service signup (Auth-driven, open registration).
 *
 * The credential is registered at Auth and the fresh Auth session is
 * exchanged at the Libre BFF, which lazy-provisions the Libre profile —
 * the same email/password signs in on both products. No Libre-local
 * password is ever created: passwords travel browser→Auth only, exactly
 * like the Alcore sign-in panel. Duplicate emails surface Auth's safe
 * message without revealing whether an address is registered.
 */
export const AlcoreSignupForm: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const login = useAuthStore(state => state.login);
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const validationMessage = (
    code: AlcoreSignupValidationCode,
    detail?: string
  ): string => {
    switch (code) {
      case 'emailInvalid':
        return t('auth.alcore.signup.invalidEmail');
      case 'passwordMismatch':
        return t('auth.alcore.signup.mismatch');
      case 'passwordPolicy':
        return detail ? t(detail) : t('auth.alcore.signup.invalidEmail');
    }
  };

  const submitSignup = async (
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await runAlcoreSignup(
        { email, password, confirmPassword },
        {
          registerDirect: (nextEmail, nextPassword) =>
            alcoreDirectPassword('register', nextEmail, nextPassword),
          fetchProductCode: nextToken => alcoreDirectProductCode(nextToken),
          exchangeCode: async code => {
            const response = await authApi.alcoreExchange({ code });
            if (!response.success || !response.data) {
              throw new Error(t('auth.alcore.signup.failed'));
            }
            return response.data;
          },
          startRedirectHandoff: () => {
            window.location.assign(
              startAuthHandoff(AUTH_BASE_URL, window.location.origin)
            );
          },
        }
      );
      if (!outcome.ok) {
        setError(
          outcome.code === 'register'
            ? outcome.message
            : validationMessage(outcome.code, outcome.detail)
        );
        return;
      }
      if ('redirected' in outcome) {
        toast.success(t('auth.alcore.redirecting'));
        return;
      }
      login(
        outcome.session.user as User,
        outcome.session.token,
        outcome.session.systemInfo as SystemInfo
      );
      toast.success(t('auth.alcore.signup.success'));
      navigate('/', { replace: true });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t('auth.alcore.signup.failed')
      );
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    'h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink shadow-subtle outline-none transition-[border-color,box-shadow,background-color] placeholder:text-ink-muted focus:border-line-strong focus:ring-2 focus:ring-primary-500/35 disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-ink-muted motion-reduce:transition-none';

  return (
    <div className='mx-auto w-full max-w-md' data-testid='alcore-signup-form'>
      <div className='mb-8 text-start'>
        <h1 className='mb-2 text-3xl font-light tracking-[-0.04em] text-ink'>
          {t('auth.alcore.signup.title')}
        </h1>
        <p className='text-sm leading-6 text-ink-muted'>
          {t('auth.alcore.signup.subtitle')}
        </p>
      </div>

      <form onSubmit={submitSignup} className='space-y-5' noValidate>
        <div>
          <label
            htmlFor='alcore-signup-email'
            className='mb-2 block text-sm font-medium text-ink'
          >
            {t('auth.alcore.email')}
          </label>
          <input
            id='alcore-signup-email'
            type='email'
            required
            autoComplete='email'
            value={email}
            onChange={event => setEmail(event.target.value)}
            placeholder={t('auth.alcore.signup.emailPlaceholder')}
            className={inputClass}
            disabled={busy}
          />
        </div>

        <div>
          <label
            htmlFor='alcore-signup-password'
            className='mb-2 block text-sm font-medium text-ink'
          >
            {t('auth.alcore.password')}
          </label>
          <div className='relative'>
            <input
              id='alcore-signup-password'
              type={showPassword ? 'text' : 'password'}
              required
              autoComplete='new-password'
              value={password}
              onChange={event => setPassword(event.target.value)}
              placeholder={t('auth.alcore.signup.passwordPlaceholder')}
              className={`${inputClass} pe-11`}
              disabled={busy}
            />
            <button
              type='button'
              onClick={() => setShowPassword(value => !value)}
              className='absolute inset-y-0 end-0 flex items-center pe-3 text-ink-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-50'
              disabled={busy}
              aria-label={
                showPassword ? 'Hide characters' : 'Reveal characters'
              }
            >
              {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
            </button>
          </div>
          <PasswordStrengthMeter password={password} />
        </div>

        <div>
          <label
            htmlFor='alcore-signup-confirm'
            className='mb-2 block text-sm font-medium text-ink'
          >
            {t('auth.alcore.signup.confirmPassword')}
          </label>
          <div className='relative'>
            <input
              id='alcore-signup-confirm'
              type={showConfirmPassword ? 'text' : 'password'}
              required
              autoComplete='new-password'
              value={confirmPassword}
              onChange={event => setConfirmPassword(event.target.value)}
              placeholder={t('auth.alcore.signup.confirmPlaceholder')}
              className={`${inputClass} pe-11`}
              disabled={busy}
            />
            <button
              type='button'
              onClick={() => setShowConfirmPassword(value => !value)}
              className='absolute inset-y-0 end-0 flex items-center pe-3 text-ink-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-50'
              disabled={busy}
              aria-label={
                showConfirmPassword
                  ? 'Hide confirmation'
                  : 'Reveal confirmation'
              }
            >
              {showConfirmPassword ? <EyeOff size={20} /> : <Eye size={20} />}
            </button>
          </div>
        </div>

        {error && (
          <p
            role='alert'
            className='flex items-start gap-2 text-[13px] leading-5 text-red-600 dark:text-red-400'
          >
            <CircleAlert
              aria-hidden='true'
              className='mt-0.5 h-4 w-4 shrink-0'
            />
            <span>{error}</span>
          </p>
        )}

        <button
          type='submit'
          disabled={busy}
          className='flex h-11 w-full items-center justify-center rounded-xl border border-transparent bg-ink px-4 text-sm font-medium text-ink-inverse shadow-subtle transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none'
        >
          {busy ? (
            <span className='flex items-center'>
              <span className='me-2 h-4 w-4 animate-spin rounded-full border-b-2 border-current' />
              {t('auth.alcore.signup.submitting')}
            </span>
          ) : (
            <span className='flex items-center'>
              <UserPlus size={16} className='me-2' />
              {t('auth.alcore.signUp')}
            </span>
          )}
        </button>
      </form>

      <p className='mt-6 text-center text-sm text-ink-muted'>
        <Link
          to='/login'
          className='font-medium text-ink transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500'
        >
          {t('auth.alcore.haveAccount')}
        </Link>
      </p>
    </div>
  );
};
