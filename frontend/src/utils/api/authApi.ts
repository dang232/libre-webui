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

import type {
  ApiResponse,
  LoginRequest,
  LoginResponse,
  PendingApprovalSummary,
  SignupResponse,
  SystemInfo,
  User,
  UserCreateRequest,
  UserUpdateRequest,
} from '@/types';
import { isAuthBrowserHandoffEnabled } from '@/utils/canonicalHandoff';
import { API_BASE_URL, AUTH_BASE_URL } from '@/utils/config';
import { isDemoMode } from '@/utils/demoMode';
import { DEFAULT_DEMO_PREFERENCES } from './demoData';
import { api, createDemoResponse, logger } from './client';

const appVersion = import.meta.env?.VITE_APP_VERSION || '0.0.0';

/** One signed-in session (browser login or OAuth) as reported by the backend. */
export interface AuthSession {
  id: string;
  kind: string;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  /** True for the session making the request. */
  current: boolean;
}

/** A scoped API token. The plaintext token is only returned at creation. */
export interface ApiTokenRecord {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ApiTokenCreateResponse {
  /** Shown once; never retrievable again. */
  token: string;
  record: ApiTokenRecord;
}

/** Scopes an API token can carry. 'admin' is mintable by administrators only. */
export const API_TOKEN_SCOPES = [
  'chat',
  'models',
  'documents',
  'notes',
  'personas',
  'media',
  'work',
  'admin',
] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

/** Login can complete immediately or hand back a second-factor challenge. */
export interface MfaChallengeResponse {
  mfaRequired: true;
  requirement: 'verify' | 'enroll';
  challengeToken: string;
}

export type LoginResult = LoginResponse | MfaChallengeResponse;

export const isMfaChallenge = (
  data: LoginResult | undefined
): data is MfaChallengeResponse =>
  !!data && (data as MfaChallengeResponse).mfaRequired === true;

/** One registered passkey (public metadata only). */
export interface PasskeyRecord {
  id: string;
  name: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface MfaStatusResponse {
  totpEnabled: boolean;
  totpPending: boolean;
  recoveryCodesRemaining: number;
  required: boolean;
  requiredModeLocked: boolean;
  passkeys: PasskeyRecord[];
}

// Authentication API
export const authApi = {
  login: (credentials: LoginRequest): Promise<ApiResponse<LoginResult>> => {
    if (isDemoMode()) {
      return createDemoResponse<LoginResponse>({
        user: {
          id: 'demo-user',
          username: 'demo',
          email: 'demo@example.com',
          role: 'admin',
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        token: 'demo-token',
        systemInfo: {
          requiresAuth: true,
          hasUsers: true,
          userCount: 1,
          signupEnabled: true,
          version: appVersion,
        },
      });
    }

    return api.post('/auth/login', credentials).then(res => res.data);
  },

  canonicalLogin: (
    email: string,
    password: string
  ): Promise<ApiResponse<LoginResponse>> =>
    api
      .post('/auth/canonical-password', { email, password })
      .then(res => res.data),

  canonicalSignup: (
    email: string,
    password: string
  ): Promise<ApiResponse<LoginResponse>> =>
    api
      .post('/auth/canonical-signup', { email, password })
      .then(res => res.data),

  canonicalGoogle: (idToken: string): Promise<ApiResponse<LoginResponse>> =>
    api.post('/auth/canonical-google', { idToken }).then(res => res.data),

  signup: (credentials: {
    username: string;
    password: string;
    email?: string;
    turnstileToken?: string;
  }): Promise<ApiResponse<SignupResponse>> => {
    if (isDemoMode()) {
      return createDemoResponse<LoginResponse>({
        user: {
          id: 'demo-user-new',
          username: credentials.username,
          email: credentials.email || '',
          role: 'user',
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        token: 'demo-token-new',
        systemInfo: {
          requiresAuth: true,
          hasUsers: true,
          userCount: 1,
          signupEnabled: true,
          version: appVersion,
          turnstile: { enabled: false },
        },
      });
    }

    return api.post('/auth/signup', credentials).then(res => res.data);
  },

  logout: (): Promise<ApiResponse<void>> => {
    if (isDemoMode()) {
      return createDemoResponse(undefined);
    }

    return api.post('/auth/logout').then(res => res.data);
  },

  getSystemInfo: (): Promise<ApiResponse<SystemInfo>> => {
    logger.debug('getSystemInfo called, demo mode:', isDemoMode());

    if (isDemoMode()) {
      return createDemoResponse<SystemInfo>({
        requiresAuth: true,
        hasUsers: true,
        userCount: 1,
        signupEnabled: true,
        version: appVersion,
        turnstile: { enabled: false },
        defaultTheme: DEFAULT_DEMO_PREFERENCES.theme,
      });
    }

    logger.debug('Making API call to:', API_BASE_URL + '/auth/system-info');
    logger.debug(
      'Full URL from:',
      window.location.origin,
      '-> API:',
      API_BASE_URL + '/auth/system-info'
    );
    return api
      .get('/auth/system-info')
      .then(res => {
        logger.debug('getSystemInfo response:', res.data);
        return res.data;
      })
      .catch(error => {
        logger.debug('getSystemInfo error:', error);
        if (error.response) {
          logger.debug('Error response data:', error.response.data);
          logger.debug('Error status:', error.response.status);
          logger.debug('Error headers:', error.response.headers);
        }
        if (error.request) {
          logger.debug('Network error - no response received:', error.request);
        }
        logger.debug('Error config:', error.config);
        throw error;
      });
  },

  verifyToken: (): Promise<ApiResponse<User>> => {
    if (isDemoMode()) {
      return createDemoResponse<User>({
        id: 'demo-user',
        username: 'demo',
        email: 'demo@example.com',
        role: 'admin',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    return api.get('/auth/verify').then(res => res.data);
  },

  getEncryptionKey: (): Promise<ApiResponse<{ encryptionKey: string }>> => {
    if (isDemoMode()) {
      return createDemoResponse<{ encryptionKey: string }>({
        encryptionKey: 'demo-encryption-key-not-real',
      });
    }

    return api.get('/auth/encryption-key').then(res => res.data);
  },

  getSessions: (): Promise<ApiResponse<AuthSession[]>> => {
    if (isDemoMode()) {
      return createDemoResponse<AuthSession[]>([
        {
          id: 'demo-session',
          kind: 'password',
          userAgent: navigator.userAgent,
          createdAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          expiresAt: null,
          revokedAt: null,
          current: true,
        },
      ]);
    }

    return api.get('/auth/sessions').then(res => res.data);
  },

  revokeSession: (id: string): Promise<ApiResponse<void>> => {
    if (isDemoMode()) {
      return createDemoResponse(undefined);
    }

    return api.delete(`/auth/sessions/${id}`).then(res => res.data);
  },

  revokeOtherSessions: (): Promise<ApiResponse<{ revokedCount: number }>> => {
    if (isDemoMode()) {
      return createDemoResponse({ revokedCount: 0 });
    }

    return api.post('/auth/sessions/revoke-others').then(res => res.data);
  },

  listApiTokens: (): Promise<ApiResponse<ApiTokenRecord[]>> => {
    if (isDemoMode()) {
      return createDemoResponse<ApiTokenRecord[]>([]);
    }

    return api.get('/auth/tokens').then(res => res.data);
  },

  createApiToken: (payload: {
    name: string;
    scopes: string[];
    expiresInDays?: number;
  }): Promise<ApiResponse<ApiTokenCreateResponse>> => {
    if (isDemoMode()) {
      return createDemoResponse<ApiTokenCreateResponse>({
        token: 'lwui_demo_not_a_real_token',
        record: {
          id: 'demo-token-' + Date.now(),
          name: payload.name,
          tokenPrefix: 'lwui_demo',
          scopes: payload.scopes,
          createdAt: new Date().toISOString(),
          expiresAt: null,
          lastUsedAt: null,
          revokedAt: null,
        },
      });
    }

    return api.post('/auth/tokens', payload).then(res => res.data);
  },

  revokeApiToken: (id: string): Promise<ApiResponse<void>> => {
    if (isDemoMode()) {
      return createDemoResponse(undefined);
    }

    return api.delete(`/auth/tokens/${id}`).then(res => res.data);
  },

  mfaVerify: (payload: {
    challengeToken: string;
    code: string;
  }): Promise<ApiResponse<LoginResponse>> =>
    api.post('/auth/mfa/verify', payload).then(res => res.data),

  mfaEnrollChallenge: (payload: {
    challengeToken: string;
  }): Promise<ApiResponse<{ secret: string; otpauthUrl: string }>> =>
    api.post('/auth/mfa/enroll-challenge', payload).then(res => res.data),

  mfaActivateChallenge: (payload: {
    challengeToken: string;
    code: string;
  }): Promise<ApiResponse<LoginResponse & { recoveryCodes: string[] }>> =>
    api.post('/auth/mfa/activate-challenge', payload).then(res => res.data),

  getMfaStatus: (): Promise<ApiResponse<MfaStatusResponse>> => {
    if (isDemoMode()) {
      return createDemoResponse<MfaStatusResponse>({
        totpEnabled: false,
        totpPending: false,
        recoveryCodesRemaining: 0,
        required: false,
        requiredModeLocked: false,
        passkeys: [],
      });
    }
    return api.get('/auth/mfa').then(res => res.data);
  },

  mfaEnroll: (): Promise<ApiResponse<{ secret: string; otpauthUrl: string }>> =>
    api.post('/auth/mfa/enroll').then(res => res.data),

  mfaActivate: (payload: {
    code: string;
  }): Promise<ApiResponse<{ recoveryCodes: string[] }>> =>
    api.post('/auth/mfa/activate', payload).then(res => res.data),

  mfaRegenerateRecoveryCodes: (payload: {
    code: string;
  }): Promise<ApiResponse<{ recoveryCodes: string[] }>> =>
    api.post('/auth/mfa/recovery-codes', payload).then(res => res.data),

  mfaDisable: (payload: { code: string }): Promise<ApiResponse<void>> =>
    api.post('/auth/mfa/disable', payload).then(res => res.data),

  getMfaPolicy: (): Promise<
    ApiResponse<{ mode: 'optional' | 'required'; locked: boolean }>
  > => {
    if (isDemoMode()) {
      return createDemoResponse({ mode: 'optional' as const, locked: false });
    }
    return api.get('/auth/mfa/policy').then(res => res.data);
  },

  setMfaPolicy: (
    mode: 'optional' | 'required'
  ): Promise<ApiResponse<{ mode: 'optional' | 'required'; locked: boolean }>> =>
    api.put('/auth/mfa/policy', { mode }).then(res => res.data),

  passkeyRegisterOptions: (): Promise<
    ApiResponse<{ challengeToken: string; publicKey: Record<string, unknown> }>
  > => api.post('/auth/passkeys/register-options').then(res => res.data),

  passkeyRegister: (payload: {
    challengeToken: string;
    name?: string;
    credential: unknown;
  }): Promise<ApiResponse<PasskeyRecord>> =>
    api.post('/auth/passkeys/register', payload).then(res => res.data),

  listPasskeys: (): Promise<ApiResponse<PasskeyRecord[]>> => {
    if (isDemoMode()) {
      return createDemoResponse<PasskeyRecord[]>([]);
    }
    return api.get('/auth/passkeys').then(res => res.data);
  },

  deletePasskey: (id: string): Promise<ApiResponse<void>> =>
    api.delete(`/auth/passkeys/${id}`).then(res => res.data),

  passkeyLoginOptions: (): Promise<
    ApiResponse<{ challengeToken: string; publicKey: Record<string, unknown> }>
  > => api.post('/auth/passkeys/login-options').then(res => res.data),

  passkeyLogin: (payload: {
    challengeToken: string;
    credential: unknown;
  }): Promise<ApiResponse<LoginResponse>> =>
    api.post('/auth/passkeys/login', payload).then(res => res.data),

  /**
   * Direct Auth relying party (todo 45, Alcore mode only).
   *
   * The browser redeems an opaque Auth product code (Bearer handoff via
   * Auth POST /oidc/exchange, or redirect handoff via Auth
   * GET /oidc/exchange/redirect carrying ?code=&state=) at the Libre BFF,
   * which validates it server-to-server and returns a Libre product
   * session. The BFF never sees passwords or Auth refresh credentials.
   */
  alcoreConfig: (): Promise<
    ApiResponse<{ authUrl: string; issuer: string; mode: string }>
  > => api.get('/auth/alcore/config').then(res => res.data),

  alcoreExchange: (payload: {
    code: string;
    redirectUri?: string;
    state?: string;
  }): Promise<ApiResponse<LoginResponse>> =>
    api.post('/auth/alcore/exchange', payload).then(res => res.data),

  alcoreClaim: (payload: {
    username: string;
    password: string;
    code: string;
    redirectUri?: string;
    state?: string;
  }): Promise<ApiResponse<LoginResponse & { replay: boolean }>> =>
    api.post('/auth/alcore/claim', payload).then(res => res.data),
};

// ---------------------------------------------------------------------------
// Browser-direct Auth calls (todo 45).
//
// These use plain fetch against the Auth origin — never the Libre `api`
// client — so no Libre session token is attached and no 401 handler fires.
// Passwords travel browser→Auth only; Libre (BFF/frontend store) never sees
// them. Legacy flag-OFF holds an Auth access token in memory just long
// enough to fetch the opaque product code. Flag-ON never reads a token
// — the response's HttpOnly cookie is the session and the page navigates
// to the redirect handoff.
// ---------------------------------------------------------------------------

/** Auth API error codes surfaced as generic, non-enumerating messages. */
const alcoreAuthErrorMessage = (code: unknown): string => {
  switch (code) {
    case 'invalid_credentials':
      return 'Invalid email or password.';
    case 'email_taken':
      return 'An account with this email already exists.';
    case 'weak_password':
      return 'The password must be at least 8 characters.';
    case 'invalid_email':
      return 'Enter a valid email address.';
    case 'upstream_unavailable':
      return 'The sign-in provider is unavailable; try again shortly.';
    default:
      return 'Sign-in failed. Please try again.';
  }
};

const alcoreFetch = async (
  path: string,
  body: unknown,
  accessToken?: string
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> => {
  const response = await fetch(`${AUTH_BASE_URL}${path}`, {
    method: 'POST',
    // Store Auth's Set-Cookie (alcore_at / alcore_rt) so the redirect
    // handoff can authenticate from the HttpOnly cookie alone.
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  return { ok: response.ok, status: response.status, data: data ?? {} };
};

export interface AlcoreDirectSignIn {
  /**
   * Auth access token for the legacy Bearer handoff. Present only when
   * `isAuthBrowserHandoffEnabled()` is false; on the redirect path the
   * session lives in Auth's HttpOnly cookie and is never read into
   * JavaScript.
   */
  authAccessToken?: string;
  authUserId: string;
}

/** Password register/login directly against Auth. Throws Error on failure. */
export const alcoreDirectPassword = async (
  mode: 'login' | 'register',
  email: string,
  password: string
): Promise<AlcoreDirectSignIn> => {
  const { ok, data } = await alcoreFetch(
    mode === 'login' ? '/auth/login' : '/auth/register',
    { email, password }
  );
  // Register returns a flat `{id, ...pair}`; login nests `{...pair, user}`.
  const nestedUser = data.user as { id?: unknown } | undefined;
  const userId =
    typeof nestedUser?.id === 'string'
      ? nestedUser.id
      : typeof data.id === 'string'
        ? data.id
        : null;

  if (isAuthBrowserHandoffEnabled()) {
    // Redirect handoff: the cookie set by this response is the credential.
    // The token fields in the body are deliberately never read — no
    // application state, storage, or log ever holds an Auth token here.
    if (!ok || userId === null) {
      throw new Error(alcoreAuthErrorMessage(data.error));
    }
    return { authUserId: userId };
  }

  const accessToken = data.access_token;
  if (!ok || typeof accessToken !== 'string' || userId === null) {
    throw new Error(alcoreAuthErrorMessage(data.error));
  }
  return { authAccessToken: accessToken, authUserId: userId };
};

/** Password-reset request directly against Auth (always-200, non-enumerating). */
export const alcoreDirectResetRequest = async (
  email: string
): Promise<void> => {
  await alcoreFetch('/auth/reset/request', { email });
};

/**
 * Redeem an Auth session for the opaque single-use Libre product code.
 * The access token is used once here and must be discarded by the caller.
 */
export const alcoreDirectProductCode = async (
  authAccessToken: string
): Promise<string> => {
  const { ok, data } = await alcoreFetch(
    '/oidc/exchange',
    { audience: 'libre', intent: 'product_exchange' },
    authAccessToken
  );
  if (!ok || typeof data.code !== 'string' || !data.code) {
    throw new Error('Sign-in failed. Please try again.');
  }
  return data.code;
};

// Users API
export const usersApi = {
  getUsers: (): Promise<ApiResponse<User[]>> => {
    if (isDemoMode()) {
      return createDemoResponse<User[]>([
        {
          id: 'demo-user',
          username: 'demo',
          email: 'demo@example.com',
          role: 'admin',
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);
    }

    return api.get('/users').then(res => res.data);
  },

  createUser: (userData: UserCreateRequest): Promise<ApiResponse<User>> => {
    if (isDemoMode()) {
      return createDemoResponse<User>({
        id: 'new-user-' + Date.now(),
        username: userData.username,
        email: userData.email,
        role: userData.role,
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    return api.post('/users', userData).then(res => res.data);
  },

  updateUser: (
    id: string,
    userData: UserUpdateRequest
  ): Promise<ApiResponse<User>> => {
    if (isDemoMode()) {
      return createDemoResponse<User>({
        id,
        username: userData.username || 'demo',
        email: userData.email || 'demo@example.com',
        role: userData.role || 'user',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    return api.patch(`/users/${id}`, userData).then(res => res.data);
  },

  deleteUser: (id: string): Promise<ApiResponse<void>> => {
    if (isDemoMode()) {
      return createDemoResponse(undefined);
    }

    return api.delete(`/users/${id}`).then(res => res.data);
  },

  getPendingApprovals: (): Promise<ApiResponse<PendingApprovalSummary>> => {
    if (isDemoMode()) {
      return createDemoResponse({ count: 0, latestCreatedAt: null });
    }

    return api.get('/users/pending-approvals').then(res => res.data);
  },

  approveUser: (id: string): Promise<ApiResponse<User>> => {
    if (isDemoMode()) {
      return createDemoResponse({
        id,
        username: 'demo-user',
        email: 'demo@example.com',
        role: 'user',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    return api.patch(`/users/${id}/approve`).then(res => res.data);
  },

  resetUserMfa: (id: string): Promise<ApiResponse<{ removed: boolean }>> =>
    api.post(`/users/${id}/mfa/reset`).then(res => res.data),

  updateMyAvatar: (avatar: string | null): Promise<ApiResponse<User>> => {
    if (isDemoMode()) {
      return createDemoResponse({
        id: 'demo-user',
        username: 'demo',
        email: 'demo@example.com',
        role: 'admin' as const,
        status: 'active' as const,
        avatar,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    return api.patch('/users/me/avatar', { avatar }).then(res => res.data);
  },
};
