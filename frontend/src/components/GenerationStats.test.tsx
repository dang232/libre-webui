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
const { GenerationStats } = await import('./GenerationStats');
import type { GenerationStatistics } from '@/types';

const renderStats = (statistics: GenerationStatistics): string => {
  const i18n = createInstance();
  void i18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <GenerationStats statistics={statistics} defaultExpanded />
    </I18nextProvider>
  );
};

const providerStats: GenerationStatistics = {
  prompt_eval_count: 2644,
  eval_count: 322,
  prompt_eval_duration: 1000000,
  eval_duration: 1220000000,
  total_duration: 1221000000,
  tokens_per_second: 265.0,
  model: 'al-1-3-max',
};

test('provider reply without a load duration hides the model-load row', () => {
  const html = renderStats(providerStats);
  assert.doesNotMatch(html, /Model load:/, 'no model-load row is rendered');
  assert.match(html, /Total time:/, 'the remaining rows still render');
  assert.match(html, /322 tokens/, 'the token summary still renders');
});

test('local reply with a load duration keeps the model-load row', () => {
  const html = renderStats({ ...providerStats, load_duration: 50000000 });
  assert.match(html, /Model load:/, 'the model-load row is rendered');
  assert.match(html, /50ms/, 'the load duration is formatted');
});
