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

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { authApi } from '@/utils/api';
import { Clock3, Eye, EyeOff, MailCheck, UserPlus } from 'lucide-react';
import { GitHubAuthButton } from '@/components/GitHubAuthButton';
import { TurnstileWidget } from '@/components/TurnstileWidget';
import { AlcoreAuthNotice } from '@/components/AlcoreAuthNotice';
import { cn } from '@/utils';
import { createLogger } from '@/utils/logger';
import { getPasswordPolicyError } from '@/utils/passwordPolicy';
import { PasswordStrengthMeter } from '@/components/PasswordStrengthMeter';

const logger = createLogger('components:signup-form');

/** Length of the emailed signup verification code. */
const OTP_CODE_LENGTH = 6;
/** Resend cooldown when the signup response carries no explicit delay. */
const OTP_RESEND_FALLBACK_SECONDS = 30;

type SignupApiResponse = Awaited<ReturnType<typeof authApi.signup>>;

interface SignupFormProps {
  onSignup?: () => void;
  onBackToLogin?: () => void;
  /** Drops the card chrome so a page can supply its own framing. */
  bare?: boolean;
  alcoreMode?: boolean;
}

export const SignupForm: React.FC<SignupFormProps> = ({
  onSignup,
  onBackToLogin,
  bare = false,
  alcoreMode = false,
}) => {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [approvalPending, setApprovalPending] = useState(false);
  const [otpEmail, setOtpEmail] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpCooldown, setOtpCooldown] = useState(0);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  const navigate = useNavigate();
  const { login, systemInfo } = useAuthStore();
  const turnstileSiteKey = systemInfo?.turnstile?.siteKey;
  const isTurnstileEnabled = Boolean(
    systemInfo?.turnstile?.enabled && turnstileSiteKey
  );
  const handleTurnstileTokenChange = useCallback((token: string) => {
    setTurnstileToken(token);
  }, []);
  const submitDisabled = useMemo(
    () => isLoading || (isTurnstileEnabled && !turnstileToken),
    [isLoading, isTurnstileEnabled, turnstileToken]
  );

  const completeLoginPair = useCallback(
    (data: {
      user: Parameters<typeof login>[0];
      token: string;
      systemInfo: Parameters<typeof login>[2];
    }) => {
      login(data.user, data.token, data.systemInfo);
      toast.success(t('auth.signup.signupSuccess'));
      onSignup?.();
      navigate('/');
    },
    [login, navigate, onSignup, t]
  );

  const applySignupResponse = useCallback(
    (response: SignupApiResponse, announcedEmail: string) => {
      if (response.success && response.data) {
        if (!('token' in response.data)) {
          if (
            'otpRequired' in response.data &&
            response.data.otpRequired === true
          ) {
            const pendingEmail = response.data.email || announcedEmail;
            setOtpEmail(pendingEmail);
            setOtpCode('');
            setOtpError(null);
            setOtpCooldown(
              response.data.expiresInSeconds ?? OTP_RESEND_FALLBACK_SECONDS
            );
            toast.success(
              t(
                'auth.signup.otpSent',
                'Verification code sent. Check your email.'
              )
            );
            return;
          }
          setApprovalPending(true);
          toast.success(
            t(
              'auth.signup.approvalPending',
              'Registration received. An administrator must approve your account.'
            )
          );
          return;
        }
        completeLoginPair(response.data);
      } else {
        toast.error(response.message || t('auth.signup.signupFailed'));
      }
    },
    [completeLoginPair, t]
  );

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (!username.trim() || !password.trim()) {
      toast.error(t('auth.signup.usernameRequired'));
      return;
    }

    if (password !== confirmPassword) {
      toast.error(t('auth.signup.passwordMismatch'));
      return;
    }

    const passwordError = getPasswordPolicyError(password);
    if (passwordError) {
      toast.error(passwordError);
      return;
    }

    if (isTurnstileEnabled && !turnstileToken) {
      toast.error(t('auth.signup.tryAgain'));
      return;
    }

    setIsLoading(true);

    try {
      const response = await authApi.signup({
        username,
        password,
        email,
        turnstileToken,
      });

      applySignupResponse(response, email);
    } catch (error) {
      logger.error('Signup error:', error);
      toast.error(t('auth.signup.tryAgain'));
    } finally {
      setTurnstileToken('');
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (otpEmail === null || otpCooldown <= 0) return;
    const timer = window.setTimeout(() => {
      setOtpCooldown(current => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [otpEmail, otpCooldown]);

  const otpErrorText = useCallback(
    (message: string) => {
      if (/expir/i.test(message)) {
        return t(
          'auth.signup.otpExpiredCode',
          'That code has expired. Request a new one below.'
        );
      }
      if (
        !message ||
        /invalid|incorrect|wrong|mismatch|not valid|not found/i.test(message)
      ) {
        return t(
          'auth.signup.otpInvalidCode',
          'That code is not valid. Check and try again.'
        );
      }
      return message;
    },
    [t]
  );

  const handleVerifyOtp = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (otpEmail === null || otpCode.trim().length !== OTP_CODE_LENGTH) return;

    setIsVerifying(true);
    setOtpError(null);

    try {
      const response = await authApi.verifyOtp({
        email: otpEmail,
        code: otpCode.trim(),
      });

      if (response.success && response.data) {
        completeLoginPair(response.data);
      } else {
        const message = response.message || response.error || '';
        if (/expir/i.test(message)) setOtpCooldown(0);
        setOtpError(otpErrorText(message));
      }
    } catch (error) {
      logger.error('OTP verification error:', error);
      const data = (
        error as {
          response?: { data?: { message?: string; error?: string } };
        }
      ).response?.data;
      const message = data?.message || data?.error || '';
      if (/expir/i.test(message)) {
        // The emailed code lapsed: let the visitor request a fresh one now.
        setOtpCooldown(0);
      }
      setOtpError(otpErrorText(message));
      setOtpCode('');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleResendOtp = async () => {
    if (otpEmail === null || otpCooldown > 0 || isResending) return;

    if (isTurnstileEnabled && !turnstileToken) {
      toast.error(t('auth.signup.tryAgain'));
      return;
    }

    setIsResending(true);

    try {
      const response = await authApi.signup({
        username,
        password,
        email,
        turnstileToken,
      });

      if (
        response.success &&
        response.data &&
        !('token' in response.data) &&
        'otpRequired' in response.data &&
        response.data.otpRequired === true
      ) {
        setOtpCode('');
        setOtpError(null);
        setOtpCooldown(
          response.data.expiresInSeconds ?? OTP_RESEND_FALLBACK_SECONDS
        );
        toast.success(
          t('auth.signup.otpResent', 'A new verification code is on its way.')
        );
        return;
      }
      applySignupResponse(response, email);
    } catch (error) {
      logger.error('OTP resend error:', error);
      toast.error(t('auth.signup.tryAgain'));
    } finally {
      setTurnstileToken('');
      setIsResending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const form = e.currentTarget.form;
      if (form) {
        form.requestSubmit();
      }
    }
  };

  if (alcoreMode) return <AlcoreAuthNotice />;

  if (approvalPending) {
    return (
      <div
        data-testid='signup-approval-pending'
        className={cn(
          'mx-auto w-full max-w-md text-center',
          !bare &&
            'rounded-3xl border border-line bg-surface-raised p-6 shadow-card sm:p-8'
        )}
      >
        <div className='mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-warning-500/15 text-warning-700 dark:text-warning-400'>
          <Clock3 aria-hidden='true' className='h-6 w-6' />
        </div>
        <h1 className='mt-5 text-3xl font-light tracking-[-0.04em] text-ink'>
          {t('auth.signup.awaitingApproval', 'Awaiting approval')}
        </h1>
        <p className='mt-3 text-sm leading-6 text-ink-muted'>
          {t(
            'auth.signup.awaitingApprovalDescription',
            'Your account has been created, but an administrator must activate it before you can sign in.'
          )}
        </p>
        <button
          type='button'
          onClick={onBackToLogin}
          className='mt-6 inline-flex h-11 w-full items-center justify-center rounded-xl border border-line bg-surface px-4 text-sm font-medium text-ink shadow-subtle transition-colors hover:bg-surface-raised'
        >
          {t('auth.signup.backToSignIn', 'Back to sign in')}
        </button>
      </div>
    );
  }

  if (otpEmail !== null) {
    const canResend = otpCooldown <= 0 && !isResending && !isVerifying;
    return (
      <div
        data-testid='signup-otp-step'
        className={cn(
          'mx-auto w-full max-w-md',
          !bare &&
            'rounded-3xl border border-line bg-surface-raised p-6 shadow-card sm:p-8'
        )}
      >
        <div className={cn('mb-6', bare ? 'text-start' : 'text-center')}>
          <div
            className={cn(
              'mb-3 flex',
              bare ? 'justify-start' : 'justify-center'
            )}
          >
            <div className='flex h-12 w-12 items-center justify-center rounded-full bg-primary-500/15 text-primary-700 dark:text-primary-400'>
              <MailCheck aria-hidden='true' className='h-6 w-6' />
            </div>
          </div>
          <h1 className='mb-2 text-2xl font-light tracking-[-0.04em] text-ink'>
            {t('auth.signup.otpTitle', 'Check your email')}
          </h1>
          <p className='text-sm leading-6 text-ink-muted'>
            {otpEmail
              ? t(
                  'auth.signup.otpSubtitle',
                  'We sent a 6-digit code to {{email}}.',
                  {
                    email: otpEmail,
                  }
                )
              : t(
                  'auth.signup.otpSubtitleNoEmail',
                  'We sent a 6-digit code to your email address.'
                )}
          </p>
        </div>
        <form onSubmit={handleVerifyOtp} className='space-y-4'>
          <div>
            <label
              htmlFor='signup-otp-code'
              className='mb-2 block text-sm font-medium text-ink'
            >
              {t('auth.signup.otpCodeLabel', '6-digit code')}
            </label>
            <input
              id='signup-otp-code'
              data-testid='signup-otp-input'
              type='text'
              inputMode='numeric'
              autoComplete='one-time-code'
              autoFocus
              dir='ltr'
              maxLength={OTP_CODE_LENGTH}
              value={otpCode}
              onChange={e => {
                setOtpCode(
                  e.target.value.replace(/\D/g, '').slice(0, OTP_CODE_LENGTH)
                );
                if (otpError) setOtpError(null);
              }}
              className='h-11 w-full rounded-xl border border-line bg-surface px-3 text-center font-mono text-lg text-ink shadow-subtle outline-none transition-[border-color,box-shadow,background-color] placeholder:text-ink-muted focus:border-line-strong focus:ring-2 focus:ring-primary-500/35 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
              placeholder={t('auth.signup.otpCodePlaceholder', '123456')}
              required
              disabled={isVerifying}
            />
            {otpError && (
              <p
                role='alert'
                data-testid='signup-otp-error'
                className='mt-2 text-sm leading-5 text-error-600 dark:text-error-400'
              >
                {otpError}
              </p>
            )}
          </div>
          <button
            type='submit'
            disabled={isVerifying || otpCode.trim().length !== OTP_CODE_LENGTH}
            className='flex h-11 w-full items-center justify-center rounded-xl border border-transparent bg-ink px-4 text-sm font-medium text-ink-inverse shadow-subtle transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none'
          >
            {isVerifying ? (
              <div className='flex items-center'>
                <div className='me-2 h-4 w-4 animate-spin rounded-full border-b-2 border-current'></div>
                {t('auth.signup.otpVerifying', 'Verifying...')}
              </div>
            ) : (
              t('auth.signup.otpVerify', 'Verify code')
            )}
          </button>
        </form>
        <div className='mt-5 text-center text-sm text-ink-muted'>
          {otpCooldown > 0 ? (
            <span data-testid='signup-otp-cooldown'>
              {t(
                'auth.signup.otpResendCooldown',
                'Resend code in {{seconds}}s',
                { seconds: otpCooldown }
              )}
            </span>
          ) : (
            <button
              type='button'
              data-testid='signup-otp-resend'
              onClick={handleResendOtp}
              disabled={!canResend}
              className='font-medium text-primary-600 transition-colors hover:text-primary-700 disabled:cursor-not-allowed disabled:opacity-50 dark:text-primary-400 dark:hover:text-primary-300'
            >
              {isResending
                ? t('auth.signup.otpResending', 'Sending new code...')
                : t('auth.signup.otpResend', 'Resend code')}
            </button>
          )}
        </div>
        <div className='mt-2 text-center'>
          <button
            type='button'
            onClick={() => {
              setOtpEmail(null);
              setOtpCode('');
              setOtpError(null);
            }}
            className='text-sm font-medium text-ink-muted transition-colors hover:text-ink'
          >
            {t('auth.signup.otpBackToSignup', 'Back to sign up')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'mx-auto w-full max-w-md',
        !bare &&
          'rounded-3xl border border-line bg-surface-raised p-6 shadow-card sm:p-8'
      )}
    >
      <div className={cn('mb-8', bare ? 'text-start' : 'text-center')}>
        <h1 className='mb-2 text-3xl font-light tracking-[-0.04em] text-ink'>
          {t('auth.signup.title')}
        </h1>
        <p className='text-sm leading-6 text-ink-muted'>
          {t('auth.signup.subtitle')}
        </p>
      </div>

      <form onSubmit={handleSubmit} className='space-y-4'>
        <div>
          <label
            htmlFor='username'
            className='mb-2 block text-sm font-medium text-ink'
          >
            {t('auth.signup.username')}
          </label>
          <input
            id='username'
            type='text'
            value={username}
            onChange={e => setUsername(e.target.value)}
            onKeyDown={handleKeyDown}
            className='h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink shadow-subtle outline-none transition-[border-color,box-shadow,background-color] placeholder:text-ink-muted focus:border-line-strong focus:ring-2 focus:ring-primary-500/35 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
            placeholder={t('auth.signup.usernamePlaceholder')}
            required
            disabled={isLoading}
          />
        </div>

        <div>
          <label
            htmlFor='email'
            className='mb-2 block text-sm font-medium text-ink'
          >
            {t('auth.signup.email')}{' '}
            <span className='text-ink-muted'>({t('common.optional')})</span>
          </label>
          <input
            id='email'
            type='email'
            value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={handleKeyDown}
            className='h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink shadow-subtle outline-none transition-[border-color,box-shadow,background-color] placeholder:text-ink-muted focus:border-line-strong focus:ring-2 focus:ring-primary-500/35 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
            placeholder={t('auth.signup.emailPlaceholder')}
            disabled={isLoading}
          />
        </div>

        <div>
          <label
            htmlFor='password'
            className='mb-2 block text-sm font-medium text-ink'
          >
            {t('auth.signup.password')}
          </label>
          <div className='relative'>
            <input
              id='password'
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              className='h-11 w-full rounded-xl border border-line bg-surface px-3 pe-11 text-sm text-ink shadow-subtle outline-none transition-[border-color,box-shadow,background-color] placeholder:text-ink-muted focus:border-line-strong focus:ring-2 focus:ring-primary-500/35 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
              placeholder={t('auth.signup.passwordPlaceholder')}
              required
              disabled={isLoading}
            />
            <button
              type='button'
              onClick={() => setShowPassword(!showPassword)}
              className='absolute inset-y-0 end-0 flex items-center pe-3 text-ink-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-50'
              disabled={isLoading}
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
            htmlFor='confirmPassword'
            className='mb-2 block text-sm font-medium text-ink'
          >
            {t('auth.signup.confirmPassword')}
          </label>
          <div className='relative'>
            <input
              id='confirmPassword'
              type={showConfirmPassword ? 'text' : 'password'}
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              className='h-11 w-full rounded-xl border border-line bg-surface px-3 pe-11 text-sm text-ink shadow-subtle outline-none transition-[border-color,box-shadow,background-color] placeholder:text-ink-muted focus:border-line-strong focus:ring-2 focus:ring-primary-500/35 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
              placeholder={t('auth.signup.confirmPasswordPlaceholder')}
              required
              disabled={isLoading}
            />
            <button
              type='button'
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              className='absolute inset-y-0 end-0 flex items-center pe-3 text-ink-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-50'
              disabled={isLoading}
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

        {isTurnstileEnabled && turnstileSiteKey && (
          <TurnstileWidget
            siteKey={turnstileSiteKey}
            action='signup'
            disabled={isLoading}
            errorMessage={t('auth.signup.tryAgain')}
            onTokenChange={handleTurnstileTokenChange}
          />
        )}

        <button
          type='submit'
          disabled={submitDisabled}
          className='flex h-11 w-full items-center justify-center rounded-xl border border-transparent bg-ink px-4 text-sm font-medium text-ink-inverse shadow-subtle transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none'
        >
          {isLoading ? (
            <div className='flex items-center'>
              <div className='me-2 h-4 w-4 animate-spin rounded-full border-b-2 border-current'></div>
              {t('auth.signup.creatingAccount')}
            </div>
          ) : (
            <div className='flex items-center'>
              <UserPlus size={16} className='me-2' />
              {t('auth.signup.createAccount')}
            </div>
          )}
        </button>
      </form>

      {/* GitHub OAuth Button */}
      <GitHubAuthButton />

      <div className='mt-6 text-center'>
        <p className='text-sm text-ink-muted'>
          {t('auth.signup.hasAccount')}{' '}
          <button
            onClick={onBackToLogin}
            className='font-medium text-primary-600 transition-colors hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300'
          >
            {t('auth.signup.signInHere')}
          </button>
        </p>
      </div>
    </div>
  );
};
