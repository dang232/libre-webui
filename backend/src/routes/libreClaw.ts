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
import { authenticate, requireAdmin } from '../middleware/auth.js';
import {
  agentsEnabledLockedByEnv,
  getAgentsEnabled,
  setAgentsEnabled,
} from '../services/agentAccessService.js';
import alcoreClawService, {
  AlcoreClawPermissionResolution,
  AlcoreClawRunRequest,
  AlcoreClawServiceError,
} from '../services/alcoreClawService.js';
import { ApiResponse } from '../types/index.js';

const router = express.Router();

router.use(authenticate, requireAdmin);

/**
 * The Agents feature toggle. Reachable while the feature is disabled —
 * this is how an administrator turns it on. Everything below the gate
 * requires the feature to be enabled.
 */
router.get('/access', async (_req: Request, res: Response): Promise<void> => {
  sendSuccess(res, {
    enabled: await getAgentsEnabled(),
    lockedByEnv: agentsEnabledLockedByEnv(),
  });
});

router.put('/access', async (req: Request, res: Response): Promise<void> => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({
      success: false,
      error: 'enabled must be a boolean.',
    } satisfies ApiResponse);
    return;
  }
  if (agentsEnabledLockedByEnv()) {
    res.status(409).json({
      success: false,
      error:
        'The Agents feature is pinned by AGENT_CLI_MODELS_ENABLED; unset the environment variable to manage it here.',
    } satisfies ApiResponse);
    return;
  }
  await setAgentsEnabled(enabled);
  sendSuccess(res, {
    enabled: await getAgentsEnabled(),
    lockedByEnv: false,
  });
});

router.use(async (_req: Request, res: Response, next): Promise<void> => {
  if (!(await getAgentsEnabled())) {
    res.status(403).json({
      success: false,
      error: 'The Agents feature is disabled on this server.',
    } satisfies ApiResponse);
    return;
  }
  next();
});

router.get('/status', async (_req: Request, res: Response): Promise<void> => {
  const status = await alcoreClawService.status();
  sendSuccess(res, status);
});

router.get('/health', async (_req: Request, res: Response): Promise<void> => {
  await sendAlcoreClaw(res, () => alcoreClawService.health());
});

router.get('/dashboard', (_req: Request, res: Response): void => {
  sendSuccess(res, { url: alcoreClawService.dashboardUrl() });
});

router.get(
  '/config/model',
  async (_req: Request, res: Response): Promise<void> => {
    await sendAlcoreClaw(res, () => alcoreClawService.currentModel());
  }
);

router.patch(
  '/config/model',
  async (req: Request, res: Response): Promise<void> => {
    await sendAlcoreClaw(res, () =>
      alcoreClawService.updateModel({
        provider: String(req.body?.provider || '').trim(),
        model: String(req.body?.model || '').trim(),
        persist_global: Boolean(req.body?.persist_global),
      })
    );
  }
);

router.get(
  '/config/fallback',
  async (_req: Request, res: Response): Promise<void> => {
    await sendAlcoreClaw(res, () => alcoreClawService.currentFallback());
  }
);

router.patch(
  '/config/fallback',
  async (req: Request, res: Response): Promise<void> => {
    await sendAlcoreClaw(res, () =>
      alcoreClawService.updateFallback(req.body || {})
    );
  }
);

router.patch(
  '/config/theme',
  async (req: Request, res: Response): Promise<void> => {
    await sendAlcoreClaw(res, () =>
      alcoreClawService.updateTheme({
        theme: String(req.body?.theme || '').trim(),
        persist_global: req.body?.persist_global !== false,
      })
    );
  }
);

router.get('/runs', async (req: Request, res: Response): Promise<void> => {
  await sendAlcoreClaw(res, () =>
    alcoreClawService.listRuns(readLimit(req, 20, 100))
  );
});

router.post('/runs', async (req: Request, res: Response): Promise<void> => {
  const payload = req.body as Partial<AlcoreClawRunRequest>;
  await sendAlcoreClaw(
    res,
    () =>
      alcoreClawService.startRun({
        message: String(payload?.message || '').trim(),
        kind: payload?.kind === 'goal' ? 'goal' : 'chat',
        provider: cleanOptionalString(payload?.provider),
        model: cleanOptionalString(payload?.model),
        surface: 'alcore',
        session: payload?.session,
        attachments: payload?.attachments,
      }),
    202
  );
});

router.get(
  '/runs/:runId',
  async (req: Request, res: Response): Promise<void> => {
    await sendAlcoreClaw(res, () =>
      alcoreClawService.getRun(readParam(req, 'runId'))
    );
  }
);

router.get(
  '/runs/:runId/events',
  async (req: Request, res: Response): Promise<void> => {
    await sendAlcoreClaw(res, () =>
      alcoreClawService.getEvents(readParam(req, 'runId'), readAfter(req))
    );
  }
);

router.post(
  '/runs/:runId/cancel',
  async (req: Request, res: Response): Promise<void> => {
    await sendAlcoreClaw(res, () =>
      alcoreClawService.cancelRun(readParam(req, 'runId'))
    );
  }
);

router.post(
  '/runs/:runId/permissions/:toolCallId',
  async (req: Request, res: Response): Promise<void> => {
    const resolution = String(req.body?.resolution || 'deny');
    const payload: AlcoreClawPermissionResolution = {
      resolution: isPermissionResolution(resolution) ? resolution : 'deny',
    };
    await sendAlcoreClaw(res, () =>
      alcoreClawService.resolvePermission(
        readParam(req, 'runId'),
        readParam(req, 'toolCallId'),
        payload
      )
    );
  }
);

router.get('/usage', async (req: Request, res: Response): Promise<void> => {
  await sendAlcoreClaw(res, () =>
    alcoreClawService.usage(
      String(req.query.provider || '').trim(),
      readLimit(req, 250, 1000)
    )
  );
});

router.get(
  '/automations',
  async (req: Request, res: Response): Promise<void> => {
    await sendAlcoreClaw(res, () =>
      alcoreClawService.listAutomations(readLimit(req, 50, 200))
    );
  }
);

router.post(
  '/automations',
  async (req: Request, res: Response): Promise<void> => {
    await sendAlcoreClaw(
      res,
      () => alcoreClawService.createAutomation(req.body || {}),
      201
    );
  }
);

router.get(
  '/automations/:automationId',
  async (req: Request, res: Response): Promise<void> => {
    await sendAlcoreClaw(res, () =>
      alcoreClawService.getAutomation(readParam(req, 'automationId'))
    );
  }
);

router.patch(
  '/automations/:automationId',
  async (req: Request, res: Response): Promise<void> => {
    await sendAlcoreClaw(res, () =>
      alcoreClawService.updateAutomation(
        readParam(req, 'automationId'),
        req.body || {}
      )
    );
  }
);

router.put(
  '/automations/:automationId',
  async (req: Request, res: Response): Promise<void> => {
    await sendAlcoreClaw(res, () =>
      alcoreClawService.updateAutomation(
        readParam(req, 'automationId'),
        req.body || {}
      )
    );
  }
);

router.post(
  '/automations/:automationId/pause',
  async (req: Request, res: Response): Promise<void> => {
    await sendAlcoreClaw(res, () =>
      alcoreClawService.pauseAutomation(readParam(req, 'automationId'))
    );
  }
);

router.post(
  '/automations/:automationId/resume',
  async (req: Request, res: Response): Promise<void> => {
    await sendAlcoreClaw(res, () =>
      alcoreClawService.resumeAutomation(readParam(req, 'automationId'))
    );
  }
);

router.post(
  '/automations/:automationId/run',
  async (req: Request, res: Response): Promise<void> => {
    await sendAlcoreClaw(res, () =>
      alcoreClawService.runAutomationNow(readParam(req, 'automationId'))
    );
  }
);

router.delete(
  '/automations/:automationId',
  async (req: Request, res: Response): Promise<void> => {
    await sendAlcoreClaw(res, () =>
      alcoreClawService.deleteAutomation(readParam(req, 'automationId'))
    );
  }
);

const sendAlcoreClaw = async <T>(
  res: Response<ApiResponse<T>>,
  action: () => Promise<T>,
  successStatus = 200
): Promise<void> => {
  try {
    const data = await action();
    res.status(successStatus).json({ success: true, data });
  } catch (error) {
    const status = error instanceof AlcoreClawServiceError ? error.status : 500;
    const message =
      error instanceof Error ? error.message : 'Alcore Claw request failed';
    res.status(status).json({
      success: false,
      error: message,
    });
  }
};

const sendSuccess = <T>(res: Response<ApiResponse<T>>, data: T): void => {
  res.json({ success: true, data });
};

const readLimit = (req: Request, fallback: number, max: number): number => {
  const raw = Number(req.query.limit);
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(raw)));
};

const readAfter = (req: Request): number => {
  const raw = Number(req.query.after);
  if (!Number.isFinite(raw)) {
    return 0;
  }
  return Math.max(0, Math.floor(raw));
};

const readParam = (req: Request, name: string): string =>
  String(req.params[name] || '').trim();

const cleanOptionalString = (value: unknown): string | undefined => {
  const cleaned = String(value || '').trim();
  return cleaned || undefined;
};

const isPermissionResolution = (
  value: string
): value is AlcoreClawPermissionResolution['resolution'] =>
  value === 'allow_once' ||
  value === 'deny' ||
  value === 'always_allow_tool' ||
  value === 'always_allow_call';

export default router;
