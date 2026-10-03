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

test('Alcore-mode login renders the normal email/password form', () => {
  const html = renderNotice();
  assert.match(html, /type="email"/, 'email field is rendered');
  assert.match(html, /type="password"/, 'password field is rendered');
  assert.match(html, /Welcome Back/, 'neutral heading is rendered');
  assert.match(html, /Create an account/, 'create-account link is rendered');
  assert.match(html, /Forgot password\?/, 'forgot-password link is rendered');
});

test('Alcore-mode login carries no interstitial jargon or dead buttons', () => {
  const html = renderNotice();
  for (const banned of [
    'Alcore Auth',
    'Continue with Auth',
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
