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
 * TokenPanel billing BFF routes — intent-only (todo 21).
 *
 * The browser calls these with the Libre user session only; the management
 * key and the short-lived TokenPanel viewer JWT never leave the server (see
 * `tokenpanelBillingService.ts`). Settlement stays server-side: recharge
 * completion is recorded by the payment saga / webhook receipts, redeem
 * crediting by `redeemCode` — this router performs no ledger or balance
 * writes of its own.
 */

import express from 'express';
import rateLimit from '../middleware/sharedRateLimit.js';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import {
  TokenpanelBillingError,
  cancelTopupIntent,
  createTopupIntent,
  getBillingHistory,
  getTopupIntent,
  listInvoices,
  listTopupIntents,
  redeemVoucher,
} from '../services/tokenpanelBillingService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('routes:tokenpanel-billing');
const router = express.Router();

// Billing reads share one generous bucket; writes keep the bridge's
// one-mint-per-visit budget so QR polling cannot starve sign-in traffic.
const billingReadLimiter = rateLimit({
  keyPrefix: 'tokenpanel-billing-read',
  windowMs: 5 * 60 * 1000,
  max: 120,
  message: {
    success: false,
    message: 'Too many billing requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const billingWriteLimiter = rateLimit({
  keyPrefix: 'tokenpanel-billing-write',
  windowMs: 5 * 60 * 1000,
  max: 30,
  message: {
    success: false,
    message: 'Too many billing requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(billingReadLimiter, authenticate);

const fail = (
  res: express.Response,
  error: unknown,
  fallback: string
): void => {
  if (error instanceof TokenpanelBillingError) {
    if (error.status === 500 || error.status >= 502) {
      logger.error(fallback, error);
    }
    const body: Record<string, unknown> = {
      success: false,
      message: error.message,
    };
    // Surface the upstream denial code so the UI can explain expired QRs
    // and redeemed codes without inventing its own reasons.
    res.status(error.status).json(body);
    return;
  }
  logger.error(fallback, error);
  res.status(500).json({ success: false, message: fallback });
};

const userIdOf = (req: AuthenticatedRequest): string | null =>
  req.user?.userId ?? null;

/** GET /api/tokenpanel/billing/history — balance history, newest first. */
router.get('/billing/history', async (req: AuthenticatedRequest, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = userIdOf(req);
  if (!userId) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  try {
    const data = await getBillingHistory(userId, {
      limit: req.query.limit,
      skip: req.query.skip,
    });
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Failed to load billing history');
  }
});

/** GET /api/tokenpanel/billing/invoices — own invoices, newest first. */
router.get('/billing/invoices', async (req: AuthenticatedRequest, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = userIdOf(req);
  if (!userId) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  try {
    const data = await listInvoices(userId, {
      limit: req.query.limit,
      skip: req.query.skip,
    });
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Failed to load invoices');
  }
});

/** GET /api/tokenpanel/billing/topup-intents — own recharge intents. */
router.get('/billing/topup-intents', async (req: AuthenticatedRequest, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = userIdOf(req);
  if (!userId) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  try {
    const data = await listTopupIntents(userId, {
      limit: req.query.limit,
      skip: req.query.skip,
    });
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Failed to load top-up intents');
  }
});

/** GET /api/tokenpanel/billing/topup-intents/:id — reopen a pending QR view. */
router.get(
  '/billing/topup-intents/:id',
  async (req: AuthenticatedRequest, res) => {
    res.set('Cache-Control', 'no-store');
    const userId = userIdOf(req);
    if (!userId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }
    try {
      const data = await getTopupIntent(userId, String(req.params.id));
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Failed to load top-up intent');
    }
  }
);

/**
 * POST /api/tokenpanel/billing/topup-intents — create a recharge intent.
 * Body: `{ amountMicros: <positive integer> }`. The response carries the
 * server-issued intent incl. QR payload and `qrExpiresAt` TTL verbatim.
 */
router.post(
  '/billing/topup-intents',
  billingWriteLimiter,
  async (req: AuthenticatedRequest, res) => {
    res.set('Cache-Control', 'no-store');
    const userId = userIdOf(req);
    if (!userId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }
    try {
      const data = await createTopupIntent(userId, {
        amountMicros: req.body?.amountMicros,
        ...(typeof req.headers['idempotency-key'] === 'string'
          ? { idempotencyKey: req.headers['idempotency-key'] }
          : {}),
      });
      res.status(201).json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Failed to create top-up intent');
    }
  }
);

/** POST /api/tokenpanel/billing/topup-intents/:id/cancel — cancel pending. */
router.post(
  '/billing/topup-intents/:id/cancel',
  billingWriteLimiter,
  async (req: AuthenticatedRequest, res) => {
    res.set('Cache-Control', 'no-store');
    const userId = userIdOf(req);
    if (!userId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }
    try {
      const data = await cancelTopupIntent(
        userId,
        String(req.params.id),
        typeof req.headers['idempotency-key'] === 'string'
          ? req.headers['idempotency-key']
          : undefined
      );
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Failed to cancel top-up intent');
    }
  }
);

/**
 * POST /api/tokenpanel/billing/redeem — redeem a voucher code.
 * Body: `{ code: <string> }`. Crediting happens TokenPanel-side; the
 * response `{ ok, credited: { amountMicros, currency } }` is server-computed.
 */
router.post(
  '/billing/redeem',
  billingWriteLimiter,
  async (req: AuthenticatedRequest, res) => {
    res.set('Cache-Control', 'no-store');
    const userId = userIdOf(req);
    if (!userId) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }
    try {
      const data = await redeemVoucher(userId, {
        code: req.body?.code,
        ...(typeof req.headers['idempotency-key'] === 'string'
          ? { idempotencyKey: req.headers['idempotency-key'] }
          : {}),
      });
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Failed to redeem code');
    }
  }
);

export default router;
