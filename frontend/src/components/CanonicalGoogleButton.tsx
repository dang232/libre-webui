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
        auto_select?: boolean;
      }) => void;
      renderButton: (
        element: HTMLElement,
        options: { theme: string; size: string; width: number }
      ) => void;
      cancel: () => void;
    };
  };
};

declare global {
  interface Window {
    google?: GoogleIdentity;
  }
}

const GSI_SRC = 'https://accounts.google.com/gsi/client';
const gsiLoadPromises = new Map<string, Promise<void>>();

function getOrCreateGsiScript(src: string): HTMLScriptElement {
  const existing = document.querySelector<HTMLScriptElement>(
    'script[data-google-identity]'
  );
  if (existing) return existing;
  const script = document.createElement('script');
  script.src = src;
  script.async = true;
  script.defer = true;
  script.dataset.googleIdentity = 'true';
  document.head.append(script);
  return script;
}

function loadGsiScript(src: string): Promise<void> {
  const cached = gsiLoadPromises.get(src);
  if (cached) return cached;
  const promise = new Promise<void>((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve();
      return;
    }
    const script = getOrCreateGsiScript(src);
    const onLoad = () => {
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
      resolve();
    };
    const onError = () => {
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
      gsiLoadPromises.delete(src);
      reject(new Error(`Failed to load ${src}`));
    };
    script.addEventListener('load', onLoad);
    script.addEventListener('error', onError);
  });
  gsiLoadPromises.set(src, promise);
  return promise;
}

export const CanonicalGoogleButton: React.FC<{ onSuccess?: () => void }> = ({
  onSuccess,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { login } = useAuthStore();
  const container = useRef<HTMLDivElement>(null);
  const initializedClientIdRef = useRef<string | null>(null);
  const [clientId, setClientId] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    fetch(`${API_BASE_URL}/auth/oauth/google/status`, {
      cache: 'no-store',
      signal: controller.signal,
    })
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
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (!clientId || !container.current) return;
    const node = container.current;
    let cancelled = false;
    const render = () => {
      if (cancelled || !window.google) return;
      if (initializedClientIdRef.current !== clientId) {
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
              login(
                result.data.user,
                result.data.token,
                result.data.systemInfo
              );
              toast.success(t('auth.login.loginSuccess'));
              onSuccess?.();
              navigate('/');
            } catch {
              toast.error(t('auth.oauth.googleFailed'));
            } finally {
              setLoading(false);
            }
          },
          auto_select: false,
        });
        initializedClientIdRef.current = clientId;
      }
      const width = Math.min(node.clientWidth || 320, 400);
      node.innerHTML = '';
      window.google.accounts.id.renderButton(node, {
        theme: 'outline',
        size: 'large',
        width,
      });
    };
    if (window.google?.accounts?.id) {
      render();
    } else {
      const script = getOrCreateGsiScript(GSI_SRC);
      script.onerror = () => {
        gsiLoadPromises.delete(GSI_SRC);
        if (!cancelled) setClientId('');
      };
      script.addEventListener('load', render);
      loadGsiScript(GSI_SRC).catch(() => {
        if (!cancelled) setClientId('');
      });
    }
    return () => {
      cancelled = true;
      const script = document.querySelector<HTMLScriptElement>(
        'script[data-google-identity]'
      );
      if (script) script.removeEventListener('load', render);
      try {
        if (window.google) window.google.accounts.id.cancel();
      } catch {
        // Ignore cleanup errors when GSI is unavailable.
      }
      initializedClientIdRef.current = null;
      node.innerHTML = '';
    };
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
