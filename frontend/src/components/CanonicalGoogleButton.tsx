/*
 * Alcore
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import React, { useEffect, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { useAuthStore } from '@/store/authStore';
import { authApi } from '@/utils/api';
import { API_BASE_URL } from '@/utils/config';

type GoogleCredentialResponse = { credential?: string };
type GoogleIdentity = {
  accounts: {
    id: {
      initialize: (options: {
        client_id: string;
        callback: (response: GoogleCredentialResponse) => void;
      }) => void;
      renderButton: (
        element: HTMLElement,
        options: { theme: string; size: string; width: number }
      ) => void;
    };
  };
};

declare global {
  interface Window {
    google?: GoogleIdentity;
  }
}

export const CanonicalGoogleButton: React.FC<{ onSuccess?: () => void }> = ({
  onSuccess,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { login } = useAuthStore();
  const container = useRef<HTMLDivElement>(null);
  const [clientId, setClientId] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(`${API_BASE_URL}/auth/oauth/google/status`, { cache: 'no-store' })
      .then(response => (response.ok ? response.json() : null))
      .then((status: unknown) => {
        if (
          active &&
          typeof status === 'object' &&
          status !== null &&
          'configured' in status &&
          status.configured === true &&
          'clientId' in status &&
          typeof status.clientId === 'string' &&
          status.clientId.length > 0
        )
          setClientId(status.clientId);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!clientId || !container.current) return;
    const render = () => {
      if (!window.google || !container.current) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async response => {
          if (!response.credential) {
            toast.error(t('auth.oauth.googleFailed'));
            return;
          }
          setLoading(true);
          try {
            const result = await authApi.canonicalGoogle(response.credential);
            if (!result.success || !result.data) {
              toast.error(result.message || t('auth.oauth.googleFailed'));
              return;
            }
            login(result.data.user, result.data.token, result.data.systemInfo);
            toast.success(t('auth.login.loginSuccess'));
            onSuccess?.();
            navigate('/');
          } catch {
            toast.error(t('auth.oauth.googleFailed'));
          } finally {
            setLoading(false);
          }
        },
      });
      window.google.accounts.id.renderButton(container.current, {
        theme: 'outline',
        size: 'large',
        width: Math.min(container.current.clientWidth, 400),
      });
    };
    if (window.google) {
      render();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-google-identity]'
    );
    const script = existing ?? document.createElement('script');
    if (!existing) {
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.dataset.googleIdentity = 'true';
      document.head.append(script);
    }
    script.addEventListener('load', render);
    return () => script.removeEventListener('load', render);
  }, [clientId, login, navigate, onSuccess, t]);

  if (!clientId) return null;
  return (
    <div aria-busy={loading} className='mt-3'>
      {loading && (
        <p role='status' className='mb-2 text-center text-sm text-ink-muted'>
          {t('auth.oauth.googleLoading')}
        </p>
      )}
      <div
        ref={container}
        className={loading ? 'pointer-events-none opacity-60' : undefined}
      />
    </div>
  );
};
