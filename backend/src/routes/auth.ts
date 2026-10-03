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

import express from 'express';
import rateLimit from '../middleware/sharedRateLimit.js';
import { githubOAuthService } from '../services/simpleGitHubOAuth.js';
import { huggingFaceOAuthService } from '../services/simpleHuggingFaceOAuth.js';
import { authService } from '../services/authService.js';
import {
  authenticate,
  requireAdmin,
  AuthenticatedRequest,
} from '../middleware/auth.js';
import { encryptionService } from '../services/encryptionService.js';
import { turnstileService } from '../services/turnstileService.js';
import {
  beginOAuthFlow,
  beginOAuthFlowWithPayload,
  consumeOAuthSessionCookie,
  consumeOAuthState,
  consumeOAuthStatePayload,
  setOAuthSessionCookie,
} from '../services/oauthSecurity.js';
import { validatePasswordStrength } from '../utils/hash.js';
import { createLogger } from '../utils/logger.js';
import {
  WebSocketTicketRateLimitError,
  websocketTicketService,
} from '../services/websocketTicketService.js';
import { coordinatedRateLimit } from '../middleware/coordinatedRateLimit.js';
import {
  findSessionById,
  listSessionsForUser,
  revokeAllAuthSessions,
  revokeAuthSession,
} from '../services/authSessionService.js';
import {
  createApiToken,
  findTokenById,
  isApiTokenScope,
  listTokensForUser,
  revokeApiToken,
  toPublicToken,
} from '../services/apiTokenService.js';
import {
  hashClientIp,
  recordAuditEvent,
} from '../services/securityAuditService.js';
import { OidcError, oidcOAuthService } from '../services/simpleOidcOAuth.js';
import {
  MfaError,
  activateTotp,
  beginTotpEnrollment,
  consumeMfaChallenge,
  disableTotp,
  getMfaRequiredMode,
  getMfaStatus,
  mfaRequiredModeLockedByEnv,
  peekMfaChallenge,
  regenerateRecoveryCodes,
  setMfaRequiredMode,
  verifySecondFactor,
} from '../services/mfaService.js';
import {
  PasskeyError,
  deletePasskey,
  listPasskeys,
  loginOptions as passkeyLoginOptions,
  registerPasskey,
  registrationOptions as passkeyRegistrationOptions,
  verifyPasskeyLogin,
} from '../services/webauthnService.js';
import { userModel } from '../models/userModel.js';
import {
  isAlcoreAuthMode,
  rejectLocalAuthInAlcoreMode,
} from '../config/authMode.js';
import {
  TokenpanelBridgeError,
  exchangePortalToken,
} from '../services/tokenpanelBridgeService.js';
import {
  isAuthDerivedSession,
  requireBffAuthSession,
  sessionBearerOf,
} from '../services/tokenpanelAuthSessionService.js';
import {
  alcoreCustomerAuthEnabled,
  authenticateCanonicalPassword,
  exchangeCanonicalGoogleToken,
  getCanonicalGoogleStatus,
  consumeLibreExchangeCode,
  forwardAlcoreGoogle,
  forwardAlcorePassword,
} from '../services/canonicalAuthService.js';
import type {
  ProductAssertion,
  CanonicalAuthFailure,
} from '../services/canonicalAuthService.js';

const router = express.Router();
const logger = createLogger('auth-routes');

// Fallback frontend URL for OAuth redirects
const FALLBACK_FRONTEND_URL = 'http://localhost:5173';
const getFrontendUrl = (): string =>
  (process.env.CORS_ORIGIN || FALLBACK_FRONTEND_URL)
    .split(',')[0]
    .trim()
    .replace(/\/$/, '');
const frontendRedirect = (search: string): string =>
  `${getFrontendUrl()}${search}`;
const pendingApprovalRedirect = (): string =>
  frontendRedirect('/login?approval=pending');
const oauthErrorRedirect = (error: string): string =>
  frontendRedirect(`?error=${encodeURIComponent(error)}`);

const getClientIp = (req: express.Request): string | undefined => {
  const cfConnectingIp = req.headers['cf-connecting-ip'];
  if (typeof cfConnectingIp === 'string' && cfConnectingIp.trim()) {
    return cfConnectingIp.trim();
  }

  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0]?.trim();
  }

  return req.ip || undefined;
};

// Rate limiter for authentication routes: 5 login attempts per 15 minutes
const loginRateLimiter = coordinatedRateLimit({
  keyPrefix: 'security.login',
  windowMs: 15 * 60 * 1000,
  limit: 5,
  message: 'Too many authentication attempts, please try again later',
});

const signupRateLimiter = coordinatedRateLimit({
  keyPrefix: 'security.signup',
  windowMs: 15 * 60 * 1000,
  // 10 registrations per IP per window (task 19 flowfix): signup has no
  // credential to guess, so this bucket is anti-spam/anti-enumeration, not
  // brute-force protection — login (5) and MFA (10) buckets are untouched.
  // 10 still bounds farming (40/hr/IP) and 409-oracle enumeration while
  // giving legit retries (weak-password 400s, name-taken 409s, turnstile
  // retries) and Playwright-speed fresh-user setups room to complete.
  limit: 10,
  message: 'Too many authentication attempts, please try again later',
});

// Second-factor attempts get their own strict bucket: a challenge token is
// only minted after a correct password, so this budget covers typos without
// permitting code guessing.
const mfaRateLimiter = coordinatedRateLimit({
  keyPrefix: 'security.mfa',
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: 'Too many verification attempts, please try again later',
});

// Passkey ceremonies (options + assertions) for anonymous sign-in.
const passkeyRateLimiter = coordinatedRateLimit({
  keyPrefix: 'security.passkey',
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: 'Too many passkey attempts, please try again later',
});

// Rate limiter for general auth routes. This bucket also serves the session
// and API-token management endpoints, so it is sized to never starve an
// interactive user; the credential endpoints keep their own strict
// coordinated limiters above.
const generalAuthRateLimiter = rateLimit({
  keyPrefix: 'auth-general',
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // limit each IP to 300 requests per windowMs
  message: {
    success: false,
    message: 'Too many requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Self-hosted vs Alcore-managed auth boundary (todo 41). In Alcore mode the
// local password, signup, OAuth, MFA, and passkey routes below return an
// identical 404 (no existent/nonexistent oracle); product session, token,
// bridge, and ticket routes are unaffected. Prefix mounting guarantees no
// local-auth route is missed; the bridge route stays until sunset (todo 29).
//
// Exception: GET /oauth/google/status is a read-only provider advertisement
// (configured flag + public client id, no credential issuance). The
// Alcore-mode sign-in panel needs it to render its Google button, so it is
// registered BEFORE the /oauth gate and stays reachable in both modes. The
// credentialed Google exchange (POST /auth/canonical-google, Auth-backed)
// was never gated. Local-mode responses are byte-identical: same handler,
// same shape, only an earlier match in the router.
router.get('/oauth/google/status', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    res.json(await getCanonicalGoogleStatus());
  } catch {
    res.json({ configured: false, clientId: '' });
  }
});
router.use('/login', rejectLocalAuthInAlcoreMode);
router.use('/signup', rejectLocalAuthInAlcoreMode);
router.use('/oauth', rejectLocalAuthInAlcoreMode);
router.use('/mfa', rejectLocalAuthInAlcoreMode);
router.use('/passkeys', rejectLocalAuthInAlcoreMode);
const canonicalFailureStatus = (
  reason: CanonicalAuthFailure,
  mode: 'login' | 'signup'
): { status: number; message: string } => {
  switch (reason) {
    case 'invalid_credentials':
      return mode === 'signup'
        ? { status: 400, message: 'Email or password is not acceptable' }
        : { status: 401, message: 'Invalid credentials' };
    case 'email_taken':
      return {
        status: 409,
        message: 'An account already exists for this email',
      };
    case 'rate_limited':
      return {
        status: 429,
        message: 'Too many authentication attempts, please try again later',
      };
    case 'unavailable':
    case 'invalid_response':
      return {
        status: 502,
        message: 'Authentication service is temporarily unavailable',
      };
  }
};

router.post('/canonical-password', loginRateLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const body = req.body ?? {};
  let email = body.email;
  let password = body.password;
  try {
    if (
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      !email.trim() ||
      !password
    ) {
      res
        .status(400)
        .json({ success: false, message: 'Email and password are required' });
      return;
    }
    if (!process.env.AUTH_JWT_SECRET?.trim()) {
      res.status(503).json({
        success: false,
        message: 'Canonical authentication is not configured',
      });
      return;
    }
    const credentials = { email: email.trim(), password, signup: false };
    password = '';
    // authenticateCanonicalPassword already consumed the one-use code and
    // verified the assertion, so the session is completed from the assertion.
    // Re-entering the code exchange here would hand it a non-string body.
    const exchanged = await authenticateCanonicalPassword(credentials);
    if (!exchanged.ok) {
      const mapped = canonicalFailureStatus(exchanged.reason, 'login');
      if (mapped.status >= 500) {
        logger.error('Canonical login upstream failure', exchanged.reason);
      }
      res
        .status(mapped.status)
        .json({ success: false, message: mapped.message });
      return;
    }
    await respondWithCanonicalSession(exchanged.assertion, req, res);
  } catch (error) {
    logger.error(
      'Canonical password authentication failed',
      error instanceof Error ? error.message : 'unknown'
    );
    res.status(502).json({
      success: false,
      message: 'Authentication service is temporarily unavailable',
    });
  } finally {
    password = '';
    if (typeof body === 'object') body.password = '';
    if (typeof req.body === 'object' && req.body !== null)
      req.body.password = '';
  }
});

router.post('/canonical-google', loginRateLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const idToken = req.body?.idToken;
  if (
    typeof idToken !== 'string' ||
    idToken.length === 0 ||
    Buffer.byteLength(idToken) > 8192
  ) {
    res.status(400).json({
      success: false,
      message: 'A valid Google credential is required',
    });
    return;
  }
  if (!process.env.AUTH_JWT_SECRET?.trim()) {
    res.status(503).json({
      success: false,
      message: 'Canonical authentication is not configured',
    });
    return;
  }
  try {
    const code = await exchangeCanonicalGoogleToken(idToken);
    if (!code) {
      res
        .status(401)
        .json({ success: false, message: 'Invalid Google credential' });
      return;
    }
    req.body = { code };
    await handleCanonicalExchange(req, res);
  } catch (error) {
    logger.error('Canonical Google authentication failed', error);
    res.status(502).json({
      success: false,
      message: 'Authentication service is temporarily unavailable',
    });
  }
});

router.post('/canonical-signup', signupRateLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const body = req.body ?? {};
  let email = body.email;
  let password = body.password;
  try {
    if (
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      !email.trim() ||
      !password
    ) {
      res
        .status(400)
        .json({ success: false, message: 'Email and password are required' });
      return;
    }
    if (!process.env.AUTH_JWT_SECRET?.trim()) {
      res.status(503).json({
        success: false,
        message: 'Canonical authentication is not configured',
      });
      return;
    }
    const credentials = { email: email.trim(), password, signup: true };
    password = '';
    const exchanged = await authenticateCanonicalPassword(credentials);
    if (!exchanged.ok) {
      const mapped = canonicalFailureStatus(exchanged.reason, 'signup');
      if (mapped.status >= 500) {
        logger.error('Canonical signup upstream failure', exchanged.reason);
      }
      res
        .status(mapped.status)
        .json({ success: false, message: mapped.message });
      return;
    }
    await respondWithCanonicalSession(exchanged.assertion, req, res);
  } catch (error) {
    logger.error(
      'Canonical signup failed',
      error instanceof Error ? error.message : 'unknown'
    );
    res.status(502).json({
      success: false,
      message: 'Authentication service is temporarily unavailable',
    });
  } finally {
    password = '';
    if (typeof body === 'object') body.password = '';
    if (typeof req.body === 'object' && req.body !== null)
      req.body.password = '';
  }
});

// Completes sign-in from an already verified product assertion. Both the
// direct password path and the code exchange end here so a session is only
// ever issued for an assertion this service verified itself.
const respondWithCanonicalSession = async (
  assertion: ProductAssertion,
  req: express.Request,
  res: express.Response
): Promise<void> => {
  const result = await authService.loginWithCanonicalUser(assertion, {
    kind: 'product:libre',
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'],
  });
  if (!result || result.status !== 'authenticated') {
    res.status(403).json({ success: false, message: 'Account is not active' });
    return;
  }
  res.json({
    success: true,
    data: {
      user: result.user,
      token: result.token,
      systemInfo: await authService.getSystemInfo(),
    },
  });
};

const handleCanonicalExchange = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  res.set('Cache-Control', 'no-store');
  const code = req.body?.code;
  if (typeof code !== 'string' || code.length === 0 || code.length > 512) {
    res
      .status(400)
      .json({ success: false, message: 'A valid exchange code is required' });
    return;
  }
  if (!process.env.AUTH_JWT_SECRET?.trim()) {
    res.status(503).json({
      success: false,
      message: 'Canonical authentication is not configured',
    });
    return;
  }
  try {
    const exchanged = await consumeLibreExchangeCode(code);
    if (!exchanged.ok) {
      const upstream =
        exchanged.reason === 'unavailable' ||
        exchanged.reason === 'invalid_response';
      if (upstream)
        logger.error('Canonical exchange upstream failure', exchanged.reason);
      res.status(upstream ? 502 : 401).json({
        success: false,
        message: upstream
          ? 'Authentication service is temporarily unavailable'
          : 'Invalid or expired exchange code',
      });
      return;
    }
    await respondWithCanonicalSession(exchanged.assertion, req, res);
  } catch (error) {
    logger.error('Canonical authentication exchange failed', error);
    res.status(502).json({
      success: false,
      message: 'Authentication service is temporarily unavailable',
    });
  }
};

router.post(
  '/canonical-exchange',
  generalAuthRateLimiter,
  handleCanonicalExchange
);

// WebSocket tickets get their own bucket: every chat reconnect consumes one,
// and a reconnect storm competing with sign-in traffic must not lock either
// out. The ticket service additionally enforces per-user and global quotas.
const ticketRateLimiter = rateLimit({
  keyPrefix: 'auth-ticket',
  windowMs: 5 * 60 * 1000,
  max: 120,
  message: {
    success: false,
    message: 'Too many WebSocket ticket requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Exchange the normal Authorization header for a short-lived, one-use
 * WebSocket ticket. This keeps the durable JWT out of URLs, proxy logs, and
 * browser history while retaining browser-compatible WebSocket authentication.
 */
router.post(
  '/websocket-ticket',
  ticketRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    res.set('Cache-Control', 'no-store');
    const audience = req.body?.audience;
    const taskId = req.body?.taskId;
    if (
      audience !== 'chat' &&
      audience !== 'work-terminal' &&
      audience !== 'work-screen'
    ) {
      res.status(400).json({
        success: false,
        message:
          'WebSocket ticket audience must be chat, work-terminal, or work-screen',
      });
      return;
    }
    if (
      (audience === 'work-terminal' || audience === 'work-screen') &&
      (typeof taskId !== 'string' || !taskId.trim() || taskId.length > 256)
    ) {
      res.status(400).json({
        success: false,
        message: 'A valid taskId is required for a Work terminal ticket',
      });
      return;
    }
    const sessionExpiresAt = (req.user?.exp ?? 0) * 1000;
    try {
      const ticket = await websocketTicketService.issue(
        req.user!.userId,
        sessionExpiresAt,
        audience,
        audience === 'work-terminal' || audience === 'work-screen'
          ? taskId.trim()
          : undefined,
        req.auth?.kind === 'session' ? req.auth.sessionId : undefined
      );
      res.json({ success: true, data: ticket });
    } catch (error) {
      if (error instanceof WebSocketTicketRateLimitError) {
        res.status(429).json({ success: false, message: error.message });
        return;
      }
      logger.warn('Shared WebSocket ticket storage is unavailable');
      res.status(503).json({
        success: false,
        message: 'WebSocket authentication is temporarily unavailable',
      });
    }
  }
);

// Bridge tickets get their own bucket: one mint per portal visit.
const tokenpanelRateLimiter = rateLimit({
  keyPrefix: 'auth-tokenpanel',
  windowMs: 5 * 60 * 1000,
  max: 30,
  message: {
    success: false,
    message: 'Too many bridge requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Single-login bridge into the TokenPanel portal (plan §5).
 * Mints a 120s viewer JWT for the caller's linked TokenPanel customer
 * (resolved fail-closed server-side: exact identity or exact single email
 * match, collision → 409, never first-row-wins). The browser receives the
 * token only to place it in a one-time URL fragment the portal consumes and
 * strips; the management key authorizing the mint never leaves the server.
 *
 * Gap2-bff (R-BFF1): in Alcore mode with an Auth-derived session, the grant
 * is the caller's own Auth session (zero bridge calls, bridge JWT not
 * required); otherwise the bridge mint below runs as flag-gated fallback.
 * TODO(bridge-sunset,todo29): temporary bridge — remove with the Phase 8
 * sunset. Grep marker: bridge-sunset.
 */
router.post(
  '/tokenpanel/portal-token',
  tokenpanelRateLimiter,
  authenticate,
  requireBffAuthSession,
  async (req: AuthenticatedRequest, res) => {
    res.set('Cache-Control', 'no-store');
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }
    if (
      isAlcoreAuthMode() &&
      (await isAuthDerivedSession(req).catch(() => false))
    ) {
      const token = sessionBearerOf(req) ?? '';
      const expSeconds =
        typeof req.user?.exp === 'number' ? req.user.exp : null;
      const expiresAt =
        expSeconds !== null
          ? new Date(expSeconds * 1000).toISOString()
          : new Date(Date.now() + 60 * 60 * 1000).toISOString();
      void recordAuditEvent({
        action: 'auth.tokenpanel-bridge',
        result: 'success',
        actorUserId: userId,
        ipHash: hashClientIp(getClientIp(req)),
        details: { via: 'auth-session', customerId: userId },
      });
      res.json({
        success: true,
        data: { token, expiresAt, customerId: userId, linked: 'existing' },
      });
      return;
    }
    const idempotencyKey =
      typeof req.headers['idempotency-key'] === 'string'
        ? req.headers['idempotency-key']
        : undefined;
    try {
      const grant = await exchangePortalToken(
        userId,
        idempotencyKey !== undefined ? { idempotencyKey } : undefined
      );
      void recordAuditEvent({
        action: 'auth.tokenpanel-bridge',
        result: 'success',
        actorUserId: userId,
        ipHash: hashClientIp(getClientIp(req)),
        details: { linked: grant.linked, customerId: grant.customerId },
      });
      res.json({ success: true, data: grant });
    } catch (error) {
      const status =
        error instanceof TokenpanelBridgeError ? error.status : 500;
      if (status === 500) logger.error('TokenPanel bridge failed', error);
      void recordAuditEvent({
        action: 'auth.tokenpanel-bridge',
        result: 'denied',
        actorUserId: userId,
        ipHash: hashClientIp(getClientIp(req)),
        details: {
          reason: error instanceof Error ? error.message : 'unknown',
          status,
        },
      });
      res.status(status).json({
        success: false,
        message:
          error instanceof TokenpanelBridgeError
            ? error.message
            : 'TokenPanel bridge is temporarily unavailable',
      });
    }
  }
);

/**
 * Login endpoint
 */
router.post('/login', loginRateLimiter, async (req, res) => {
  let password: unknown = req.body?.password;
  try {
    const { username, turnstileToken } = req.body;

    if (!username || !password) {
      res.status(400).json({
        success: false,
        message: 'Username and password are required',
      });
      return;
    }

    const turnstileValid = await turnstileService.verify(
      turnstileToken,
      getClientIp(req),
      'login'
    );

    if (!turnstileValid) {
      res.status(400).json({
        success: false,
        message: 'Verification failed. Please try again.',
      });
      return;
    }

    if (
      typeof username === 'string' &&
      typeof password === 'string' &&
      username.includes('@') &&
      alcoreCustomerAuthEnabled()
    ) {
      const customer = await forwardAlcorePassword({
        email: username.trim(),
        password,
        signup: false,
      });
      password = '';
      req.body.password = '';
      if (!customer) {
        res
          .status(401)
          .json({ success: false, message: 'Invalid credentials' });
        return;
      }
      const result = await authService.loginWithCanonicalId(
        customer.canonicalUserId,
        {
          kind: 'alcore:customer-password',
          ip: getClientIp(req),
          userAgent: req.headers['user-agent'],
        }
      );
      if (!result || result.status !== 'authenticated') {
        res
          .status(403)
          .json({ success: false, message: 'This account is not active' });
        return;
      }
      res.json({
        success: true,
        data: {
          user: result.user,
          token: result.token,
          systemInfo: await authService.getSystemInfo(),
        },
      });
      return;
    }

    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({
        success: false,
        message: 'Username and password are required',
      });
      return;
    }
    const result = await authService.login(username, password, {
      kind: 'password',
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });
    if (!result) {
      void recordAuditEvent({
        action: 'auth.login',
        result: 'failure',
        ipHash: hashClientIp(getClientIp(req)),
        details: { username: String(username).slice(0, 64) },
      });
      res.status(401).json({
        success: false,
        message: 'Invalid credentials',
      });
      return;
    }
    void recordAuditEvent({
      action: 'auth.login',
      result: result.status === 'authenticated' ? 'success' : 'denied',
      actorUserId: result.user.id,
      ipHash: hashClientIp(getClientIp(req)),
      details: { method: 'password', status: result.status },
    });
    if (result.status === 'pending') {
      res.status(403).json({
        success: false,
        code: 'ACCOUNT_PENDING',
        message: 'Your account is waiting for administrator approval',
      });
      return;
    }
    if (result.status === 'mfa') {
      // The password checked out, but this is not a session yet. Only the
      // challenge leaves the server; account details wait for the second
      // factor.
      res.json({
        success: true,
        data: {
          mfaRequired: true,
          requirement: result.requirement,
          challengeToken: result.challengeToken,
        },
      });
      return;
    }

    const systemInfo = await authService.getSystemInfo();

    res.json({
      success: true,
      data: {
        user: result.user,
        token: result.token,
        systemInfo,
      },
    });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  } finally {
    password = '';
    if (typeof req.body === 'object' && req.body !== null)
      req.body.password = '';
  }
});

router.post('/oauth/alcore-google', loginRateLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const body = req.body ?? {};
  const idToken = body.idToken;
  try {
    if (typeof idToken !== 'string' || !idToken || idToken.length > 8192) {
      res.status(400).json({
        success: false,
        message: 'A valid Google ID token is required',
      });
      return;
    }
    const customer = await forwardAlcoreGoogle(
      idToken,
      typeof body.displayName === 'string' ? body.displayName : undefined
    );
    if (!customer) {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
      return;
    }
    const result = await authService.loginWithCanonicalId(
      customer.canonicalUserId,
      {
        kind: 'alcore:customer-google',
        ip: getClientIp(req),
        userAgent: req.headers['user-agent'],
      }
    );
    if (!result || result.status !== 'authenticated') {
      res
        .status(403)
        .json({ success: false, message: 'This account is not active' });
      return;
    }
    res.json({
      success: true,
      data: {
        user: result.user,
        token: result.token,
        systemInfo: await authService.getSystemInfo(),
      },
    });
  } catch (error) {
    logger.error(
      'Alcore Google authentication failed',
      error instanceof Error ? error.message : 'unknown'
    );
    res.status(502).json({
      success: false,
      message: 'Authentication service is temporarily unavailable',
    });
  } finally {
    body.idToken = '';
    if (typeof req.body === 'object' && req.body !== null)
      req.body.idToken = '';
  }
});

/** Finish a sign-in: issue the revocable session and the standard payload. */
const completeSignIn = async (
  req: express.Request,
  res: express.Response,
  userId: string,
  kind: string
): Promise<void> => {
  const user = await userModel.getUserById(userId);
  if (!user || user.status !== 'active') {
    res.status(403).json({
      success: false,
      message: 'This account is not active',
    });
    return;
  }
  const token = await authService.issueSession(user, {
    kind,
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'],
  });
  res.json({
    success: true,
    data: { user, token, systemInfo: await authService.getSystemInfo() },
  });
};

const handleMfaFailure = (
  res: express.Response,
  error: unknown,
  fallback: string
): void => {
  if (error instanceof MfaError || error instanceof PasskeyError) {
    res
      .status(error.statusCode)
      .json({ success: false, message: error.message });
    return;
  }
  logger.error('MFA endpoint error:', error);
  res.status(500).json({ success: false, message: fallback });
};

/**
 * Complete a password sign-in with a TOTP or recovery code.
 */
router.post('/mfa/verify', mfaRateLimiter, async (req, res) => {
  try {
    const { challengeToken, code } = req.body ?? {};
    if (typeof challengeToken !== 'string' || typeof code !== 'string') {
      res.status(400).json({
        success: false,
        message: 'A challenge token and code are required',
      });
      return;
    }
    const challenge = peekMfaChallenge(challengeToken, 'mfa-verify');
    const { verified, method } = await verifySecondFactor(
      challenge.userId,
      code
    );
    if (!verified) {
      void recordAuditEvent({
        action: 'auth.mfa.verify',
        result: 'failure',
        actorUserId: challenge.userId,
        ipHash: hashClientIp(getClientIp(req)),
      });
      res
        .status(401)
        .json({ success: false, message: 'That code is not valid' });
      return;
    }
    if (!(await consumeMfaChallenge(challenge.jti))) {
      res.status(401).json({
        success: false,
        message: 'This sign-in challenge was already used',
      });
      return;
    }
    void recordAuditEvent({
      action: 'auth.mfa.verify',
      result: 'success',
      actorUserId: challenge.userId,
      ipHash: hashClientIp(getClientIp(req)),
      details: { method },
    });
    await completeSignIn(req, res, challenge.userId, `password+${method}`);
  } catch (error) {
    handleMfaFailure(res, error, 'Verification failed');
  }
});

/**
 * Policy-forced enrollment during sign-in: mint the TOTP secret for a
 * pending challenge without an authenticated session.
 */
router.post('/mfa/enroll-challenge', mfaRateLimiter, async (req, res) => {
  try {
    const { challengeToken } = req.body ?? {};
    if (typeof challengeToken !== 'string') {
      res
        .status(400)
        .json({ success: false, message: 'A challenge token is required' });
      return;
    }
    const challenge = peekMfaChallenge(challengeToken, 'mfa-enroll');
    const user = await userModel.getUserById(challenge.userId);
    if (!user || user.status !== 'active') {
      res
        .status(403)
        .json({ success: false, message: 'This account is not active' });
      return;
    }
    const enrollment = await beginTotpEnrollment(user.id, user.username);
    void recordAuditEvent({
      action: 'auth.mfa.enroll',
      result: 'success',
      actorUserId: user.id,
      details: { forced: true },
    });
    res.json({ success: true, data: enrollment });
  } catch (error) {
    handleMfaFailure(res, error, 'Enrollment failed');
  }
});

/**
 * Policy-forced enrollment during sign-in: confirm the first code, receive
 * recovery codes, and finish the sign-in in one step.
 */
router.post('/mfa/activate-challenge', mfaRateLimiter, async (req, res) => {
  try {
    const { challengeToken, code } = req.body ?? {};
    if (typeof challengeToken !== 'string' || typeof code !== 'string') {
      res.status(400).json({
        success: false,
        message: 'A challenge token and code are required',
      });
      return;
    }
    const challenge = peekMfaChallenge(challengeToken, 'mfa-enroll');
    const recoveryCodes = await activateTotp(challenge.userId, code);
    if (!(await consumeMfaChallenge(challenge.jti))) {
      res.status(401).json({
        success: false,
        message: 'This sign-in challenge was already used',
      });
      return;
    }
    void recordAuditEvent({
      action: 'auth.mfa.activate',
      result: 'success',
      actorUserId: challenge.userId,
      details: { forced: true },
    });
    const user = await userModel.getUserById(challenge.userId);
    if (!user || user.status !== 'active') {
      res
        .status(403)
        .json({ success: false, message: 'This account is not active' });
      return;
    }
    const token = await authService.issueSession(user, {
      kind: 'password+totp',
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });
    res.json({
      success: true,
      data: {
        user,
        token,
        systemInfo: await authService.getSystemInfo(),
        recoveryCodes,
      },
    });
  } catch (error) {
    handleMfaFailure(res, error, 'Enrollment failed');
  }
});

/** Second-factor status for the signed-in account. */
router.get(
  '/mfa',
  generalAuthRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    try {
      const [status, passkeys] = await Promise.all([
        getMfaStatus(req.user!.userId),
        listPasskeys(req.user!.userId),
      ]);
      res.json({ success: true, data: { ...status, passkeys } });
    } catch (error) {
      handleMfaFailure(res, error, 'Failed to load MFA status');
    }
  }
);

/** Begin TOTP enrollment from settings. */
router.post(
  '/mfa/enroll',
  generalAuthRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    try {
      const enrollment = await beginTotpEnrollment(
        req.user!.userId,
        req.user!.username
      );
      void recordAuditEvent({
        action: 'auth.mfa.enroll',
        result: 'success',
        actorUserId: req.user!.userId,
      });
      res.json({ success: true, data: enrollment });
    } catch (error) {
      handleMfaFailure(res, error, 'Enrollment failed');
    }
  }
);

/** Confirm enrollment with a first valid code; returns the recovery codes. */
router.post(
  '/mfa/activate',
  mfaRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    try {
      const { code } = req.body ?? {};
      if (typeof code !== 'string') {
        res.status(400).json({ success: false, message: 'A code is required' });
        return;
      }
      const recoveryCodes = await activateTotp(req.user!.userId, code);
      void recordAuditEvent({
        action: 'auth.mfa.activate',
        result: 'success',
        actorUserId: req.user!.userId,
      });
      res.json({ success: true, data: { recoveryCodes } });
    } catch (error) {
      handleMfaFailure(res, error, 'Activation failed');
    }
  }
);

/** Regenerate recovery codes after re-proving the second factor. */
router.post(
  '/mfa/recovery-codes',
  mfaRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    try {
      const { code } = req.body ?? {};
      if (typeof code !== 'string') {
        res.status(400).json({ success: false, message: 'A code is required' });
        return;
      }
      const recoveryCodes = await regenerateRecoveryCodes(
        req.user!.userId,
        code
      );
      void recordAuditEvent({
        action: 'auth.mfa.recovery-codes',
        result: 'success',
        actorUserId: req.user!.userId,
      });
      res.json({ success: true, data: { recoveryCodes } });
    } catch (error) {
      handleMfaFailure(res, error, 'Failed to regenerate recovery codes');
    }
  }
);

/** Disable TOTP after re-proving the second factor. */
router.post(
  '/mfa/disable',
  mfaRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    try {
      const { code } = req.body ?? {};
      if (typeof code !== 'string') {
        res.status(400).json({ success: false, message: 'A code is required' });
        return;
      }
      await disableTotp(req.user!.userId, code);
      void recordAuditEvent({
        action: 'auth.mfa.disable',
        result: 'success',
        actorUserId: req.user!.userId,
      });
      res.json({
        success: true,
        message: 'Two-factor authentication disabled',
      });
    } catch (error) {
      handleMfaFailure(
        res,
        error,
        'Failed to disable two-factor authentication'
      );
    }
  }
);

/** Instance step-up policy (admin): optional vs required for every account. */
router.get(
  '/mfa/policy',
  generalAuthRateLimiter,
  authenticate,
  requireAdmin,
  async (_req: AuthenticatedRequest, res) => {
    res.json({
      success: true,
      data: {
        mode: await getMfaRequiredMode(),
        locked: mfaRequiredModeLockedByEnv(),
      },
    });
  }
);

router.put(
  '/mfa/policy',
  generalAuthRateLimiter,
  authenticate,
  requireAdmin,
  async (req: AuthenticatedRequest, res) => {
    try {
      const { mode } = req.body ?? {};
      if (mode !== 'optional' && mode !== 'required') {
        res.status(400).json({
          success: false,
          message: "The MFA policy mode must be 'optional' or 'required'",
        });
        return;
      }
      await setMfaRequiredMode(mode);
      void recordAuditEvent({
        action: 'admin.mfa.policy',
        result: 'success',
        actorUserId: req.user!.userId,
        details: { mode },
      });
      res.json({ success: true, data: { mode, locked: false } });
    } catch (error) {
      handleMfaFailure(res, error, 'Failed to update the MFA policy');
    }
  }
);

/** Passkey registration options for the signed-in account. */
router.post(
  '/passkeys/register-options',
  generalAuthRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    try {
      const options = await passkeyRegistrationOptions(
        { id: req.user!.userId, username: req.user!.username },
        req.headers.host ?? ''
      );
      res.json({ success: true, data: options });
    } catch (error) {
      handleMfaFailure(res, error, 'Failed to prepare passkey registration');
    }
  }
);

/** Register a new passkey for the signed-in account. */
router.post(
  '/passkeys/register',
  generalAuthRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    try {
      const passkey = await registerPasskey(
        req.user!.userId,
        req.body ?? {},
        req.headers.host ?? ''
      );
      void recordAuditEvent({
        action: 'auth.passkey.register',
        result: 'success',
        actorUserId: req.user!.userId,
        targetType: 'passkey',
        targetId: passkey.id,
      });
      res.json({ success: true, data: passkey });
    } catch (error) {
      handleMfaFailure(res, error, 'Passkey registration failed');
    }
  }
);

/** List the signed-in account's passkeys. */
router.get(
  '/passkeys',
  generalAuthRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    try {
      res.json({ success: true, data: await listPasskeys(req.user!.userId) });
    } catch (error) {
      handleMfaFailure(res, error, 'Failed to list passkeys');
    }
  }
);

/** Remove one of the signed-in account's passkeys. */
router.delete(
  '/passkeys/:id',
  generalAuthRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    try {
      const passkeyId = String(req.params.id);
      const removed = await deletePasskey(req.user!.userId, passkeyId);
      if (!removed) {
        res.status(404).json({ success: false, message: 'Passkey not found' });
        return;
      }
      void recordAuditEvent({
        action: 'auth.passkey.remove',
        result: 'success',
        actorUserId: req.user!.userId,
        targetType: 'passkey',
        targetId: passkeyId,
      });
      res.json({ success: true, message: 'Passkey removed' });
    } catch (error) {
      handleMfaFailure(res, error, 'Failed to remove passkey');
    }
  }
);

/** Anonymous passkey sign-in: ceremony options. */
router.post('/passkeys/login-options', passkeyRateLimiter, async (req, res) => {
  try {
    const options = await passkeyLoginOptions(req.headers.host ?? '');
    res.json({ success: true, data: options });
  } catch (error) {
    handleMfaFailure(res, error, 'Failed to prepare passkey sign-in');
  }
});

/** Anonymous passkey sign-in: verify the assertion and issue a session. */
router.post('/passkeys/login', passkeyRateLimiter, async (req, res) => {
  try {
    const { userId, passkeyId } = await verifyPasskeyLogin(
      req.body ?? {},
      req.headers.host ?? ''
    );
    void recordAuditEvent({
      action: 'auth.login',
      result: 'success',
      actorUserId: userId,
      ipHash: hashClientIp(getClientIp(req)),
      details: { method: 'passkey', passkeyId },
    });
    await completeSignIn(req, res, userId, 'passkey');
  } catch (error) {
    if (error instanceof PasskeyError) {
      void recordAuditEvent({
        action: 'auth.login',
        result: 'failure',
        ipHash: hashClientIp(getClientIp(req)),
        details: { method: 'passkey' },
      });
    }
    handleMfaFailure(res, error, 'Passkey sign-in failed');
  }
});

/**
 * Logout endpoint
 */
router.post(
  '/logout',
  generalAuthRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    try {
      // Revoke the server-side session so the JWT stops working everywhere,
      // not just in this browser.
      if (req.auth?.kind === 'session' && req.user) {
        await revokeAuthSession(req.auth.sessionId, req.user.userId);
      }
      void recordAuditEvent({
        action: 'auth.logout',
        result: 'success',
        actorUserId: req.user?.userId ?? null,
      });

      res.json({
        success: true,
        message: 'Logged out successfully',
      });
    } catch (error) {
      logger.error('Logout error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
      });
    }
  }
);

/** List this account's sessions, newest activity first. */
router.get(
  '/sessions',
  generalAuthRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    try {
      const sessions = await listSessionsForUser(req.user!.userId);
      const currentSessionId =
        req.auth?.kind === 'session' ? req.auth.sessionId : null;
      res.json({
        success: true,
        data: sessions.map(session => ({
          id: session.id,
          kind: session.kind,
          userAgent: session.user_agent,
          createdAt: new Date(session.created_at).toISOString(),
          lastSeenAt: new Date(session.last_seen_at).toISOString(),
          expiresAt: new Date(session.expires_at).toISOString(),
          revokedAt: session.revoked_at
            ? new Date(session.revoked_at).toISOString()
            : null,
          current: session.id === currentSessionId,
        })),
      });
    } catch (error) {
      logger.error('Session inventory error:', error);
      res
        .status(500)
        .json({ success: false, message: 'Internal server error' });
    }
  }
);

/** Revoke every other session ("sign out everywhere else"). */
router.post(
  '/sessions/revoke-others',
  generalAuthRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    try {
      const currentSessionId =
        req.auth?.kind === 'session' ? req.auth.sessionId : undefined;
      const revoked = await revokeAllAuthSessions(
        req.user!.userId,
        req.user!.userId,
        currentSessionId
      );
      void recordAuditEvent({
        action: 'session.revoke-others',
        result: 'success',
        actorUserId: req.user!.userId,
        details: { revokedCount: revoked.length },
      });
      res.json({ success: true, data: { revokedCount: revoked.length } });
    } catch (error) {
      logger.error('Session revocation error:', error);
      res
        .status(500)
        .json({ success: false, message: 'Internal server error' });
    }
  }
);

/** Revoke one session by id (own sessions only; admins may revoke any). */
router.delete(
  '/sessions/:id',
  generalAuthRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    try {
      const session = await findSessionById(req.params.id as string);
      const isOwn = session?.user_id === req.user!.userId;
      const isAdmin = req.user!.role === 'admin';
      if (!session || (!isOwn && !isAdmin)) {
        res.status(404).json({ success: false, message: 'Session not found' });
        return;
      }
      const revoked = await revokeAuthSession(session.id, req.user!.userId);
      void recordAuditEvent({
        action: 'session.revoke',
        result: 'success',
        actorUserId: req.user!.userId,
        targetType: 'auth-session',
        targetId: session.id,
        details: { targetUserId: session.user_id },
      });
      res.json({ success: true, data: { revoked } });
    } catch (error) {
      logger.error('Session revocation error:', error);
      res
        .status(500)
        .json({ success: false, message: 'Internal server error' });
    }
  }
);

/** List this account's API tokens (hashes never leave the server). */
router.get(
  '/tokens',
  generalAuthRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    try {
      const tokens = await listTokensForUser(req.user!.userId);
      res.json({ success: true, data: tokens.map(toPublicToken) });
    } catch (error) {
      logger.error('Token list error:', error);
      res
        .status(500)
        .json({ success: false, message: 'Internal server error' });
    }
  }
);

/** Create a scoped API token; the secret is returned exactly once. */
router.post(
  '/tokens',
  generalAuthRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    try {
      if (req.auth?.kind === 'api-token') {
        res.status(403).json({
          success: false,
          message: 'API tokens cannot create other tokens',
        });
        return;
      }
      const { name, scopes, expiresInDays } = req.body ?? {};
      const requestedScopes = Array.isArray(scopes)
        ? scopes.filter(isApiTokenScope)
        : [];
      if (requestedScopes.includes('admin') && req.user!.role !== 'admin') {
        res.status(403).json({
          success: false,
          message: 'Only administrators may mint admin-scoped tokens',
        });
        return;
      }
      const created = await createApiToken(req.user!.userId, {
        name: typeof name === 'string' ? name : '',
        scopes: requestedScopes,
        ...(typeof expiresInDays === 'number' ? { expiresInDays } : {}),
      });
      void recordAuditEvent({
        action: 'token.create',
        result: 'success',
        actorUserId: req.user!.userId,
        targetType: 'api-token',
        targetId: created.record.id,
        details: { name: created.record.name, scopes: requestedScopes },
      });
      res.status(201).json({
        success: true,
        data: { token: created.token, record: toPublicToken(created.record) },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Internal server error';
      res.status(400).json({ success: false, message });
    }
  }
);

/** Revoke an API token (own tokens; admins may revoke any). */
router.delete(
  '/tokens/:id',
  generalAuthRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    try {
      const record = await findTokenById(req.params.id as string);
      const isOwn = record?.user_id === req.user!.userId;
      const isAdmin = req.user!.role === 'admin';
      if (!record || (!isOwn && !isAdmin)) {
        res.status(404).json({ success: false, message: 'Token not found' });
        return;
      }
      const revoked = await revokeApiToken(record.id);
      void recordAuditEvent({
        action: 'token.revoke',
        result: 'success',
        actorUserId: req.user!.userId,
        targetType: 'api-token',
        targetId: record.id,
        details: { targetUserId: record.user_id },
      });
      res.json({ success: true, data: { revoked } });
    } catch (error) {
      logger.error('Token revocation error:', error);
      res
        .status(500)
        .json({ success: false, message: 'Internal server error' });
    }
  }
);

/**
 * Verify token endpoint (todo 45: session-aware — a revoked/logout session
 * 401s here instead of lingering until JWT expiry, so revocation clears
 * state on this route too).
 */
router.get(
  '/verify',
  generalAuthRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = await authService.getUserFromToken(
        req.headers.authorization!.substring(7)
      );
      if (!user || user.id !== req.user?.userId) {
        res.status(401).json({
          success: false,
          message: 'Invalid token',
        });
        return;
      }

      res.json({
        success: true,
        data: user,
      });
    } catch (error) {
      logger.error('Token verification error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
      });
    }
  }
);

/**
 * Get system information
 */
router.get('/system-info', async (req, res) => {
  try {
    const systemInfo = await authService.getSystemInfo();
    res.json({
      success: true,
      data: systemInfo,
    });
  } catch (error) {
    logger.error('System info error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
});

/**
 * Get encryption key for first-time setup
 * Only accessible during initial setup (when only one user exists - the newly created admin)
 */
router.get(
  '/encryption-key',
  generalAuthRateLimiter,
  authenticate,
  requireAdmin,
  async (_req, res) => {
    try {
      const systemInfo = await authService.getSystemInfo();

      // Keep the first-time setup behavior, but bind disclosure to the
      // authenticated administrator created by that setup.
      if (systemInfo.userCount !== 1) {
        res.status(403).json({
          success: false,
          message: 'Encryption key is only available during first-time setup',
        });
        return;
      }

      const encryptionKey = encryptionService.getKeyForDisplay();
      res.json({
        success: true,
        data: { encryptionKey },
      });
    } catch (error) {
      logger.error('Encryption key retrieval error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
      });
    }
  }
);

/**
 * Signup endpoint
 */
router.post('/signup', signupRateLimiter, async (req, res) => {
  let signupPassword: unknown = req.body?.password;
  try {
    const { username, password, email, turnstileToken } = req.body;

    if (!username || !password) {
      res.status(400).json({
        success: false,
        message: 'Username and password are required',
      });
      return;
    }

    if (
      !alcoreCustomerAuthEnabled() &&
      !(await authService.canCreateLocalAccount())
    ) {
      res.status(403).json({
        success: false,
        message: 'Registration is disabled',
      });
      return;
    }

    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.isValid) {
      res.status(400).json({
        success: false,
        message: 'Password does not meet security requirements',
        errors: passwordValidation.errors,
      });
      return;
    }

    // Check if user already exists
    const existingUser = await authService.getUserByUsername(username);
    if (existingUser) {
      res.status(409).json({
        success: false,
        message: 'Username already exists',
      });
      return;
    }

    const turnstileValid = await turnstileService.verify(
      turnstileToken,
      getClientIp(req),
      'signup'
    );

    if (!turnstileValid) {
      res.status(400).json({
        success: false,
        message: 'Verification failed. Please try again.',
      });
      return;
    }

    if (
      typeof email === 'string' &&
      typeof signupPassword === 'string' &&
      alcoreCustomerAuthEnabled()
    ) {
      const customer = await forwardAlcorePassword({
        email: email.trim(),
        password: signupPassword,
        signup: true,
      });
      signupPassword = '';
      req.body.password = '';
      if (!customer) {
        res
          .status(409)
          .json({ success: false, message: 'Account could not be created' });
        return;
      }
      const result = await authService.loginWithCanonicalId(
        customer.canonicalUserId,
        {
          kind: 'alcore:customer-signup',
          ip: getClientIp(req),
          userAgent: req.headers['user-agent'],
        }
      );
      if (!result || result.status !== 'authenticated') {
        res
          .status(403)
          .json({ success: false, message: 'This account is not active' });
        return;
      }
      res.json({
        success: true,
        data: {
          user: result.user,
          token: result.token,
          systemInfo: await authService.getSystemInfo(),
        },
      });
      return;
    }

    const result = await authService.signup(username, password, email, {
      kind: 'signup',
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });
    if (!result) {
      res.status(500).json({
        success: false,
        message: 'Failed to create account',
      });
      return;
    }
    void recordAuditEvent({
      action: 'auth.signup',
      result: 'success',
      actorUserId: result.user.id,
      ipHash: hashClientIp(getClientIp(req)),
      details: { status: result.status },
    });

    const systemInfo = await authService.getSystemInfo();

    if (result.status !== 'authenticated') {
      // Signup never produces an MFA challenge; any non-authenticated
      // outcome here is a pending-approval account.
      res.status(202).json({
        success: true,
        data: {
          user: result.user,
          approvalRequired: true,
          systemInfo,
        },
      });
      return;
    }

    res.json({
      success: true,
      data: {
        user: result.user,
        token: result.token,
        systemInfo,
      },
    });
  } catch (error) {
    logger.error('Signup error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  } finally {
    signupPassword = '';
    if (typeof req.body === 'object' && req.body !== null)
      req.body.password = '';
  }
});

/**
 * GitHub OAuth Routes
 * These routes integrate GitHub OAuth with the existing JWT authentication system
 */

// GitHub OAuth setup if credentials are provided
const isGitHubConfigured = githubOAuthService.isConfigured();

/**
 * GitHub OAuth - Start authentication
 */
router.get('/oauth/github', generalAuthRateLimiter, (req, res) => {
  if (!isGitHubConfigured) {
    return res.status(404).json({ error: 'GitHub OAuth not configured' });
  }

  const state = beginOAuthFlow(req, res, 'github');
  const authUrl = githubOAuthService.getAuthUrl(state);
  res.redirect(authUrl);
});

/**
 * GitHub OAuth - Handle callback and generate JWT
 */
router.get(
  '/oauth/github/callback',
  generalAuthRateLimiter,
  async (req, res) => {
    try {
      if (!isGitHubConfigured) {
        return res.redirect(oauthErrorRedirect('oauth_not_configured'));
      }

      const { code, state } = req.query;
      const stateIsValid = consumeOAuthState(
        req,
        res,
        'github',
        typeof state === 'string' ? state : ''
      );

      if (!code || typeof code !== 'string' || !stateIsValid) {
        return res.redirect(oauthErrorRedirect('oauth_failed'));
      }

      // Exchange code for access token
      const accessToken = await githubOAuthService.exchangeCodeForToken(code);
      if (!accessToken) {
        return res.redirect(oauthErrorRedirect('oauth_failed'));
      }

      // Get user profile
      const profile = await githubOAuthService.getUserProfile(accessToken);
      if (!profile) {
        return res.redirect(oauthErrorRedirect('oauth_failed'));
      }

      // Process user with GitHub OAuth service
      const user = await githubOAuthService.processUser(profile);

      if (!user) {
        return res.redirect(oauthErrorRedirect('oauth_failed'));
      }

      if (user.status !== 'active') {
        return res.redirect(pendingApprovalRedirect());
      }

      // Issue a revocable session-bound JWT
      const token = await authService.issueSession(user, {
        kind: 'oauth:github',
        ip: getClientIp(req),
        userAgent: req.headers['user-agent'],
      });
      void recordAuditEvent({
        action: 'auth.login',
        result: 'success',
        actorUserId: user.id,
        ipHash: hashClientIp(getClientIp(req)),
        details: { method: 'oauth:github' },
      });

      logger.debug('GitHub OAuth successful for user:', user.username);

      setOAuthSessionCookie(req, res, token);
      res.redirect(frontendRedirect('?auth=success'));
    } catch (error) {
      logger.error('GitHub OAuth callback error:', error);
      res.redirect(oauthErrorRedirect('oauth_failed'));
    }
  }
);

/**
 * Check if GitHub OAuth is configured
 */
router.get('/oauth/github/status', generalAuthRateLimiter, (req, res) => {
  res.json({ configured: isGitHubConfigured });
});

/**
 * Hugging Face OAuth Routes
 * These routes integrate Hugging Face OAuth with the existing JWT authentication system
 */

// Hugging Face OAuth setup if credentials are provided
const isHuggingFaceConfigured = huggingFaceOAuthService.isConfigured();

/**
 * Hugging Face OAuth - Start authentication
 */
router.get('/oauth/huggingface', generalAuthRateLimiter, (req, res) => {
  if (!isHuggingFaceConfigured) {
    return res.status(404).json({ error: 'Hugging Face OAuth not configured' });
  }

  const state = beginOAuthFlow(req, res, 'huggingface');
  const authUrl = huggingFaceOAuthService.getAuthUrl(state);
  res.redirect(authUrl);
});

/**
 * Hugging Face OAuth - Handle callback and generate JWT
 */
router.get(
  '/oauth/huggingface/callback',
  generalAuthRateLimiter,
  async (req, res) => {
    try {
      if (!isHuggingFaceConfigured) {
        return res.redirect(oauthErrorRedirect('oauth_not_configured'));
      }

      const { code, state } = req.query;
      const stateIsValid = consumeOAuthState(
        req,
        res,
        'huggingface',
        typeof state === 'string' ? state : ''
      );

      if (!code || typeof code !== 'string' || !stateIsValid) {
        return res.redirect(oauthErrorRedirect('oauth_failed'));
      }

      // Exchange code for access token
      const accessToken =
        await huggingFaceOAuthService.exchangeCodeForToken(code);
      if (!accessToken) {
        return res.redirect(oauthErrorRedirect('oauth_failed'));
      }

      // Get user profile
      const profile = await huggingFaceOAuthService.getUserProfile(accessToken);
      if (!profile) {
        return res.redirect(oauthErrorRedirect('oauth_failed'));
      }

      // Process user with Hugging Face OAuth service
      const user = await huggingFaceOAuthService.processUser(profile);

      if (!user) {
        return res.redirect(oauthErrorRedirect('oauth_failed'));
      }

      if (user.status !== 'active') {
        return res.redirect(pendingApprovalRedirect());
      }

      // Issue a revocable session-bound JWT
      const token = await authService.issueSession(user, {
        kind: 'oauth:huggingface',
        ip: getClientIp(req),
        userAgent: req.headers['user-agent'],
      });
      void recordAuditEvent({
        action: 'auth.login',
        result: 'success',
        actorUserId: user.id,
        ipHash: hashClientIp(getClientIp(req)),
        details: { method: 'oauth:huggingface' },
      });

      logger.debug('Hugging Face OAuth successful for user:', user.username);

      setOAuthSessionCookie(req, res, token);
      res.redirect(frontendRedirect('?auth=success'));
    } catch (error) {
      logger.error('Hugging Face OAuth callback error:', error);
      res.redirect(oauthErrorRedirect('oauth_failed'));
    }
  }
);

/**
 * Check if Hugging Face OAuth is configured
 */
router.get('/oauth/huggingface/status', generalAuthRateLimiter, (req, res) => {
  res.json({ configured: isHuggingFaceConfigured });
});

/**
 * Generic OIDC - Start authentication (PKCE + state + nonce)
 */
router.get('/oauth/oidc', generalAuthRateLimiter, async (req, res) => {
  if (!oidcOAuthService.isConfigured()) {
    return res.status(404).json({ error: 'OIDC is not configured' });
  }
  try {
    const pkce = oidcOAuthService.createPkcePair();
    const nonce = oidcOAuthService.createNonce();
    const state = beginOAuthFlowWithPayload(req, res, 'oidc', {
      verifier: pkce.verifier,
      nonce,
    });
    const authUrl = await oidcOAuthService.getAuthUrl(
      state,
      nonce,
      pkce.challenge
    );
    res.redirect(authUrl);
  } catch (error) {
    logger.error('OIDC start error:', error);
    res.redirect(oauthErrorRedirect('oauth_failed'));
  }
});

/**
 * Generic OIDC - Handle callback: verify state, exchange with PKCE,
 * validate the ID token against JWKS, then issue a session-bound JWT.
 */
router.get('/oauth/oidc/callback', generalAuthRateLimiter, async (req, res) => {
  try {
    if (!oidcOAuthService.isConfigured()) {
      return res.redirect(oauthErrorRedirect('oauth_not_configured'));
    }
    const { code, state } = req.query;
    const payload = consumeOAuthStatePayload(
      req,
      res,
      'oidc',
      typeof state === 'string' ? state : ''
    );
    if (
      !payload ||
      !payload.verifier ||
      !payload.nonce ||
      !code ||
      typeof code !== 'string'
    ) {
      return res.redirect(oauthErrorRedirect('oauth_failed'));
    }

    const exchanged = await oidcOAuthService.exchangeCode(
      code,
      payload.verifier
    );
    const claims = await oidcOAuthService.verifyIdToken(
      exchanged.idToken,
      payload.nonce
    );
    const user = await oidcOAuthService.processClaims(claims);

    if (user.status !== 'active') {
      return res.redirect(pendingApprovalRedirect());
    }

    const token = await authService.issueSession(user, {
      kind: 'oidc',
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });
    void recordAuditEvent({
      action: 'auth.login',
      result: 'success',
      actorUserId: user.id,
      ipHash: hashClientIp(getClientIp(req)),
      details: { method: 'oidc' },
    });

    setOAuthSessionCookie(req, res, token);
    res.redirect(frontendRedirect('?auth=success'));
  } catch (error) {
    logger.error('OIDC callback error:', error);
    void recordAuditEvent({
      action: 'auth.login',
      result: 'failure',
      ipHash: hashClientIp(getClientIp(req)),
      details: {
        method: 'oidc',
        reason: error instanceof OidcError ? error.code : 'unknown',
      },
    });
    const reason =
      error instanceof OidcError &&
      (error.code === 'registration-disabled' || error.code === 'email-in-use')
        ? error.code.replace(/-/g, '_')
        : 'oauth_failed';
    res.redirect(oauthErrorRedirect(reason));
  }
});

/**
 * Check if generic OIDC is configured (includes the login button label)
 */
router.get('/oauth/oidc/status', generalAuthRateLimiter, (req, res) => {
  const configured = oidcOAuthService.isConfigured();
  res.json({
    configured,
    ...(configured ? { displayName: oidcOAuthService.displayName } : {}),
  });
});

/**
 * Exchange the short-lived HttpOnly OAuth transfer cookie for the application's
 * normal bearer-token response. The cookie is cleared even when it is invalid.
 */
router.post('/oauth/exchange', generalAuthRateLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const token = consumeOAuthSessionCookie(req, res);
  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'OAuth session is missing or expired',
    });
  }

  const user = await authService.getUserFromToken(token);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: 'OAuth session is invalid or expired',
    });
  }

  return res.json({
    success: true,
    data: {
      user,
      token,
      systemInfo: await authService.getSystemInfo(),
    },
  });
});

/**
 * Get current user info (works with both regular JWT and GitHub OAuth JWT).
 * Todo 45: session-aware like /verify — revoked sessions 401 here.
 */
router.get(
  '/me',
  generalAuthRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = await authService.getUserFromToken(
        req.headers.authorization!.substring(7)
      );
      if (!user || user.id !== req.user?.userId) {
        return res.status(401).json({
          success: false,
          message: 'Invalid token',
        });
      }

      res.json({
        success: true,
        data: user,
      });
    } catch (error) {
      logger.error('Get user error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
      });
    }
  }
);

export default router;
