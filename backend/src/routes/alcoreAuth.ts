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

/**
 * Direct Auth relying-party routes (todo 45), mounted at /api/auth/alcore.
 *
 * - GET /config: public Auth endpoint/advertisement for the sign-in panel.
 * - POST /exchange: redeems an opaque Auth product code (from the Bearer
 *   handoff `POST /oidc/exchange` or the redirect handoff
 *   `GET /oidc/exchange/redirect`) for a Libre product session.
 *
 * Alcore-mode-only: in local self-hosted mode every route here returns 404
 * ALCORE_AUTH_ONLY (symmetric to the todo-41 local-issuance gate), so local
 * mode stays explicit and isolated. `lwk_*` presented here is rejected with
 * 403 TOKEN_SCOPE and never yields a session.
 */

import express from 'express';
import rateLimit from '../middleware/sharedRateLimit.js';
import {
  ALCORE_ONLY_CODE,
  getAuthMode,
  isAlcoreAuthMode,
} from '../config/authMode.js';
import {
  AlcoreAuthError,
  getAlcoreAuthIssuer,
  getAlcoreAuthUrl,
  signInWithAuthCode,
} from '../services/alcoreAuthService.js';
import { looksLikeApiToken } from '../services/apiTokenService.js';
import { authService } from '../services/authService.js';
import {
  hashClientIp,
  recordAuditEvent,
} from '../services/securityAuditService.js';
import { createLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createLogger('routes:alcore-auth');

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

// Public code-redemption surface (Auth codes are guessable until redeemed
// single-use at Auth): strict bucket, same posture as the local credential
// endpoints. Every response carries no-store (a code, assertion, or session
// must never sit in a cache).
const exchangeRateLimiter = rateLimit({
  keyPrefix: 'auth-alcore-exchange',
  windowMs: 5 * 60 * 1000,
  max: 30,
  message: {
    success: false,
    message: 'Too many Auth sign-in attempts, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Alcore-mode-only gate: local self-hosted mode stays isolated. */
router.use(
  (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): void => {
    res.set('Cache-Control', 'no-store');
    if (!isAlcoreAuthMode()) {
      res.status(404).json({
        success: false,
        code: ALCORE_ONLY_CODE,
        message: 'Auth sign-in is not enabled on this server',
      });
      return;
    }
    next();
  }
);

/** Public Auth endpoint advertisement for the sign-in panel. No identity. */
router.get('/config', (req, res) => {
  res.json({
    success: true,
    data: {
      authUrl: getAlcoreAuthUrl(),
      issuer: getAlcoreAuthIssuer(),
      mode: getAuthMode(),
    },
  });
});

const MAX_CODE_CHARS = 1024;
const MAX_REDIRECT_URI_CHARS = 2048;
const MAX_STATE_CHARS = 512;

/**
 * Redeem an opaque Auth product code for a Libre product session.
 * Body: { code, redirectUri?, state? }. Bound (redirect-handoff) codes must
 * carry the exact redirect_uri + state Auth bound; unbound (bearer-handoff)
 * codes carry the code alone. Failures are generic (no oracle); only the
 * email-collision manual-link case surfaces a distinct 409.
 */
router.post('/exchange', exchangeRateLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const authorization = req.headers.authorization;
  if (
    typeof authorization === 'string' &&
    authorization.startsWith('Bearer ') &&
    looksLikeApiToken(authorization.substring(7))
  ) {
    // Product API tokens never sign in: a code is the only credential here.
    res.status(403).json({
      success: false,
      code: 'TOKEN_SCOPE',
      message: 'API tokens cannot sign in with Auth',
    });
    return;
  }

  const { code, redirectUri, state } = req.body ?? {};
  if (
    typeof code !== 'string' ||
    code.length === 0 ||
    code.length > MAX_CODE_CHARS
  ) {
    res.status(400).json({
      success: false,
      message: 'An Auth code is required',
    });
    return;
  }
  if (
    (redirectUri !== undefined &&
      (typeof redirectUri !== 'string' ||
        redirectUri.length === 0 ||
        redirectUri.length > MAX_REDIRECT_URI_CHARS)) ||
    (state !== undefined &&
      (typeof state !== 'string' || state.length > MAX_STATE_CHARS))
  ) {
    res.status(400).json({
      success: false,
      message: 'The Auth handoff binding is invalid',
    });
    return;
  }
  // Bound (redirect-handoff) codes must carry their state: Auth skips the
  // state hash check when the incoming state is '' (store.ts:433), and the
  // service coerces an omitted state to '' — so without this guard a bound
  // code redeems with redirectUri alone. Fail closed before any Auth call.
  if (
    redirectUri !== undefined &&
    (typeof state !== 'string' ||
      state.length === 0 ||
      state.trim().length === 0 ||
      state.length > MAX_STATE_CHARS)
  ) {
    res.status(400).json({
      success: false,
      message: 'The Auth handoff binding is invalid',
    });
    return;
  }

  try {
    const { user, token } = await signInWithAuthCode(
      {
        code,
        ...(redirectUri !== undefined
          ? { redirectUri, ...(state !== undefined ? { state } : {}) }
          : {}),
      },
      {
        ip: getClientIp(req),
        userAgent: req.headers['user-agent'],
      }
    );
    void recordAuditEvent({
      action: 'auth.alcore.login',
      result: 'success',
      actorUserId: user.id,
      ipHash: hashClientIp(getClientIp(req)),
    });
    res.json({
      success: true,
      data: {
        user,
        token,
        systemInfo: await authService.getSystemInfo(),
      },
    });
  } catch (error) {
    const status = error instanceof AlcoreAuthError ? error.status : 500;
    if (status === 500) logger.error('Auth exchange failed', error);
    void recordAuditEvent({
      action: 'auth.alcore.login',
      result: 'denied',
      ipHash: hashClientIp(getClientIp(req)),
      details: { status },
    });
    res.status(status).json({
      success: false,
      ...(status === 409
        ? { code: 'AUTH_LINK_CONFLICT' }
        : status === 403
          ? { code: 'ACCOUNT_PENDING' }
          : {}),
      message:
        error instanceof AlcoreAuthError
          ? error.message
          : 'Auth sign-in is temporarily unavailable',
    });
  }
});

export default router;
