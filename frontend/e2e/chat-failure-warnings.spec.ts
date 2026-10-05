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

import { expect, test, type Page } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';

const providerPlugin = {
  id: 'e2e-provider',
  name: 'E2E Provider',
  type: 'chat' as const,
  endpoint: 'http://127.0.0.1:1/v1',
  auth: { header: 'Authorization', key_env: 'E2E_KEY', prefix: 'Bearer ' },
  model_map: ['e2e-chat-model'],
  active: true,
};

async function setupFailure(
  page: Page,
  sessionId: string,
  extra: NonNullable<Parameters<typeof mockLibreWebUiApi>[1]>
) {
  await mockLibreWebUiApi(page, {
    sessions: [
      {
        id: sessionId,
        title: 'Failure warnings',
        model: 'e2e-chat-model',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      },
    ],
    plugins: [providerPlugin],
    ...extra,
  });
  await page.goto(`/c/${sessionId}`);
  await page.waitForLoadState('networkidle');
  const input = page.locator('textarea[rows="1"][dir="auto"]');
  await input.fill('Trigger the failure path.');
  await input.press('Enter');
}

async function proveToast(page: Page, copy: string, shot: string) {
  const toast = page.getByText(copy);
  await expect(toast).toBeVisible();
  await page.screenshot({ path: `test-results/failure-warnings/${shot}.png` });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('auth-token', 'e2e-token');
  });
});

test('budget 429 names the weekly reset time', async ({ page }) => {
  await setupFailure(page, 'budget-session', {
    generationFailure: {
      status: 429,
      body: {
        success: false,
        message:
          'The "Cap" budget is exhausted for this period; new generations are paused',
        period: 'weekly',
      },
    },
  });
  await proveToast(
    page,
    'Weekly budget spent — new chats pause until Monday 00:00 UTC.',
    'rate-limited-reset'
  );
});

test('unverified 403 points at the inbox and Portal profile', async ({
  page,
}) => {
  await setupFailure(page, 'unverified-session', {
    generationFailure: {
      status: 403,
      body: {
        success: false,
        message: 'email_unverified for this API key',
      },
    },
  });
  await proveToast(
    page,
    'Verify your email to unlock AI replies',
    'unverified-email'
  );
});

test('pending approval names the administrator', async ({ page }) => {
  await setupFailure(page, 'pending-session', {
    generationFailure: {
      status: 403,
      body: {
        success: false,
        code: 'ACCOUNT_PENDING',
        message: 'Your account is waiting for administrator approval',
      },
    },
  });
  await proveToast(
    page,
    'waiting for administrator approval',
    'account-pending'
  );
});

test('model-unavailable failure offers another model', async ({ page }) => {
  await setupFailure(page, 'model-session', {
    chatStream: {
      chunks: [],
      failWith: {
        error: 'The chat response could not be completed',
        code: 'chat-generation-model-unavailable',
      },
    },
  });
  await proveToast(
    page,
    "isn't available right now — pick another model and retry.",
    'model-unavailable'
  );
});

test('upstream cut failure hints retry', async ({ page }) => {
  await setupFailure(page, 'upstream-session', {
    chatStream: {
      chunks: [],
      failWith: {
        error: 'The chat response could not be completed',
        code: 'chat-generation-upstream-incomplete',
      },
    },
  });
  await proveToast(page, 'cut off before finishing — retry.', 'upstream-cut');
});

test('unknown failure points at the support path', async ({ page }) => {
  await setupFailure(page, 'unknown-session', {
    chatStream: {
      chunks: [],
      failWith: {
        error: 'The chat response could not be completed',
        code: 'chat-generation-failed',
      },
    },
  });
  await proveToast(
    page,
    'if it keeps happening report it from Settings > About > GitHub issues.',
    'unknown-support'
  );
});

test('provider rate limit shows the quota copy', async ({ page }) => {
  await setupFailure(page, 'ratelimit-session', {
    chatStream: {
      chunks: [],
      failWith: {
        error: 'Rate limited by the provider',
        code: 'chat-generation-rate-limited',
      },
    },
  });
  await proveToast(
    page,
    'Daily budget spent — new chats pause until the quota resets.',
    'rate-limited-generic'
  );
});
