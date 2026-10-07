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

import assert from 'node:assert/strict';
import test from 'node:test';

const { renderToStaticMarkup } = await import('react-dom/server');
const { default: React } = await import('react');
const { I18nextProvider } = await import('react-i18next');
const { createInstance } = await import('i18next');
const { default: en } = await import('@/i18n/locales/en.json');
const { ToolApprovalsSection } = await import('./ToolApprovalsSection');
import type { ToolApprovalView, ToolServerView } from '@/utils/api/toolsApi';

const approval = (overrides: Partial<ToolApprovalView>): ToolApprovalView => ({
  id: 'approval-1',
  toolName: 'wipe_disk',
  serverId: 'server-1',
  scope: 'always',
  status: 'approved',
  createdAt: 1791300000000,
  ...overrides,
});

const servers: ToolServerView[] = [
  {
    id: 'server-1',
    name: 'Exa',
    kind: 'mcp',
    authMode: 'none',
    enabled: true,
    specRevision: 1,
    hasCredential: true,
  },
];

const renderSection = (
  approvals: ToolApprovalView[],
  denied: ToolApprovalView[]
): string => {
  const i18n = createInstance();
  void i18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ToolApprovalsSection
        approvals={approvals}
        denied={denied}
        servers={servers}
        revoking={null}
        onRevoke={() => undefined}
      />
    </I18nextProvider>
  );
};

test('whitelist and blacklist render as separate revocable groups', () => {
  const html = renderSection(
    [approval({ id: 'a1' })],
    [
      approval({
        id: 'd1',
        toolName: 'delete_pet',
        status: 'denied',
      }),
    ]
  );
  assert.match(html, /Standing approvals/, 'whitelist heading renders');
  assert.match(html, /Standing denials/, 'blacklist heading renders');
  assert.match(html, /wipe_disk/, 'approved tool renders');
  assert.match(html, /delete_pet/, 'denied tool renders');
  assert.match(html, /tool-approval-revoke/, 'approval revoke renders');
  assert.match(html, /tool-denial-revoke/, 'denial revoke renders');
});

test('empty lists render their empty states', () => {
  const html = renderSection([], []);
  assert.match(html, /No standing approvals\./, 'approvals empty renders');
  assert.match(html, /No standing denials\./, 'denials empty renders');
  assert.doesNotMatch(html, /tool-denial-row/, 'no denial rows render');
});
