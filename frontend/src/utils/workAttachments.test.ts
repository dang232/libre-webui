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

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WORK_ATTACHMENT_MAX_BYTES,
  WORK_ATTACHMENT_MAX_FILES,
  partitionWorkAttachmentCandidates,
  readWorkAttachmentDraft,
  type WorkAttachmentCandidate,
} from './workAttachments';

const candidate = (
  name: string,
  size: number,
  content = 'hello'
): WorkAttachmentCandidate => ({
  name,
  size,
  text: async () => content,
});

test('partition accepts files within count and size caps', () => {
  const { accepted, rejected } = partitionWorkAttachmentCandidates(
    [candidate('a.txt', 10), candidate('b.md', 20)],
    0
  );
  assert.equal(accepted.length, 2);
  assert.equal(rejected.length, 0);
});

test('partition counts already-staged files against the cap', () => {
  const files = Array.from({ length: WORK_ATTACHMENT_MAX_FILES }, (_, i) =>
    candidate(`f${i}.txt`, 10)
  );
  const { accepted, rejected } = partitionWorkAttachmentCandidates(
    files,
    WORK_ATTACHMENT_MAX_FILES - 1
  );
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, WORK_ATTACHMENT_MAX_FILES - 1);
  assert.ok(rejected.every(note => note.reason === 'too-many'));
});

test('partition rejects oversize files', () => {
  const { accepted, rejected } = partitionWorkAttachmentCandidates(
    [candidate('big.csv', WORK_ATTACHMENT_MAX_BYTES + 1)],
    0
  );
  assert.equal(accepted.length, 0);
  assert.deepEqual(rejected, [{ name: 'big.csv', reason: 'too-large' }]);
});

test('read returns a draft for text content', async () => {
  const result = await readWorkAttachmentDraft(
    candidate('notes.txt', 5, 'line one\nline two')
  );
  assert.ok('draft' in result);
  assert.equal(result.draft.name, 'notes.txt');
  assert.equal(result.draft.content, 'line one\nline two');
});

test('read rejects empty and binary content', async () => {
  const empty = await readWorkAttachmentDraft(candidate('e.txt', 0, ''));
  assert.ok('rejected' in empty && empty.rejected.reason === 'empty');
  const binary = await readWorkAttachmentDraft(
    candidate('img.png', 8, 'PNG\0binary-stuff')
  );
  assert.ok('rejected' in binary && binary.rejected.reason === 'not-text');
});
