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

test('major-unit helpers round-trip micros exactly, without floats', async () => {
  const { formatMajorUnits, parseMajorUnitsToMicros } =
    await import('./SettingsApiPlatformTab');
  assert.equal(formatMajorUnits(0), '0');
  assert.equal(formatMajorUnits(5_000_000), '5');
  assert.equal(formatMajorUnits(1_500_000), '1.5');
  assert.equal(formatMajorUnits(1), '0.000001');
  assert.equal(formatMajorUnits(1_234_567), '1.234567');
  assert.equal(formatMajorUnits(1_000_000_000_000), '1,000,000');

  assert.equal(parseMajorUnitsToMicros(''), undefined);
  assert.equal(parseMajorUnitsToMicros('5'), 5_000_000);
  assert.equal(parseMajorUnitsToMicros('1.5'), 1_500_000);
  assert.equal(parseMajorUnitsToMicros('0.000001'), 1);
  assert.equal(parseMajorUnitsToMicros('0'), 0);
  assert.equal(parseMajorUnitsToMicros('abc'), null);
  assert.equal(parseMajorUnitsToMicros('1.1234567'), null);
  assert.equal(parseMajorUnitsToMicros('-3'), null);
  assert.equal(parseMajorUnitsToMicros('1,000.5'), 1_000_500_000);

  // Round-trip: editor text -> micros -> editor text is the identity.
  for (const micros of [0, 1, 1_500_000, 5_000_000, 2_590_000_000]) {
    assert.equal(parseMajorUnitsToMicros(formatMajorUnits(micros)), micros);
  }
});

test('new apiPlatform copies exist in en/vi with compatible interpolation', async () => {
  const { readFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const localesDir = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'i18n',
    'locales'
  );
  const names = (message: string): string[] =>
    Array.from(
      message.matchAll(/{{\s*([^},\s]+)[^}]*}}/g),
      match => match[1]
    ).sort();
  for (const file of ['en.json', 'vi.json']) {
    const locale = JSON.parse(await readFile(join(localesDir, file), 'utf8'));
    const apiPlatform = locale.settings.apiPlatform as Record<string, string>;
    for (const key of [
      'budgetsEmpty',
      'billingPeriodMonth',
      'billingPeriodQuarter',
      'billingPeriodYear',
      'provisionUnknown',
      'keysPrev',
      'keysNext',
      'keysPage',
    ]) {
      assert.ok(
        typeof apiPlatform[key] === 'string' && apiPlatform[key].trim(),
        `${file}: settings.apiPlatform.${key} must be present and non-empty`
      );
    }
    assert.deepEqual(names(apiPlatform.keysPage), ['page', 'pages']);
  }
});
