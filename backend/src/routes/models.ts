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

import express, { Request, Response } from 'express';
import {
  authenticate,
  AuthenticatedRequest,
  requireAdmin,
} from '../middleware/auth.js';
import {
  getModelDownloadMode,
  isModelDownloadMode,
  setModelDownloadMode,
  userCanDownloadModels,
} from '../services/modelAccessService.js';
import {
  getHiddenModels,
  getModelMetadata,
  getModelOrder,
  getStarredModels,
  setHiddenModels,
  setModelMetadata,
  setModelOrder,
  setStarredModels,
  type ModelMetadata,
} from '../services/modelVisibilityService.js';
import { userModel } from '../models/userModel.js';
import { ApiResponse, getErrorMessage } from '../types/index.js';

const router = express.Router();
router.use(authenticate);

// Shared model-list curation. Read is open to any authenticated user so every
// interface can apply the same visibility, priority, order, and presentation;
// changes are admin-only.
router.get(
  '/models/visibility',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const [hidden, order, starred, metadata] = await Promise.all([
      getHiddenModels(),
      getModelOrder(),
      getStarredModels(),
      getModelMetadata(),
    ]);
    res.json({ success: true, data: { hidden, order, starred, metadata } });
  }
);

router.put(
  '/models/visibility',
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      // Every field is optional: the catalog saves whichever parts changed.
      const body = (req.body ?? {}) as Record<string, unknown>;
      const hidden =
        body.hidden !== undefined
          ? await setHiddenModels(body.hidden as string[])
          : await getHiddenModels();
      const order =
        body.order !== undefined
          ? await setModelOrder(body.order as string[])
          : await getModelOrder();
      const starred =
        body.starred !== undefined
          ? await setStarredModels(body.starred as string[])
          : await getStarredModels();
      const metadata =
        body.metadata !== undefined
          ? await setModelMetadata(
              body.metadata as Record<string, ModelMetadata>
            )
          : await getModelMetadata();
      res.json({ success: true, data: { hidden, order, starred, metadata } });
    } catch (error: unknown) {
      res.status(400).json({
        success: false,
        error: getErrorMessage(error, 'Invalid model catalog settings'),
      });
    }
  }
);

// Who may manage models. Read is open to any authenticated user so the
// interface can decide whether to offer management affordances; changing the
// mode is admin-only.
router.get(
  '/models/access',
  async (req: AuthenticatedRequest, res: Response) => {
    const currentUser = req.user
      ? await userModel.getUserById(req.user.userId)
      : null;
    res.json({
      success: true,
      data: {
        mode: await getModelDownloadMode(),
        allowed: currentUser ? await userCanDownloadModels(currentUser) : false,
      },
    });
  }
);

router.put(
  '/models/access',
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const mode = req.body?.mode;
    if (!isModelDownloadMode(mode)) {
      res.status(400).json({
        success: false,
        error: 'mode must be "admins" or "all-users".',
      });
      return;
    }
    await setModelDownloadMode(mode);
    res.json({ success: true, data: { mode: await getModelDownloadMode() } });
  }
);

export default router;
