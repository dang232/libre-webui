import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFinalStreamedContent } from './streamContent.ts';

describe('resolveFinalStreamedContent', () => {
  it('prefers the persisted message over a retry-doubled buffer', () => {
    assert.equal(
      resolveFinalStreamedContent('Hello!', 'Hello!Hello!'),
      'Hello!'
    );
  });

  it('falls back to the buffer when nothing was persisted', () => {
    assert.equal(resolveFinalStreamedContent('', 'Hello!'), 'Hello!');
    assert.equal(resolveFinalStreamedContent(undefined, 'Hello!'), 'Hello!');
  });

  it('keeps an empty string when both are empty', () => {
    assert.equal(resolveFinalStreamedContent('', ''), '');
  });
});
