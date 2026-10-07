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

const { buildDelegateWorkPayload } = await import('./DelegateWorkDialog');

test('an admin goal keeps its folder binding', () => {
  assert.deepEqual(
    buildDelegateWorkPayload('  Summarize the news. ', '/data/reports ', true),
    { goal: 'Summarize the news.', hostPath: '/data/reports' }
  );
});

test('a blank goal builds nothing', () => {
  assert.equal(buildDelegateWorkPayload('   ', '/data/x', true), null);
  assert.equal(buildDelegateWorkPayload('', '', true), null);
});

test('a non-admin folder binding is dropped, never sent', () => {
  assert.deepEqual(buildDelegateWorkPayload('Do it.', '/etc/secrets', false), {
    goal: 'Do it.',
  });
});

test('an empty folder field sends no host path', () => {
  assert.deepEqual(buildDelegateWorkPayload('Do it.', '  ', true), {
    goal: 'Do it.',
  });
});
