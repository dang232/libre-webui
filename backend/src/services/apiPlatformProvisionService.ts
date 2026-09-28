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
 * Auto base-usage provisioning for the ALcore API platform (plan Wave4
 * task 19 flowfix-autobase).
 *
 * A fresh Libre account must be able to chat through the API platform with
 * zero configuration and zero Ollama involvement. The chat transport
 * already exists: the bundled `alcore` plugin (OpenAI-compatible,
 * `default-chat` alias) executes server-side with a per-user encrypted
 * credential. This service closes the remaining gap — minting that
 * credential automatically at signup/first-login:
 *
 * bridge-resolve (creates a tier:free customer on 0-match, Waves 2-3) →
 * create a `libre-auto` customer key through the lane-19 customer service
 * (user session in, management key attached server-side) → store the full
 * secret with `pluginCredentialsService.setApiKey` (AES-256-GCM at rest,
 * routing-fingerprint-bound, never leaves the server, never logged) →
 * activate the bundled plugin for the user → set the platform default
 * model preference when neither the user nor the operator set one.
 *
 * Routing stays on the manifest default (`https://alcore.io.vn/v1`): this
 * service deliberately never writes per-user connection variables
 * (`base_url`/`endpoint`). Stored connection overrides are an
 * admin-only capability by design (non-admin route overrides are ignored
 * at read time as SSRF defense), so a per-user override would silently
 * apply to nobody but admins. A self-hosted TokenPanel domain for every
 * user needs an operator-level provider-route mechanism — tracked as a
 * follow-up, not invented here; administrators can still set their own
 * override in Settings, which composes with the provisioned credential.
 *
 * Best-effort by design: this runs fire-and-forget from session issuance
 * and NEVER throws into auth. Without an email (signup email is optional
 * and the bridge resolves by authUserId/email), without TokenPanel
 * configured, or when TokenPanel is unreachable, the user keeps today's
 * behavior (Ollama opt-in / manual providers). Failures are logged with
 * statuses and key ids only — key material never appears in logs.
 *
 * No billing, settlement, or quota logic lives here: packages and the free
 * tier are server-authoritative in TokenPanel (intent + server-side only).
 */

import { userModel } from '../models/userModel.js';
import pluginService from './pluginService.js';
import pluginCredentialsService from './pluginCredentialsService.js';
import preferencesService, {
  instanceDefaultModel,
} from './preferencesService.js';
import storageService from '../storage.js';
import {
  TokenpanelCustomerError,
  callTokenpanelAsCustomer,
} from './tokenpanelCustomerService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:api-platform-provision');

export const API_PLATFORM_PLUGIN_ID = 'alcore';
export const API_PLATFORM_DEFAULT_MODEL = 'default-chat';
export const API_PLATFORM_KEY_NAME = 'libre-auto';

export interface ApiPlatformProvisionResult {
  provisioned: boolean;
  reason: string;
}

const bridgeConfigured = (): boolean =>
  (process.env.TOKENPANEL_MGMT_KEY || '').trim().length > 0;

/** Collapse same-process concurrent logins into one provisioning attempt. */
const inflight = new Map<string, Promise<ApiPlatformProvisionResult>>();

const asRecord = (body: unknown): Record<string, unknown> =>
  typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)
    : {};

const ensurePluginActive = async (userId: string): Promise<boolean> => {
  try {
    const active = await pluginService.getActivePlugins(userId);
    if (active.some(plugin => plugin.id === API_PLATFORM_PLUGIN_ID)) {
      return true;
    }
    await pluginService.activatePlugin(API_PLATFORM_PLUGIN_ID, userId);
    return true;
  } catch (error) {
    logger.warn('API Platform plugin activation failed', {
      userId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
};

const ensurePlatformDefault = async (userId: string): Promise<void> => {
  try {
    // Ensure the preferences row exists (auto-initializes on first read)
    // before the raw explicit-default check below: updatePreferences
    // requires an existing resource owner.
    await preferencesService.getPreferences(userId);
    const stored = await storageService.getPreferences(userId);
    if (
      typeof stored?.defaultModel === 'string' &&
      stored.defaultModel.trim() !== ''
    ) {
      return;
    }
    // An operator-provided DEFAULT_MODEL fills the slot instead; a saved
    // choice always wins over this automatic default.
    if (instanceDefaultModel() !== '') {
      return;
    }
    await preferencesService.setDefaultModel(
      API_PLATFORM_DEFAULT_MODEL,
      userId,
      { providerType: 'plugin', providerId: API_PLATFORM_PLUGIN_ID }
    );
  } catch (error) {
    logger.warn('API Platform default-model preference failed', {
      userId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
};

const provision = async (
  userId: string
): Promise<ApiPlatformProvisionResult> => {
  if (!bridgeConfigured()) {
    return { provisioned: false, reason: 'bridge-not-configured' };
  }

  const user = await userModel.getUserById(userId);
  if (!user) {
    return { provisioned: false, reason: 'account-not-found' };
  }
  if ((user.email || '').trim() === '') {
    // The bridge resolves by authUserId/email; without an email there is no
    // customer to attach the platform key to. The user keeps the manual
    // path until an email is added (next login retries automatically).
    return { provisioned: false, reason: 'no-email' };
  }

  const plugin = await pluginService.getPlugin(API_PLATFORM_PLUGIN_ID);
  if (!plugin) {
    return { provisioned: false, reason: 'no-bundled-plugin' };
  }

  const credentials = await pluginCredentialsService.getCredentials(userId);
  const hasCredential = credentials.some(
    entry => entry.plugin_id === API_PLATFORM_PLUGIN_ID && entry.has_api_key
  );
  if (hasCredential) {
    await ensurePluginActive(userId);
    await ensurePlatformDefault(userId);
    return { provisioned: true, reason: 'already-provisioned' };
  }

  let upstream: { status: number; body: unknown };
  try {
    upstream = await callTokenpanelAsCustomer(userId, '/keys', {
      method: 'POST',
      body: { name: API_PLATFORM_KEY_NAME },
      idempotencyKey: `api-platform-provision:${userId}`,
    });
  } catch (error) {
    if (error instanceof TokenpanelCustomerError) {
      logger.warn('API Platform key mint failed (bridge)', {
        userId,
        status: error.status,
      });
      return { provisioned: false, reason: `bridge-status-${error.status}` };
    }
    throw error;
  }
  if (upstream.status !== 200 && upstream.status !== 201) {
    logger.warn('API Platform key mint denied upstream', {
      userId,
      status: upstream.status,
    });
    return { provisioned: false, reason: `key-status-${upstream.status}` };
  }
  const created = asRecord(upstream.body);
  const secret = created.key;
  if (typeof secret !== 'string' || secret === '') {
    // The mint response can carry credential material, so log only the
    // outcome and never a key-derived value.
    logger.warn('API Platform key mint returned no usable secret', {
      userId,
    });
    return { provisioned: false, reason: 'key-malformed' };
  }

  // The routing fingerprint binds the stored credential to the exact route
  // in effect (manifest default, plus any admin connection override the
  // caller already has): a later route change rejects the old credential
  // instead of sending it somewhere unexpected.
  const fingerprint = await pluginService.getCredentialRoutingAuthFingerprint(
    plugin,
    userId
  );
  const stored = await pluginCredentialsService.setApiKey(
    API_PLATFORM_PLUGIN_ID,
    secret,
    userId,
    fingerprint
  );
  if (!stored) {
    logger.warn('API Platform credential store failed', { userId });
    return { provisioned: false, reason: 'credential-store-failed' };
  }

  const active = await ensurePluginActive(userId);
  await ensurePlatformDefault(userId);
  logger.info('API Platform base usage provisioned', {
    userId,
    active,
  });
  return {
    provisioned: true,
    reason: active ? 'provisioned' : 'provisioned-activation-pending',
  };
};

/**
 * Idempotent, never-throwing entry point for the auth session path. Safe to
 * call on every login: provisioned users cost one masked credential listing
 * and zero TokenPanel calls.
 */
export const ensureApiPlatformProvision = (
  userId: string
): Promise<ApiPlatformProvisionResult> => {
  const pending = inflight.get(userId);
  if (pending) return pending;
  const run = provision(userId)
    .catch((error: unknown) => {
      logger.warn('API Platform provisioning failed', {
        userId,
        error: error instanceof Error ? error.message : 'unknown',
      });
      return { provisioned: false, reason: 'unexpected' };
    })
    .finally(() => {
      inflight.delete(userId);
    });
  inflight.set(userId, run);
  return run;
};
