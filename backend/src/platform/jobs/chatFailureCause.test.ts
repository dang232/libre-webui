import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyChatFailureCause } from './chatFailureCause.js';

test('rate limit errors map to rate-limited', () => {
  assert.equal(
    classifyChatFailureCause(
      new Error(
        'Plugin API error: 429 - {"error":{"message":"Rate limit exceeded: tokens cap 50000 in 86400s window","type":"rate_limit_error","code":"rate_limited","retryAfterSeconds":65021}}'
      )
    ),
    'rate-limited'
  );
});

test('unverified email errors map to unverified', () => {
  assert.equal(
    classifyChatFailureCause(
      new Error(
        'Plugin API error: 403 - {"error":{"message":"Email verification required for free-tier inference","type":"permission_error","code":"forbidden"}}'
      )
    ),
    'unverified'
  );
});

test('off-catalog model errors map to model-unavailable', () => {
  assert.equal(
    classifyChatFailureCause(
      new Error(
        `Plugin API error: 400 - {"message":"model 'al-1-0-free' không có trong gói của bạn"}`
      )
    ),
    'model-unavailable'
  );
  assert.equal(
    classifyChatFailureCause(new Error('No active plugin found for model: x')),
    'model-unavailable'
  );
});

test('truncated and upstream errors map to upstream-incomplete', () => {
  assert.equal(
    classifyChatFailureCause(
      new Error('Provider returned an incomplete response (stream_ended)')
    ),
    'upstream-incomplete'
  );
  assert.equal(
    classifyChatFailureCause(
      new Error('Plugin API error: 502 - upstream gone')
    ),
    'upstream-incomplete'
  );
});

test('auth-shaped failures without a known cause stay generic', () => {
  assert.equal(
    classifyChatFailureCause(
      new Error(
        'Plugin API error: 403 - {"error":{"message":"Customer not active"}}'
      )
    ),
    null
  );
  assert.equal(classifyChatFailureCause(new Error('boom')), null);
  assert.equal(classifyChatFailureCause(undefined), null);
});
