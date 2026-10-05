import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chatBudgetToastKey,
  chatFailureToastKey,
  chatSendFailureToastKey,
} from './chatFailureCopy.ts';

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

  it('points unclassified generation failures at the support path', () => {
    assert.equal(
      chatFailureToastKey('chat-generation-failed'),
      'chat.toasts.generationFailedSupport'
    );
  });

  it('returns null for unknown or missing codes (raw fallback)', () => {
    assert.equal(chatFailureToastKey('SESSION_NOT_FOUND'), null);
    assert.equal(chatFailureToastKey(undefined), null);
    assert.equal(chatFailureToastKey(''), null);
  });
});

describe('chatBudgetToastKey', () => {
  it('names the reset time for each budget period', () => {
    assert.equal(
      chatBudgetToastKey('daily'),
      'chat.toasts.generationRateLimitedDaily'
    );
    assert.equal(
      chatBudgetToastKey('weekly'),
      'chat.toasts.generationRateLimitedWeekly'
    );
    assert.equal(
      chatBudgetToastKey('monthly'),
      'chat.toasts.generationRateLimitedMonthly'
    );
  });

  it('falls back to the generic quota copy without a known period', () => {
    assert.equal(
      chatBudgetToastKey(undefined),
      'chat.toasts.generationRateLimited'
    );
    assert.equal(
      chatBudgetToastKey('yearly'),
      'chat.toasts.generationRateLimited'
    );
  });
});

describe('chatSendFailureToastKey', () => {
  it('maps budget 429s to the period reset copy', () => {
    assert.equal(
      chatSendFailureToastKey({ status: 429, period: 'daily' }),
      'chat.toasts.generationRateLimitedDaily'
    );
    assert.equal(
      chatSendFailureToastKey({ status: 429 }),
      'chat.toasts.generationRateLimited'
    );
  });

  it('maps verification 403s to the verify copy', () => {
    assert.equal(
      chatSendFailureToastKey({ status: 403, message: 'email_unverified' }),
      'chat.toasts.generationUnverified'
    );
  });

  it('names pending approval instead of verification', () => {
    assert.equal(
      chatSendFailureToastKey({
        status: 403,
        code: 'ACCOUNT_PENDING',
        message: 'waiting for administrator approval',
      }),
      'chat.toasts.generationAccountPending'
    );
  });

  it('keeps the generic copy for everything else', () => {
    assert.equal(
      chatSendFailureToastKey({ status: 403, message: 'forbidden' }),
      'chat.toasts.sendFailed'
    );
    assert.equal(
      chatSendFailureToastKey({ status: 404 }),
      'chat.toasts.sendFailed'
    );
    assert.equal(chatSendFailureToastKey({}), 'chat.toasts.sendFailed');
  });
});
