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

const {
  escapeCsvCell,
  tablesToCsv,
  requestPreviewTables,
  ARTIFACT_TABLES_RESPONSE,
} = await import('./artifactExport');

test('plain cells pass through while special cells quote', () => {
  assert.equal(escapeCsvCell('hello'), 'hello');
  assert.equal(escapeCsvCell('a,b'), '"a,b"');
  assert.equal(escapeCsvCell('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvCell('line one\nline two'), '"line one\nline two"');
});

test('tables serialize with a blank line between them', () => {
  assert.equal(
    tablesToCsv([
      [
        ['name', 'tokens'],
        ['al-1-2', '1000000'],
      ],
      [['a "quoted", cell']],
    ]),
    'name,tokens\r\nal-1-2,1000000\r\n\r\n"a ""quoted"", cell"'
  );
  assert.equal(tablesToCsv([]), '');
});

type Listener = (event: {
  source: unknown;
  origin: string;
  data: unknown;
}) => void;

const installMessageBus = () => {
  const listeners = new Set<Listener>();
  const bus = {
    addEventListener: (_type: string, listener: Listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: Listener) => {
      listeners.delete(listener);
    },
    emit: (event: { source: unknown; origin: string; data: unknown }) => {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.size,
  };
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: bus.addEventListener,
    removeEventListener: bus.removeEventListener,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as never),
  };
  return bus;
};

const fakeFrame = (
  onPost: (message: { type: string; nonce: string }) => void
) => {
  const target = {
    postMessage: (message: { type: string; nonce: string }) => onPost(message),
  };
  const frame = { contentWindow: target } as unknown as HTMLIFrameElement;
  return { frame, target };
};

test('a matching host answer resolves its tables', async () => {
  const bus = installMessageBus();
  const frame = fakeFrame(message => {
    bus.emit({
      source: frame.target,
      origin: 'null',
      data: {
        type: ARTIFACT_TABLES_RESPONSE,
        nonce: message.nonce,
        tables: [[['a', 'b']]],
      },
    });
  });
  const tables = await requestPreviewTables(frame.frame, { nonce: () => 'n1' });
  assert.deepEqual(tables, [[['a', 'b']]]);
  assert.equal(bus.listenerCount(), 0);
});

test('a foreign window cannot answer for the frame', async () => {
  const bus = installMessageBus();
  const frame = fakeFrame(() => {
    bus.emit({
      source: {},
      origin: 'null',
      data: {
        type: ARTIFACT_TABLES_RESPONSE,
        nonce: 'n2',
        tables: [[['x']]],
      },
    });
  });
  const tables = await requestPreviewTables(frame.frame, {
    nonce: () => 'n2',
    timeoutMs: 5,
  });
  assert.equal(tables, null);
  assert.equal(bus.listenerCount(), 0);
});

test('a malformed answer resolves null instead of junk', async () => {
  const bus = installMessageBus();
  const frame = fakeFrame(message => {
    bus.emit({
      source: frame.target,
      origin: 'null',
      data: {
        type: ARTIFACT_TABLES_RESPONSE,
        nonce: message.nonce,
        tables: [{ rows: 'not-an-array' }],
      },
    });
  });
  const tables = await requestPreviewTables(frame.frame, { nonce: () => 'n3' });
  assert.equal(tables, null);
  assert.equal(bus.listenerCount(), 0);
});

test('a silent host resolves null on timeout', async () => {
  const bus = installMessageBus();
  const frame = fakeFrame(() => {});
  const tables = await requestPreviewTables(frame.frame, {
    nonce: () => 'n4',
    timeoutMs: 5,
  });
  assert.equal(tables, null);
  assert.equal(bus.listenerCount(), 0);
});
