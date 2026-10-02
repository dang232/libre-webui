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
 * TokenPanel usage BFF routes — read-only display (todo 20).
 *
 * The browser calls these with the Libre user session only; the management
 * key and the short-lived TokenPanel viewer JWT never leave the server (see
 * `tokenpanelUsageService.ts`). Totals are server-computed and pass through
 * verbatim — this router performs no aggregation, settlement, or billing of
 * its own.
 */

import express from 'express';
import rateLimit from '../middleware/sharedRateLimit.js';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import {
  TokenpanelUsageError,
  getUsageDaily,
  getUsageRecords,
  getUsageSummary,
} from '../services/tokenpanelUsageService.js';
import {
  requireBffAuthSession,
  sessionBearerOf,
} from '../services/tokenpanelAuthSessionService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('routes:tokenpanel-usage');
const router = express.Router();

// Usage reads share one bucket well below the bridge mint budget: three
// panel reads (summary + daily + records) cost one portal-token mint each.
const usageReadLimiter = rateLimit({
  keyPrefix: 'tokenpanel-usage-read',
  windowMs: 5 * 60 * 1000,
  max: 120,
  message: {
    success: false,
    message: 'Too many usage requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(usageReadLimiter, authenticate, requireBffAuthSession);

const fail = (
  res: express.Response,
  error: unknown,
  fallback: string
): void => {
  if (error instanceof TokenpanelUsageError) {
    if (error.status >= 502) {
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

const sessionTokenOf = (req: AuthenticatedRequest): string | undefined =>
  sessionBearerOf(req) ?? undefined;

/** GET /api/tokenpanel/usage/summary[?from=&to=] — totals verbatim. */
router.get('/usage/summary', async (req: AuthenticatedRequest, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = userIdOf(req);
  if (!userId) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  try {
    res.json({
      success: true,
      data: await getUsageSummary(
        userId,
        {
          from: req.query.from,
          to: req.query.to,
        },
        sessionTokenOf(req)
      ),
    });
  } catch (error) {
    fail(res, error, 'Failed to load usage summary');
  }
});

/** GET /api/tokenpanel/usage/daily[?from=&to=] — UTC-day buckets verbatim. */
router.get('/usage/daily', async (req: AuthenticatedRequest, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = userIdOf(req);
  if (!userId) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  try {
    res.json({
      success: true,
      data: await getUsageDaily(
        userId,
        {
          from: req.query.from,
          to: req.query.to,
        },
        sessionTokenOf(req)
      ),
    });
  } catch (error) {
    fail(res, error, 'Failed to load daily usage');
  }
});

/**
 * GET /api/tokenpanel/usage/records[?limit=&model=&key=&from=&to=] —
 * newest-first raw records verbatim.
 */
router.get('/usage/records', async (req: AuthenticatedRequest, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = userIdOf(req);
  if (!userId) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  try {
    res.json({
      success: true,
      data: await getUsageRecords(
        userId,
        {
          limit: req.query.limit,
          model: req.query.model,
          key: req.query.key,
          from: req.query.from,
          to: req.query.to,
        },
        sessionTokenOf(req)
      ),
    });
  } catch (error) {
    fail(res, error, 'Failed to load usage records');
  }
});

export default router;
