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

// config.ts reads window.location at module load; the sign-in panel pulls
// it in transitively (authApi -> config). Stub the browser surface first,
// then import the component dynamically so the stub is already in place.
const stubWindow = {
  location: {
    protocol: 'http:',
    origin: 'http://localhost:5173',
    hostname: 'localhost',
  },
  _goober: undefined,
  __nonce__: undefined,
};
(globalThis as unknown as { window: unknown }).window = stubWindow;
// zustand persist middleware writes through bare localStorage at store
// creation; an in-memory map keeps the server-render harness hermetic.
const memStore = new Map<string, string>();
const stubStorage = {
  getItem: (key: string) => memStore.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memStore.set(key, String(value));
  },
  removeItem: (key: string) => {
    memStore.delete(key);
  },
  clear: () => memStore.clear(),
};
(globalThis as unknown as { localStorage: unknown }).localStorage = stubStorage;
(stubWindow as unknown as { localStorage: unknown }).localStorage = stubStorage;
const stubStyle = () => {
  const element: Record<string, unknown> = {
    innerHTML: ' ',
    id: '_goober',
    parentNode: null,
    firstChild: null,
    data: '',
  };
  element.firstChild = element;
  return element;
};
(globalThis as unknown as { document: unknown }).document = {
  createElement: stubStyle,
  querySelector: () => null,
  head: { appendChild: (element: unknown) => element },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  documentElement: {
    lang: '',
    dataset: {},
    style: {
      setProperty: () => undefined,
      removeProperty: () => undefined,
    },
    classList: { add: () => undefined, remove: () => undefined },
    removeAttribute: () => undefined,
    setAttribute: () => undefined,
  },
};

const { renderToStaticMarkup } = await import('react-dom/server');
const { default: React } = await import('react');
const { I18nextProvider } = await import('react-i18next');
const { createInstance } = await import('i18next');
const { MemoryRouter } = await import('react-router');
const { default: en } = await import('@/i18n/locales/en.json');
const { AlcoreAuthNotice } = await import('./AlcoreAuthNotice');

const renderNotice = (): string => {
  const i18n = createInstance();
  void i18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <AlcoreAuthNotice />
      </MemoryRouter>
    </I18nextProvider>
  );
};

// Simplified login: exactly one primary sign-in — the inline Auth
// email+password form, always visible — plus the Google button. No
// competing "Continue with Auth" path, no collapsed toggles, and the
// link-existing-account form lives in LoginPage below this panel.
test('Alcore-mode login shows exactly one primary sign-in form', () => {
  const html = renderNotice();
  assert.match(html, /Welcome Back/, 'neutral heading is rendered');
  assert.match(
    html,
    /Sign in to your account to continue/,
    'one short helper line is rendered'
  );
  assert.match(
    html,
    /data-testid="alcore-direct-signin"/,
    'the inline sign-in form is rendered'
  );
  assert.match(html, /type="email"/, 'email field is visible');
  assert.match(html, /type="password"/, 'password field is visible');
  assert.equal(
    html.match(/<form/g)?.length ?? 0,
    1,
    'exactly one form is rendered'
  );
  assert.equal(
    html.match(/type="submit"/g)?.length ?? 0,
    1,
    'exactly one primary submit'
  );
  for (const banned of [
    'data-testid="alcore-continue-button"',
    'Continue with Auth',
    'Signed out of Auth?',
    'Hide Auth sign-in',
    'aria-expanded',
    'data-testid="alcore-claim-form"',
    'Link my account',
  ]) {
    assert.doesNotMatch(
      html,
      new RegExp(banned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `simple login must not contain ${JSON.stringify(banned)}`
    );
  }
});

// ux-fix-no-through-auth: the primary sign-in reads "Sign in" with plain
// "Email"/"Password" labels — no through/via/with-Auth qualifiers.
test('Alcore-mode login carries no through-Auth qualifiers', () => {
  const html = renderNotice();
  assert.match(html, />Sign in</, 'primary submit reads "Sign in"');
  assert.match(html, />Email</, 'email label reads "Email"');
  assert.match(html, />Password</, 'password label reads "Password"');
  assert.match(
    html,
    /Continue.*Google/,
    'Google entry names Google without a qualifier'
  );
  for (const banned of [
    'Sign in with Auth',
    'Auth email',
    'Auth password',
    'Continue with Auth',
    'through Auth',
    'via Auth',
    'qua Auth',
    'with Auth',
    'Email Auth',
    'tài khoản Auth',
    'bằng Auth',
  ]) {
    assert.doesNotMatch(
      html,
      new RegExp(banned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `login must not render ${JSON.stringify(banned)}`
    );
  }
});

test('Alcore-mode login carries no architecture paragraphs', () => {
  const html = renderNotice();
  for (const banned of [
    'Auth session',
    'uses your existing Auth session',
    'They go directly to Auth',
    'Libre never sees',
    'Alcore Auth',
    'wired up separately',
    'disabled here',
    'todo 45',
  ]) {
    assert.doesNotMatch(
      html,
      new RegExp(banned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `no user-facing copy may say ${JSON.stringify(banned)}`
    );
  }
  assert.doesNotMatch(html, /disabled=""/, 'no greyed-out dead buttons');
});

// unified-auth-core todo 18: alcore /login shows ONLY the Auth Google
// full-page redirect — no product GSI widget runs beside it.
test('Alcore-mode login exposes exactly one Google entry: the Auth full-page button', () => {
  const html = renderNotice();
  const googleButtons = html.match(/data-testid="alcore-google-button"/g) ?? [];
  assert.equal(
    googleButtons.length,
    1,
    'exactly one Auth Google button is rendered'
  );
  assert.match(
    html,
    /<button[^>]*data-testid="alcore-google-button"/,
    'the Auth Google entry is a real full-page button, not a GSI-rendered div'
  );
  assert.match(html, /Continue.*Google/, 'button copy names Google');
});

test('Alcore-mode login mounts no GSI widget state', () => {
  // renderToStaticMarkup never runs effects, which mirrors the client-side
  // invariant: nothing in the alcore panel imports window.google or injects
  // the GSI script — LoginPage branches to this panel before LoginForm (and
  // its CanonicalGoogleButton) is ever reached.
  (stubWindow as unknown as Record<string, unknown>)['google'] = {
    accounts: {
      id: {
        initialize: () => {
          throw new Error('GSI must not initialize in the alcore panel');
        },
        renderButton: () => {
          throw new Error('GSI must not render in the alcore panel');
        },
        cancel: () => undefined,
      },
    },
  };
  try {
    const html = renderNotice();
    for (const banned of [
      'accounts.google',
      'gsi/client',
      'data-google-identity',
      'data-testid="canonical-google-button"',
    ]) {
      assert.doesNotMatch(
        html,
        new RegExp(banned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `alcore HTML must not contain ${JSON.stringify(banned)}`
      );
    }
  } finally {
    delete (stubWindow as unknown as Record<string, unknown>)['google'];
  }
});
