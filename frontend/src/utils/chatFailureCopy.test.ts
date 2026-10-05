import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chatFailureToastKey } from './chatFailureCopy.ts';

describe('chatFailureToastKey', () => {
  it('maps every known generation code to its copy key', () => {
    assert.equal(
      chatFailureToastKey('chat-generation-rate-limited'),
      'chat.toasts.generationRateLimited'
    );
    assert.equal(
      chatFailureToastKey('chat-generation-unverified'),
      'chat.toasts.generationUnverified'
    );
    assert.equal(
      chatFailureToastKey('chat-generation-model-unavailable'),
      'chat.toasts.generationModelUnavailable'
    );
    assert.equal(
      chatFailureToastKey('chat-generation-upstream-incomplete'),
      'chat.toasts.generationUpstreamIncomplete'
    );
  });

  it('returns null for unknown or missing codes (raw fallback)', () => {
    assert.equal(chatFailureToastKey('chat-generation-failed'), null);
    assert.equal(chatFailureToastKey('SESSION_NOT_FOUND'), null);
    assert.equal(chatFailureToastKey(undefined), null);
    assert.equal(chatFailureToastKey(''), null);
  });
});
