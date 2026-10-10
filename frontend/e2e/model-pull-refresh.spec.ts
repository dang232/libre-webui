/*
 * Alcore
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
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

test('a model added while the app is open becomes selectable without a reload', async ({
  page,
}) => {
  const mockApi = await mockLibreWebUiApi(page, {
    sessions: [
      {
        id: 'fresh-model-session',
        title: 'Fresh model',
        model: 'llama3.2:3b',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      },
    ],
  });

  await page.goto('/chat');
  // The picker is a visually hidden native select behind a styled trigger.
  const options = page.locator('select option');
  await expect(options.filter({ hasText: 'llama' }).first()).toBeAttached();
  await expect(options.filter({ hasText: 'Fresh Model' })).toHaveCount(0);

  // The model appears on the backend, as it would once provisioning
  // finishes on the provider side.
  mockApi.setPlugins([
    {
      id: 'e2e-chat',
      name: 'E2E Chat Provider',
      type: 'completion',
      endpoint: '/api/chat/completions',
      api_mode: 'chat_completions',
      base_url: '',
      auth: { header: 'Authorization', key_env: 'E2E_KEY' },
      model_map: ['llama3.2:3b', 'fresh-model:latest'],
      active: true,
    },
  ]);

  // Completing provisioning announces the change; nothing else should be needed.
  await page.evaluate(() =>
    window.dispatchEvent(new Event('alcore:models-changed'))
  );

  await expect(
    options.filter({ hasText: 'Fresh Model' }).first()
  ).toBeAttached();
});
