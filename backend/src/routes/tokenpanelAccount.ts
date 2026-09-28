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
 * TokenPanel account BFF routes — subscriptions, budgets, limits, profile
 * (todo 22).
 *
 * The browser calls these with the Libre user session only; the management
 * key and the short-lived TokenPanel viewer JWT never leave the server (see
 * `tokenpanelAccountService.ts`). Reads and writes persist through the
 * TokenPanel customer self-service API; this router performs no pricing,
 * settlement, or ledger math of its own.
 *
 * An upstream 401 (bad/expired customer JWT) is forwarded as a BFF 401 with
 * zero retries, so the frontend unified invalid-session path (clearToken +
 * AUTH_INVALIDATED_EVENT, single-fire) engages.
 */

import express from 'express';
import rateLimit from '../middleware/sharedRateLimit.js';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import {
  TokenpanelAccountError,
  getBudgets,
  getLimits,
  getProfile,
  getSubscription,
  listPlans,
  subscribePlan,
  updateBudget,
  updateLimits,
  updateProfile,
} from '../services/tokenpanelAccountService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('routes:tokenpanel-account');
const router = express.Router();

const accountReadLimiter = rateLimit({
  keyPrefix: 'tokenpanel-account-read',
  windowMs: 5 * 60 * 1000,
  max: 120,
  message: {
    success: false,
    message: 'Too many account requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const accountWriteLimiter = rateLimit({
  keyPrefix: 'tokenpanel-account-write',
  windowMs: 5 * 60 * 1000,
  max: 30,
  message: {
    success: false,
    message: 'Too many account requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(accountReadLimiter, authenticate);

const fail = (
  res: express.Response,
  error: unknown,
  fallback: string
): void => {
  if (error instanceof TokenpanelAccountError) {
    if (error.status === 500 || error.status >= 502) {
      logger.error(fallback, error);
    }
    res.status(error.status).json({ success: false, message: error.message });
    return;
  }
  logger.error(fallback, error);
  res.status(500).json({ success: false, message: fallback });
};

const userIdOf = (req: AuthenticatedRequest): string | null =>
  req.user?.userId ?? null;

const requireUserId = (
  req: AuthenticatedRequest,
  res: express.Response
): string | null => {
  const userId = userIdOf(req);
  if (!userId) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return null;
  }
  return userId;
};

const idempotencyKeyOf = (req: AuthenticatedRequest): string | undefined => {
  const raw = req.headers['idempotency-key'];
  return typeof raw === 'string' ? raw : undefined;
};

/** GET /api/tokenpanel/account/subscription — active subscription + plan. */
router.get('/account/subscription', async (req: AuthenticatedRequest, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const data = await getSubscription(userId);
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Failed to load subscription');
  }
});

/**
 * POST /api/tokenpanel/account/subscriptions — buy a plan from balance.
 * Body: `{ planId: <24-hex>, billing?: month|quarter|year }`. The cycle
 * total, debit and subscription are server-computed; short balances surface
 * the upstream 402 verbatim.
 */
router.post(
  '/account/subscriptions',
  accountWriteLimiter,
  async (req: AuthenticatedRequest, res) => {
    res.set('Cache-Control', 'no-store');
    const userId = requireUserId(req, res);
    if (!userId) return;
    try {
      const data = await subscribePlan(
        userId,
        {
          planId: req.body?.planId,
          ...(req.body?.billing !== undefined
            ? { billing: req.body.billing }
            : {}),
        },
        idempotencyKeyOf(req)
      );
      res.status(201).json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Failed to subscribe to plan');
    }
  }
);

/** GET /api/tokenpanel/account/plans — plan catalog (prices in micros). */
router.get('/account/plans', async (req: AuthenticatedRequest, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const data = await listPlans();
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Failed to load plans');
  }
});

/** GET /api/tokenpanel/account/budgets — own budgets, micros-exact. */
router.get('/account/budgets', async (req: AuthenticatedRequest, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const data = await getBudgets(userId);
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Failed to load budgets');
  }
});

/**
 * PATCH /api/tokenpanel/account/budgets/:id — update amount/thresholds.
 * Body: `{ amountMicros?: <non-negative integer>, alertThresholds?: <0-100 ints> }`.
 */
router.patch(
  '/account/budgets/:id',
  accountWriteLimiter,
  async (req: AuthenticatedRequest, res) => {
    res.set('Cache-Control', 'no-store');
    const userId = requireUserId(req, res);
    if (!userId) return;
    try {
      const data = await updateBudget(
        userId,
        String(req.params.id),
        {
          ...(req.body?.amountMicros !== undefined
            ? { amountMicros: req.body.amountMicros }
            : {}),
          ...(req.body?.alertThresholds !== undefined
            ? { alertThresholds: req.body.alertThresholds }
            : {}),
        },
        idempotencyKeyOf(req)
      );
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Failed to update budget');
    }
  }
);

/** GET /api/tokenpanel/account/limits — own limits incl. spending cap. */
router.get('/account/limits', async (req: AuthenticatedRequest, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const data = await getLimits(userId);
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Failed to load limits');
  }
});

/**
 * PATCH /api/tokenpanel/account/limits — upsert the spending cap.
 * Body: `{ spendingCap: { maxSpendMicros, windowSeconds } | null }`
 * (null clears). Amounts are integer micros; currency is pinned server-side.
 */
router.patch(
  '/account/limits',
  accountWriteLimiter,
  async (req: AuthenticatedRequest, res) => {
    res.set('Cache-Control', 'no-store');
    const userId = requireUserId(req, res);
    if (!userId) return;
    try {
      const data = await updateLimits(
        userId,
        {
          spendingCap: req.body?.spendingCap,
        },
        idempotencyKeyOf(req)
      );
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Failed to update limits');
    }
  }
);

/** GET /api/tokenpanel/account/profile — own customer profile. */
router.get('/account/profile', async (req: AuthenticatedRequest, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = requireUserId(req, res);
  if (!userId) return;
  try {
    const data = await getProfile(userId);
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Failed to load profile');
  }
});

/**
 * PATCH /api/tokenpanel/account/profile — update name/email.
 * Body: `{ name?: <1-160 chars>, email?: <address> }`. Password changes are
 * not proxied here (credentials belong to Auth Repo C).
 */
router.patch(
  '/account/profile',
  accountWriteLimiter,
  async (req: AuthenticatedRequest, res) => {
    res.set('Cache-Control', 'no-store');
    const userId = requireUserId(req, res);
    if (!userId) return;
    try {
      const data = await updateProfile(
        userId,
        {
          ...(req.body?.name !== undefined ? { name: req.body.name } : {}),
          ...(req.body?.email !== undefined ? { email: req.body.email } : {}),
        },
        idempotencyKeyOf(req)
      );
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Failed to update profile');
    }
  }
);

export default router;
