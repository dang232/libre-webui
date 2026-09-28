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
import { renderToStaticMarkup } from 'react-dom/server';

// The tab pulls @/utils/config, which reads window.location at module load.
// Stub it before the dynamic import, mirroring config.test.ts.
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    location: {
      protocol: 'http:',
      origin: 'http://localhost:5173',
      hostname: 'localhost',
    },
  },
});

const { SettingsApiPlatformTab, TOKENPANEL_BASE_URL } =
  await import('./SettingsApiPlatformTab');
const { portalSectionUrl } = await import('../../utils/config');

test('API Platform tab renders section actions without hardcoded links', () => {
  const html = renderToStaticMarkup(<SettingsApiPlatformTab />);
  assert.equal(TOKENPANEL_BASE_URL, 'https://alcore.io.vn');
  for (const key of [
    'keysTitle',
    'usageTitle',
    'billingOpen',
    'playgroundTitle',
    'accountTitle',
    'accountLoading',
  ]) {
    assert.ok(html.includes(key), `missing section action ${key}`);
  }
  assert.ok(!html.includes('href="https://alcore.io.vn/portal'));
});

test('portal deep-link carries the one-time token in the fragment', () => {
  assert.equal(
    portalSectionUrl('https://alcore.io.vn', '/keys', 'aaa.bbb.ccc'),
    'https://alcore.io.vn/portal/keys?from=web#sso=aaa.bbb.ccc'
  );
  assert.equal(
    portalSectionUrl('http://localhost:3000/', '/usage', 't'),
    'http://localhost:3000/portal/usage?from=web#sso=t'
  );
});

test('native keys/projects sections render without secrets or mgmt creds', () => {
  // Server-rendered: async list content needs effects, so assert the
  // always-rendered native headers plus the credential gates.
  const html = renderToStaticMarkup(<SettingsApiPlatformTab />);
  for (const key of [
    'keysNativeTitle',
    'keysNativeDescription',
    'projectsNativeTitle',
    'projectsNativeDescription',
    'platformDefaultTitle',
    'platformDefaultDescription',
  ]) {
    assert.ok(html.includes(key), `missing native section action ${key}`);
  }
  // No secret material or management credential may ever be baked in.
  assert.ok(!html.includes('tp_live_'));
  assert.ok(!html.includes('tp_mgmt_'));
});
