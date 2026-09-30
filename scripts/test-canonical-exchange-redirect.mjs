/*
 * Alcore
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

/**
 * Regression test for the browser-handoff exchange path.
 *
 * Auth binds a browser-minted exchange code to an exact redirect URI and state,
 * and refuses redemption without both. Libre must therefore forward the values
 * the browser presented rather than substituting its own, and must omit them
 * entirely for the server-side Google exchange (which carries no binding).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { CANONICAL_REDIRECT_URI } =
  await import('../backend/dist/services/canonicalAuthService.js');

/** Captures the JSON body Libre posts to Auth's /oidc/exchange/token. */
async function captureExchangeBody(invoke) {
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/oidc/exchange/token')) {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return originalFetch(url, init);
  };
  try {
    await invoke();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return captured;
}

test('Given a browser-handoff code, when Libre redeems it, then it forwards the redirect binding and state verbatim', async () => {
  const body = await captureExchangeBody(async () => {
    const { consumeLibreExchangeCode } =
      await import('../backend/dist/services/canonicalAuthService.js');
    await consumeLibreExchangeCode(
      'code-abc',
      AbortSignal.timeout(5_000),
      CANONICAL_REDIRECT_URI,
      'state-xyz'
    );
  });
  assert.equal(body.code, 'code-abc');
  assert.equal(body.audience, 'libre');
  assert.equal(body.intent, 'product_exchange');
  assert.equal(body.redirect_uri, CANONICAL_REDIRECT_URI);
  assert.equal(body.state, 'state-xyz');
});

test('Given a server-side Google exchange code, when Libre redeems it, then no redirect binding is sent', async () => {
  const body = await captureExchangeBody(async () => {
    const { consumeLibreExchangeCode } =
      await import('../backend/dist/services/canonicalAuthService.js');
    await consumeLibreExchangeCode('code-google', AbortSignal.timeout(5_000));
  });
  assert.equal(body.code, 'code-google');
  // Omitted rather than sent empty: Auth treats a present redirect_uri as a
  // claim that the code is bound, and would then demand a matching state.
  assert.equal('redirect_uri' in body, false);
  assert.equal('state' in body, false);
});

test('Given the configured redirect URI, then it is an absolute https URL on the Libre origin', () => {
  const url = new URL(CANONICAL_REDIRECT_URI);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.origin, 'https://web.alcore.io.vn');
  assert.equal(url.pathname, '/auth/callback');
  // No query or fragment: Auth matches the registered value exactly.
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
});
