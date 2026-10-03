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

/**
 * Todo 8 — Option A browser handoff, end to end against a REAL local stack.
 *
 * This spec mocks nothing. It needs the local Auth service and the Libre
 * backend serving the flag-ON built frontend, published by the orchestrator
 * as STACK_AUTH_URL / STACK_LIBRE_URL. Without those env vars it skips, so
 * the shared Playwright suite stays green in mock-only runs.
 *
 * One test, ordered test.steps:
 *   1. register a brand-new Auth user (Node fetch — a separate cookie jar,
 *      so the browser's first Auth session comes from the password form),
 *   2. drive Libre login -> Auth password form -> POST /auth/login ->
 *      full-page GET /oidc/exchange/redirect -> Auth 302 Location carrying
 *      code+state -> /auth/alcore/callback -> exactly one
 *      POST /api/auth/alcore/exchange with the matching binding -> Libre
 *      session -> authenticated home, asserting every hop in arrival order,
 *   3. the five security negatives (replay, tampered state, foreign
 *      redirect_uri, lwk_* at the exchange, double redemption),
 *   4. the credential negative proof: no Auth-shaped credential in any
 *      storage entry, in document.cookie, or in a retained Libre response
 *      body — with the honest eyJ-scan limitation in the evidence head.
 *
 * Every line written to the evidence file passes through redactAll: JWTs
 * (Auth access tokens, product assertions, the Libre session) become
 * len+sha256-prefix tuples, codes become len+sha256-prefix tuples, and
 * lwk_* becomes <lwk>. No full credential is ever printed or persisted.
 */

import { expect, test } from '@playwright/test';
import type { Response as PageResponse } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const AUTH = (process.env.STACK_AUTH_URL ?? '').replace(/\/+$/, '');
const LIBRE = (process.env.STACK_LIBRE_URL ?? '').replace(/\/+$/, '');
const EVIDENCE =
  'I:/migration/.omo/research/alcore-auth-browser-handoff/task-8-e2e.log';

const sha12 = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 12);

/** JWT-shaped strings: eyJ<header>.<payload>.<sig>. */
const JWT_SOURCE = 'eyJ[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+';
const jwtGlobal = new RegExp(JWT_SOURCE, 'g');
const jwtAny = new RegExp(JWT_SOURCE);

const redactAll = (text: string): string =>
  text
    .replace(
      jwtGlobal,
      match => `<jwt len=${match.length} sha=${sha12(match)}>`
    )
    .replace(/lwk_[A-Za-z0-9_-]+/g, '<lwk>')
    .replace(
      /([?&"']code["']?\s*[:=]\s*["']?)([A-Za-z0-9_.\-%/]+)/g,
      (_m: string, prefix: string, value: string) =>
        `${prefix}<redacted len=${value.length} sha=${sha12(value)}>`
    );

/**
 * The head of the evidence file: redaction contract, the honest limit of the
 * eyJ check, and the positive controls — written before any run line so a
 * reader can never mistake a clean scan for sufficient proof.
 */
const HEAD = [
  'task-8-e2e.log — alcore-auth-browser-handoff, todo 8',
  'Option A browser handoff, end to end, flag ON, against a local stack.',
  'Plan: .omo/plans/alcore-auth-browser-handoff.md (todo 8).',
  '',
  'REDACTION CONTRACT (applies to every line below)',
  '- alcore_at / alcore_rt values, Auth access tokens, product assertions,',
  '  exchange codes, and the Libre session token are NEVER printed in full:',
  '  only length + sha256-prefix (12 hex) are recorded. The only credential',
  '  literals anywhere are the per-run throwaway test password generated in',
  '  memory inside the spec (never written to disk, not a production value).',
  '- Product assertions / exchange codes: length + hash prefix only.',
  '',
  'THE eyJ CHECK IS NECESSARY, NOT SUFFICIENT (limit, stated honestly)',
  '- The raw eyJ scan detects JWT-SHAPED credentials ONLY. It cannot',
  '  detect an opaque or hex-encoded secret (Auth refresh tokens are opaque;',
  '  a hex secret would not match eyJ). A clean scan is therefore',
  '  NECESSARY-NOT-SUFFICIENT and must NOT be reported as proof that no',
  '  credential reaches the browser data path.',
  '- Scan targets are distinguished by claims, never hidden: the Libre',
  '  product session is itself a JWT and legitimately lives in',
  '  localStorage (auth-token / auth-store); it carries NO iss/aud/intent',
  '  claims. The assertion that matters is that NO JWT with Auth claims',
  '  (iss/aud/intent) appears in any storage entry, in document.cookie, or',
  '  in any retained Libre-origin response body, and that the exact',
  '  alcore_at value issued by Auth appears in none of them.',
  '- Scope note: Auth-origin password responses carry an access token in',
  '  the body BY CONTRACT (the flag-ON branch never reads it); retention is',
  '  what the storage/cookie scans prove absent, so response-body scanning',
  '  covers the Libre origin — the app data path the page stores from.',
  '',
  'POSITIVE CONTROLS (what proves the credential DID exist somewhere)',
  '- Flag-ON branch source path: frontend/src/components/AlcoreAuthNotice.tsx',
  '  submitPassword flag-ON branch (window.location.assign(startAuthHandoff)',
  '  only) + frontend/src/utils/api/authApi.ts alcoreDirectPassword flag-ON',
  '  branch (never reads data.access_token) + alcoreFetch credentials:',
  "  'include' (todo 3 evidence: task-3-redirect.log §5.3-§5.4).",
  '- Server-side observation: Auth POST /auth/login Set-Cookie issues',
  '  alcore_at with HttpOnly + Secure + SameSite=Strict',
  '  (auth-service/src/routes/auth.ts:155-162), observed here as a',
  '  cookie-jar transition (empty before the form, present+HttpOnly after)',
  '  while document.cookie on the Auth origin shows none of it.',
  '',
];

const lines: string[] = [];
const startedAt = Date.now();
const flush = (): void => {
  try {
    writeFileSync(EVIDENCE, [...HEAD, ...lines, ''].join('\n'));
  } catch {
    // Evidence IO must never fail the run; the orchestrator owns the dir.
  }
};
const log = (raw: string): void => {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const line = `[+${elapsed}s] ${redactAll(raw)}`;
  lines.push(line);
  console.log(line);
  flush();
};

/** Decode a JWT payload without trusting it — classification only. */
const decodeClaims = (jwt: string): Record<string, unknown> => {
  try {
    const part = jwt.split('.')[1] ?? '';
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
};

/** Auth assertions always carry iss/aud/intent; the Libre session carries none. */
const isAuthClaimed = (jwt: string): boolean => {
  const claims = decodeClaims(jwt);
  return (
    typeof claims.iss === 'string' ||
    typeof claims.aud === 'string' ||
    typeof claims.intent === 'string'
  );
};

test('Option A handoff end-to-end with the flag on, negatives, credential scan', async ({
  page,
  context,
}) => {
  test.skip(
    !AUTH || !LIBRE,
    'STACK_AUTH_URL/STACK_LIBRE_URL unset — local stack not started'
  );
  test.setTimeout(600_000);

  /** Every page response in arrival order — the hop transcript. */
  const seen: PageResponse[] = [];
  page.on('response', response => {
    seen.push(response);
  });
  const exchangePosts = (): PageResponse[] =>
    seen.filter(
      response =>
        response.url() === `${LIBRE}/api/auth/alcore/exchange` &&
        response.request().method() === 'POST'
    );

  const email = `handoff8-${randomBytes(8).toString('hex')}@example.test`;
  const password = `Task8-${randomBytes(16).toString('hex')}`;
  // In-memory only: checked for leakage into browser state, never logged.
  let issuedAlcoreAt = '';
  let issuedAlcoreRt = '';

  await test.step('stack reachable, browser holds no Auth session', async () => {
    const authHealth = await fetch(`${AUTH}/health`);
    expect(authHealth.status, 'Auth /health').toBe(200);
    const libreHealth = await fetch(`${LIBRE}/health`);
    expect(libreHealth.status, 'Libre /health').toBe(200);
    const preCookies = await context.cookies();
    expect(
      preCookies.filter(cookie => cookie.name.startsWith('alcore_')),
      'browser starts with zero Auth cookies (registration uses a separate jar)'
    ).toHaveLength(0);
    log(
      `STACK ok: Auth ${AUTH} + Libre ${LIBRE} healthy; browser Auth cookies before login: 0`
    );
  });

  await test.step('register a brand-new Auth user', async () => {
    const register = await fetch(`${AUTH}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(register.status, 'POST /auth/register for a fresh identity').toBe(
      201
    );
    const body = (await register.json()) as { id?: string; email?: string };
    expect(typeof body.id).toBe('string');
    expect(body.email).toBe(email);
    log(`REGISTER ok: 201 created, auth user id=${body.id}, email=${email}`);
  });

  let stateFromHandoff = '';
  let codeFrom302 = '';
  let callbackUrlFrom302 = '';

  await test.step('hops 1-8: login page -> password form -> 302 -> exchange -> home', async () => {
    // HOP 1 — Libre login page renders the Auth panel (alcore mode).
    await page.goto(`${LIBRE}/login`);
    await expect(
      page.getByTestId('alcore-auth-notice'),
      'alcore Auth panel on the Libre login page'
    ).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    log(
      'HOP1 ok: Libre login page -> Auth password form (email+password filled)'
    );

    // HOP 2-4 — password submit: POST /auth/login (HttpOnly cookie set),
    // then startAuthHandoff writes the tab binding and does the
    // full-page navigation to /oidc/exchange/redirect. The 302
    // transcript is polled first; hop-specific cookie/HttpOnly proofs
    // run right after so the jar has the new session but the page
    // hasn't necessarily left the Auth origin.
    // hop-specific cookie/HttpOnly proofs run right after so the jar has
    // the new session before any later step can consume it.
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();

    await expect
      .poll(
        () => {
          const redirect = seen.find(
            response =>
              response.url().startsWith(`${AUTH}/oidc/exchange/redirect`) &&
              response.request().method() === 'GET'
          );
          return redirect ? String(redirect.status()) : 'waiting';
        },
        { timeout: 30_000 }
      )
      .toBe('302');
    const redirect302 = seen.find(
      response =>
        response.url().startsWith(`${AUTH}/oidc/exchange/redirect`) &&
        response.request().method() === 'GET'
    )!;
    const location302 = (await redirect302.allHeaders())['location'] ?? '';
    expect(
      location302,
      '302 Location points at the registered callback'
    ).toContain(`${LIBRE}/auth/alcore/callback?`);
    const located = new URL(location302);
    callbackUrlFrom302 = located.href;
    codeFrom302 = located.searchParams.get('code') ?? '';
    stateFromHandoff = located.searchParams.get('state') ?? stateFromHandoff;
    if (!stateFromHandoff) {
      const urlState = new URL(callbackUrlFrom302).searchParams.get('state');
      if (urlState) stateFromHandoff = urlState;
    }
    expect(stateFromHandoff, 'tab CSRF state is 64-hex').toMatch(
      /^[0-9a-f]{64}$/
    );
    const handoffRequest = new URL(redirect302.request().url());
    expect(handoffRequest.searchParams.get('audience')).toBe('libre');
    expect(handoffRequest.searchParams.get('redirect_uri')).toBe(
      `${LIBRE}/auth/alcore/callback`
    );
    log(
      `HOP3 ok: full-page GET /oidc/exchange/redirect audience=libre ` +
        `redirect_uri=${LIBRE}/auth/alcore/callback -> 302 ` +
        `Location code=<redacted len=${codeFrom302.length} sha=${sha12(codeFrom302)}> ` +
        `state=${stateFromHandoff}`
    );
    const authTab = await context.newPage();
    await authTab.goto(`${AUTH}/`, { waitUntil: 'domcontentloaded' });
    const authOriginCookie = await authTab.evaluate(() => document.cookie);
    expect(
      authOriginCookie,
      'alcore_at absent from document.cookie on the Auth origin'
    ).not.toContain('alcore_at');
    expect(authOriginCookie).not.toContain('alcore_rt');
    expect(
      jwtAny.test(authOriginCookie),
      'no JWT anywhere in Auth-origin cookies'
    ).toBe(false);
    await authTab.close();
    log(
      'HOP3b ok: document.cookie on the Auth origin shows none of alcore_at/alcore_rt (HttpOnly)'
    );
    const jarNow = await context.cookies();
    const atNow = jarNow.find(cookie => cookie.name === 'alcore_at');
    const rtNow = jarNow.find(cookie => cookie.name === 'alcore_rt');
    expect(atNow, 'alcore_at stored from POST /auth/login').toBeTruthy();
    expect(atNow?.httpOnly, 'alcore_at HttpOnly').toBe(true);
    expect(atNow?.secure, 'alcore_at Secure').toBe(true);
    expect(String(atNow?.sameSite), 'alcore_at SameSite').toBe('Strict');
    expect(rtNow?.httpOnly, 'alcore_rt HttpOnly').toBe(true);
    issuedAlcoreAt = atNow?.value ?? '';
    issuedAlcoreRt = rtNow?.value ?? '';
    expect(issuedAlcoreAt.length).toBeGreaterThan(20);
    log(
      `HOP2 ok: POST /auth/login 200 -> alcore_at len=${issuedAlcoreAt.length} sha=${sha12(issuedAlcoreAt)}, HttpOnly+Secure+SameSite=Strict`
    );

    // The browser followed that Location: the callback document request
    // must appear in the transcript (timing-proof against the SPA racing
    // ahead to / before this assertion runs).
    await expect
      .poll(
        () =>
          seen.filter(response => response.url().startsWith(callbackUrlFrom302))
            .length,
        { timeout: 30_000 }
      )
      .toBeGreaterThan(0);
    const callbackDoc = seen.find(response =>
      response.url().startsWith(callbackUrlFrom302)
    )!;
    expect(callbackDoc.status(), 'callback document served 200').toBe(200);
    log(
      `HOP5 ok: full-page GET /auth/alcore/callback?code=` +
        `<redacted len=${codeFrom302.length} sha=${sha12(codeFrom302)}>` +
        `&state=${stateFromHandoff} -> 200 (SPA)`
    );

    // HOP 6-7 — exactly one exchange with the exact binding, then the
    // authenticated home with a scrubbed URL.
    await page.waitForURL(
      url => url.origin === new URL(LIBRE).origin && url.pathname === '/',
      { timeout: 30_000 }
    );
    await expect
      .poll(() => exchangePosts().length, { timeout: 15_000 })
      .toBe(1);
    const exchange = exchangePosts()[0]!;
    expect(exchange.status(), 'exchange 200').toBe(200);
    const exchangeRequest = JSON.parse(
      String(exchange.request().postData() ?? '{}')
    ) as { code?: string; redirectUri?: string; state?: string };
    expect(
      exchangeRequest.redirectUri,
      'exchange carries the exact registered redirectUri'
    ).toBe(`${LIBRE}/auth/alcore/callback`);
    expect(exchangeRequest.state, 'exchange carries the exact tab state').toBe(
      stateFromHandoff
    );
    expect(
      exchangeRequest.code,
      'exchange carries the exact code from the 302'
    ).toBe(codeFrom302);
    const exchangeResponseBody = (await exchange.json()) as {
      success?: boolean;
      data?: { token?: string };
    };
    expect(exchangeResponseBody.success, 'exchange response success').toBe(
      true
    );

    const finalUrl = new URL(page.url());
    expect(finalUrl.pathname, 'final URL is /').toBe('/');
    expect(finalUrl.search, 'final URL has no query (code scrubbed)').toBe('');
    await expect(
      page.getByTestId('home-page'),
      'authenticated Libre home visible'
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('app-shell-content')).toBeVisible();
    log(
      `HOP6 ok: exactly one POST /api/auth/alcore/exchange 200 with ` +
        `redirectUri+state+code matching the 302 binding`
    );
    log(
      `HOP7 ok: final URL ${finalUrl.origin}/ has no code/state ` +
        `(history.replaceState scrub) + authenticated home rendered`
    );

    // Arrival order across the recorded transcript:
    // login < handoff < 302-callback < exchange.
    const indexOfFirst = (predicate: (r: PageResponse) => boolean): number =>
      seen.findIndex(predicate);
    const order = [
      indexOfFirst(
        response =>
          response.url() === `${AUTH}/auth/login` &&
          response.request().method() === 'POST'
      ),
      indexOfFirst(response =>
        response.url().startsWith(`${AUTH}/oidc/exchange/redirect`)
      ),
      indexOfFirst(response => response.url().startsWith(callbackUrlFrom302)),
      indexOfFirst(
        response =>
          response.url() === `${LIBRE}/api/auth/alcore/exchange` &&
          response.request().method() === 'POST'
      ),
    ];
    expect(
      order.every(index => index >= 0),
      'every hop recorded'
    ).toBe(true);
    expect(
      [...order].sort((a, b) => a - b),
      'hops arrived in flow order'
    ).toEqual(order);
    const loginResponse = seen[order[0]!]!;
    expect(loginResponse.status(), 'POST /auth/login 200').toBe(200);
    log(
      `HOP-ORDER ok: login(${order[0]}) < handoff(${order[1]}) < ` +
        `302-callback(${order[2]}) < exchange(${order[3]}) - every hop in order`
    );

    // HOP 8 — authenticated Libre API call succeeding with the minted
    // product session (server-side acceptance, not just UI presence).
    const verify = await page.evaluate(async () => {
      const token = localStorage.getItem('auth-token') ?? '';
      const response = await fetch('/api/auth/verify', {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await response.json().catch(() => null)) as {
        success?: boolean;
        data?: { email?: string };
      } | null;
      return { status: response.status, body, tokenLength: token.length };
    });
    expect(verify.status, 'GET /api/auth/verify 200 with the session').toBe(
      200
    );
    expect(verify.body?.success).toBe(true);
    expect(
      verify.body?.data?.email,
      'verify resolves the brand-new Auth user'
    ).toBe(email);
    log(
      `HOP8 ok: Libre session present (len=${verify.tokenLength}), ` +
        `GET /api/auth/verify 200 for ${email}`
    );
  });

  await test.step('security negatives (5): replay, tamper, foreign redirect_uri, lwk_*, double redeem', async () => {
    const beforeNegatives = exchangePosts().length;
    expect(beforeNegatives, 'flow made exactly one exchange').toBe(1);

    // NEG 1 — replay the captured callback URL: the state entry was
    // consumed on first use, so the replay must fail closed with zero
    // further exchange calls and the generic error.
    await page.goto(callbackUrlFrom302);
    await expect(
      page.locator('[role="alert"]'),
      'replayed callback shows the generic error'
    ).toContainText('Sign-in failed', { timeout: 15_000 });
    const storedAfterHop6 = await page.evaluate(() =>
      sessionStorage.getItem('alcore-auth-state')
    );
    expect(
      storedAfterHop6,
      'the tab binding was consumed by the first callback (single-use)'
    ).toBeNull();
    expect(
      exchangePosts().length,
      'replay: no additional exchange call (state already consumed)'
    ).toBe(beforeNegatives);
    log(
      `NEG1 ok: replayed callback URL failed closed (generic error, ` +
        `exchange calls still ${beforeNegatives}, state entry consumed)`
    );

    // NEG 2 — tamper state while a LIVE tab binding exists: seed the
    // original binding, then visit the callback with a FLIPPED state.
    // The mismatch must fail before any network call.
    await page.evaluate(
      value =>
        sessionStorage.setItem(
          'alcore-auth-state',
          JSON.stringify({ value, createdAt: Date.now() })
        ),
      stateFromHandoff
    );
    const tamperedUrl = new URL(callbackUrlFrom302);
    const originalState = tamperedUrl.searchParams.get('state') ?? '';
    const flippedState =
      originalState.slice(0, -1) + (originalState.endsWith('0') ? '1' : '0');
    tamperedUrl.searchParams.set('state', flippedState);
    await page.goto(tamperedUrl.href);
    await expect(
      page.locator('[role="alert"]'),
      'tampered state shows the generic error'
    ).toContainText('Sign-in failed', { timeout: 15_000 });
    expect(
      exchangePosts().length,
      'tampered state: zero exchange calls (state checked before redemption)'
    ).toBe(beforeNegatives);
    log(
      `NEG2 ok: tampered state (live binding present, URL state flipped) ` +
        `failed closed with zero exchange calls`
    );

    // NEG 3 — foreign redirect_uri requested directly from Auth: must be
    // 400 invalid_redirect_uri, NEVER a 302. Checked unauthenticated
    // (Node fetch, no cookie) AND authenticated (live alcore_at session).
    const foreignTarget = 'https://evil.example.test/cb';
    const foreignUrl =
      `${AUTH}/oidc/exchange/redirect?audience=libre` +
      `&redirect_uri=${encodeURIComponent(foreignTarget)}` +
      `&state=${encodeURIComponent(stateFromHandoff)}`;
    const anonymousForeign = await fetch(foreignUrl, { redirect: 'manual' });
    expect(
      anonymousForeign.status,
      'foreign redirect_uri is 400 even before the session check'
    ).toBe(400);
    expect(
      anonymousForeign.headers.get('location'),
      'no Location header on the anonymous foreign request'
    ).toBeNull();
    const anonymousBody = (await anonymousForeign.json()) as {
      error?: string;
    };
    expect(anonymousBody.error).toBe('invalid_redirect_uri');

    const authenticatedForeign = await fetch(foreignUrl, {
      redirect: 'manual',
      headers: { cookie: `alcore_at=${issuedAlcoreAt}` },
    });
    expect(
      authenticatedForeign.status,
      'foreign redirect_uri is 400 with a live Auth session too'
    ).toBe(400);
    expect(
      authenticatedForeign.headers.get('location'),
      'no Location header on the authenticated foreign request'
    ).toBeNull();
    const authenticatedBody = (await authenticatedForeign.json()) as {
      error?: string;
    };
    expect(authenticatedBody.error).toBe('invalid_redirect_uri');
    log(
      `NEG3 ok: foreign redirect_uri -> 400 invalid_redirect_uri ` +
        `(anonymous + authenticated; never a 302, no Location header)`
    );

    // NEG 4 — present an lwk_* product token to the Libre exchange:
    // 403 TOKEN_SCOPE, never a session.
    const lwkProbe = await page.evaluate(async () => {
      const response = await fetch('/api/auth/alcore/exchange', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer lwk_e2e_fake_token_123',
        },
        body: JSON.stringify({ code: 'lwk_e2e_fake_token_123' }),
      });
      const body = (await response.json().catch(() => null)) as {
        code?: string;
        data?: unknown;
      } | null;
      return { status: response.status, body };
    });
    expect(lwkProbe.status, 'lwk_* at the exchange is 403').toBe(403);
    expect(lwkProbe.body?.code, 'error code TOKEN_SCOPE').toBe('TOKEN_SCOPE');
    expect(lwkProbe.body?.data, 'no session data for lwk_*').toBeUndefined();
    log(
      `NEG4 ok: lwk_* presented to POST /api/auth/alcore/exchange -> ` +
        `403 TOKEN_SCOPE (no session minted)`
    );

    // NEG 5 — redeem the same code twice: replay the exact hop-6 body
    // after success; Auth consumed the code single-use, so this must fail
    // and must not mint a second session.
    const doubleRedeem = await page.evaluate(
      async payload => {
        const response = await fetch('/api/auth/alcore/exchange', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const body = (await response.json().catch(() => null)) as {
          success?: boolean;
          data?: unknown;
          message?: string;
        } | null;
        return { status: response.status, body };
      },
      {
        code: codeFrom302,
        redirectUri: `${LIBRE}/auth/alcore/callback`,
        state: stateFromHandoff,
      }
    );
    expect(
      doubleRedeem.status,
      'second redemption of the same code must fail, not 200'
    ).not.toBe(200);
    expect(
      [400, 401].includes(doubleRedeem.status),
      'second redemption fails closed with 400/401'
    ).toBe(true);
    expect(doubleRedeem.body?.success, 'failure body success=false').toBe(
      false
    );
    expect(
      doubleRedeem.body?.data,
      'no session minted on the second redemption'
    ).toBeUndefined();
    log(
      `NEG5 ok: second redemption of the same code -> ` +
        `${doubleRedeem.status} (single-use enforced, no session minted)`
    );
  });

  // The final scan gets its own step so a post-login background stall
  // (What's-new modal, work loads) cannot erase TASK8-E2E::ALL_PASS by
  // eating the global 300s budget, and the page is closed explicitly so
  // its open streams cannot hang fixture teardown.
  await test.step('credential negative proof: no Auth credential in browser data path', async () => {
    // Let any post-login background loads settle before the final scan.
    await page.waitForTimeout(1_500);

    const scan = await page.evaluate(() => {
      const dump = (storage: Storage): Array<[string, string]> => {
        const out: Array<[string, string]> = [];
        for (let i = 0; i < storage.length; i += 1) {
          const key = storage.key(i);
          if (key !== null) out.push([key, storage.getItem(key) ?? '']);
        }
        return out;
      };
      return {
        localEntries: dump(localStorage),
        sessionEntries: dump(sessionStorage),
        cookieOnLibre: document.cookie,
      };
    });

    const hits: Array<{
      store: string;
      key: string;
      redacted: string;
      isAuth: boolean;
    }> = [];
    const collect = (store: string, entries: Array<[string, string]>): void => {
      for (const [key, value] of entries) {
        for (const match of String(value).matchAll(jwtGlobal)) {
          hits.push({
            store,
            key,
            redacted: `<jwt len=${match[0].length} sha=${sha12(match[0])}>`,
            isAuth: isAuthClaimed(match[0]),
          });
        }
      }
    };
    collect('localStorage', scan.localEntries);
    collect('sessionStorage', scan.sessionEntries);
    for (const match of scan.cookieOnLibre.matchAll(jwtGlobal)) {
      hits.push({
        store: 'document.cookie',
        key: '(cookie)',
        redacted: `<jwt len=${match[0].length} sha=${sha12(match[0])}>`,
        isAuth: isAuthClaimed(match[0]),
      });
    }

    const authClaimedHits = hits.filter(hit => hit.isAuth);
    const unexpectedEyjKeys = hits.filter(
      hit =>
        !['auth-token', 'auth-store'].includes(hit.key) &&
        hit.store !== 'document.cookie'
    );
    const exactAtInStorage = [
      ...scan.localEntries,
      ...scan.sessionEntries,
    ].some(
      ([, value]) =>
        issuedAlcoreAt.length > 0 && String(value).includes(issuedAlcoreAt)
    );
    const exactRtInStorage = [
      ...scan.localEntries,
      ...scan.sessionEntries,
    ].some(
      ([, value]) =>
        issuedAlcoreRt.length > 0 && String(value).includes(issuedAlcoreRt)
    );
    const exactAtInCookie =
      issuedAlcoreAt.length > 0 && scan.cookieOnLibre.includes(issuedAlcoreAt);
    const libreSessionPresent = scan.localEntries.some(
      ([key]) => key === 'auth-token'
    );
    const handoffStateConsumed = !scan.sessionEntries.some(
      ([key]) => key === 'alcore-auth-state'
    );

    log(
      `SCAN storage keys: localStorage=[${scan.localEntries
        .map(([key]) => key)
        .join(', ')}] sessionStorage=[${scan.sessionEntries
        .map(([key]) => key)
        .join(', ')}]`
    );
    log(
      `SCAN document.cookie (Libre origin): len=${scan.cookieOnLibre.length}` +
        `${scan.cookieOnLibre ? ` value=${scan.cookieOnLibre}` : ' (empty)'}`
    );
    for (const hit of hits) {
      log(
        `  eyJ HIT ${hit.store} key=${hit.key} ${hit.redacted} ` +
          `isAuthClaimed=${hit.isAuth}`
      );
    }
    log(
      `SCAN summary: eyJ hits=${hits.length} ` +
        `auth-claimed hits=${authClaimedHits.length} ` +
        `alcore_at exact-in-storage=${exactAtInStorage} ` +
        `alcore_rt exact-in-storage=${exactRtInStorage} ` +
        `alcore_at exact-in-cookie=${exactAtInCookie} ` +
        `Libre auth-token present=${libreSessionPresent} ` +
        `handoff state consumed=${handoffStateConsumed}`
    );

    expect(
      libreSessionPresent,
      'Libre product session exists in storage (positive presence)'
    ).toBe(true);
    expect(
      handoffStateConsumed,
      'the handoff CSRF state entry stays consumed after the flow'
    ).toBe(true);
    expect(
      authClaimedHits,
      'no Auth-claimed JWT (iss/aud/intent) in any storage entry or cookie'
    ).toHaveLength(0);
    expect(
      unexpectedEyjKeys,
      'raw eyJ appears only under the Libre session keys'
    ).toHaveLength(0);
    expect(
      exactAtInStorage,
      'the exact alcore_at value appears in no storage entry'
    ).toBe(false);
    expect(
      exactRtInStorage,
      'the exact alcore_rt value appears in no storage entry'
    ).toBe(false);
    expect(
      exactAtInCookie,
      'the exact alcore_at value is absent from document.cookie (HttpOnly)'
    ).toBe(false);
    expect(scan.cookieOnLibre).not.toContain('alcore_at');
    expect(scan.cookieOnLibre).not.toContain('alcore_rt');

    // Retained response bodies: scan EVERY Libre-origin JSON response the
    // page received during the whole run — JSON only (the stream endpoint
    // never finishes reading). The only JWT allowed anywhere is the Libre
    // session inside the exchange response.
    const libreResponses = seen.filter(
      response =>
        response.url().startsWith(`${LIBRE}/api/`) &&
        (response.headers()['content-type'] ?? '').includes('application/json')
    );
    const bodyFindings: Array<{
      path: string;
      redacted: string;
      isAuth: boolean;
    }> = [];
    let exchangeTokenTraced = false;
    const storedToken =
      scan.localEntries.find(([key]) => key === 'auth-token')?.[1] ?? '';
    for (const response of libreResponses) {
      let text = '';
      try {
        // resolve-not-reject keeps a late timer from becoming an
        // unhandled rejection when the body arrives first.
        text = await Promise.race([
          response.text(),
          new Promise<string>(resolve => setTimeout(() => resolve(''), 4000)),
        ]);
      } catch {
        continue;
      }
      const path = new URL(response.url()).pathname;
      for (const match of text.matchAll(jwtGlobal)) {
        bodyFindings.push({
          path,
          redacted: `<jwt len=${match[0].length} sha=${sha12(match[0])}>`,
          isAuth: isAuthClaimed(match[0]),
        });
        if (path === '/api/auth/alcore/exchange' && match[0] === storedToken) {
          exchangeTokenTraced = true;
        }
      }
    }
    for (const finding of bodyFindings) {
      log(
        `  BODY eyJ HIT ${finding.path} ${finding.redacted} ` +
          `isAuthClaimed=${finding.isAuth}`
      );
    }
    const authInBodies = bodyFindings.filter(finding => finding.isAuth);
    const eyjPaths = [
      ...new Set(bodyFindings.map(finding => finding.path)),
    ].sort();
    log(
      `BODY scan: ${libreResponses.length} Libre /api/ responses, ` +
        `eyJ paths=[${eyjPaths.join(', ') || 'none'}], ` +
        `auth-claimed=${authInBodies.length}, ` +
        `stored token traces to exchange body: ${exchangeTokenTraced}`
    );
    expect(
      authInBodies,
      'no Auth-claimed JWT in any retained Libre response body'
    ).toHaveLength(0);
    expect(
      eyjPaths.every(path => path === '/api/auth/alcore/exchange'),
      'raw eyJ in bodies appears only in the exchange response (Libre session)'
    ).toBe(true);
    expect(
      exchangeTokenTraced,
      'the stored session traces to the Libre exchange response, not Auth'
    ).toBe(true);

    log(
      `CREDENTIAL-NEGATIVE ok: zero Auth-claimed credentials in storage, ` +
        `document.cookie, or retained Libre response bodies; the exact ` +
        `alcore_at/alcore_rt values appear nowhere the page can read`
    );
    log(
      `EYJ-LIMIT restated: JWT-shape-only, necessary-not-sufficient - ` +
        `see the head of this file before citing this result`
    );
  });

  await page.close().catch(() => undefined);
  log('TASK8-E2E::ALL_PASS');
});
