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

import { expect, test } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';
import { openSettingsModal, selectSettingsTab } from './lib/settingsTab';

/**
 * Workspace billing panels against prod-shaped upstream envelopes.
 *
 * The BFF forwards the TokenPanel JSON verbatim, so daily/records arrive
 * wrapped (`{days: [...]}` / `{items: [...]}`); a panel that demands bare
 * arrays fails every load ("Couldn't load usage"). Likewise a missing
 * subscription (upstream 404, mapped to nulls by the BFF) must render the
 * empty state, not fail the whole Account section.
 */
test('billing panels render envelopes and an empty subscription', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 1,
      signupEnabled: false,
      version: '0.36.0-e2e',
      turnstile: { enabled: false },
    },
    authUsers: [
      {
        id: 'billing-user',
        username: 'billing-user',
        email: 'billing@example.test',
        role: 'user',
        status: 'active',
        token: 'billing-token',
      },
    ],
  });
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'billing-token');
    localStorage.setItem('i18nextLng', 'en');
  });

  const day = {
    day: '2026-10-06',
    requests: 3,
    tokens: 900,
    promptTokens: 700,
    completionTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    avgDurationMs: 800,
    costMicros: 0,
    priceMicros: 12000,
    currency: 'USD',
  };
  const record = {
    id: '6ac441c8363c0d21ff20560e',
    modelAliasId: 'al-1-2',
    apiKeyId: null,
    promptTokens: 700,
    completionTokens: 200,
    tokens: 900,
    costMicros: 0,
    priceMicros: 12000,
    currency: 'USD',
    status: 200,
    durationMs: 800,
    occurredAt: '2026-10-06T00:33:05.844Z',
  };
  await page.route('**/api/tokenpanel/**', async route => {
    const url = route.request().url();
    const respond = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    if (url.includes('/usage/summary')) {
      await respond(200, {
        success: true,
        data: {
          totalRequests: 3,
          totalTokens: 900,
          totalCostMicros: 0,
          totalPriceMicros: 12000,
          currency: 'USD',
          byModel: [],
        },
      });
      return;
    }
    if (url.includes('/usage/daily')) {
      await respond(200, { success: true, data: { days: [day] } });
      return;
    }
    if (url.includes('/usage/records')) {
      await respond(200, { success: true, data: { items: [record] } });
      return;
    }
    if (url.includes('/account/subscription')) {
      await respond(200, {
        success: true,
        data: { subscription: null, plan: null },
      });
      return;
    }
    if (url.includes('/account/plans')) {
      await respond(200, {
        success: true,
        data: {
          items: [
            {
              _id: '6aa2f7dc66236f136cf984d3',
              name: 'Unlimited Monthly',
              price: { amountMicros: 89900000, currency: 'VND' },
            },
          ],
        },
      });
      return;
    }
    if (url.includes('/account/budgets') || url.includes('/account/limits')) {
      await respond(200, { success: true, data: { items: [] } });
      return;
    }
    if (url.includes('/account/profile')) {
      await respond(200, {
        success: true,
        data: {
          _id: '6ac446be363c0d21ff205648',
          name: 'billing-user',
          email: 'billing@example.test',
          balance: { amountMicros: 0, currency: 'USD' },
        },
      });
      return;
    }
    if (url.includes('/billing/history')) {
      await respond(200, { success: true, data: { items: [], total: 0 } });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  const panel = await openSettingsModal(page);
  await selectSettingsTab(panel, 'api-platform');

  const usage = panel.getByLabel('Usage on this account');
  await usage.scrollIntoViewIfNeeded();
  await expect(usage.getByText("Couldn't load usage")).toHaveCount(0);
  await expect(usage.getByText('900').first()).toBeVisible();

  const account = panel.getByText('No active subscription.');
  await account.scrollIntoViewIfNeeded();
  await expect(account).toBeVisible();
  await expect(panel.getByText("Couldn't load account details")).toHaveCount(0);
});
