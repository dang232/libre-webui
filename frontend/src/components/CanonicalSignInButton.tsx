/*
 * Alcore
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AUTH_BASE_URL } from '@/utils/config';
import { startAuthHandoff } from '@/utils/canonicalHandoff';

/**
 * Cutover switch for the Auth browser handoff.
 *
 * Defaults OFF: while it is off the legacy local password form is the only way
 * in, so enabling this cannot strand an account whose Libre user has no
 * `canonical_user_id` yet. Flip it only after the migration census shows the
 * population is mapped or deliberately flagged.
 */
export function isAuthBrowserHandoffEnabled(): boolean {
  return import.meta.env?.VITE_AUTH_BROWSER_HANDOFF === 'true';
}

export interface CanonicalSignInButtonProps {
  readonly onError?: (error: unknown) => void;
}

/**
 * Navigates to Auth. The password never reaches Libre or this component: the
 * browser is handed to Auth, which authenticates with its own HttpOnly cookie and
 * redirects back to /auth/callback with a one-time code.
 */
export const CanonicalSignInButton: React.FC<CanonicalSignInButtonProps> = ({
  onError,
}) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const begin = () => {
    if (busy) return;
    setBusy(true);
    try {
      const url = startAuthHandoff(AUTH_BASE_URL, window.location.origin);
      // Full navigation, not a router push: this leaves the Libre origin for
      // Auth, and the callback must arrive as a fresh document load.
      window.location.assign(url);
    } catch (error) {
      setBusy(false);
      onError?.(error);
    }
  };

  if (!isAuthBrowserHandoffEnabled()) return null;

  return (
    <button
      type='button'
      data-testid='canonical-signin-button'
      onClick={begin}
      disabled={busy}
      aria-busy={busy}
      className='mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm font-medium text-ink shadow-subtle transition-colors hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:cursor-not-allowed disabled:opacity-40'
    >
      {busy
        ? t('auth.canonical.redirecting', 'Redirecting…')
        : t('auth.canonical.signIn', 'Continue with ALcore')}
    </button>
  );
};

export default CanonicalSignInButton;
