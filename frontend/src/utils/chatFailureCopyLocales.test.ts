import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chatFailureToastKey } from './chatFailureCopy.ts';

const CODES = [
  'chat-generation-rate-limited',
  'chat-generation-unverified',
  'chat-generation-model-unavailable',
  'chat-generation-upstream-incomplete',
];

function resolveKey(locale: Record<string, unknown>, dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node !== null &&
        typeof node === 'object' &&
        part in (node as Record<string, unknown>)
          ? (node as Record<string, unknown>)[part]
          : undefined,
      locale
    );
}

describe('chat failure copy ships in every locale', () => {
  for (const lang of ['en', 'vi']) {
    it(`${lang} resolves every mapped key to non-empty copy`, () => {
      const locale = JSON.parse(
        readFileSync(
          new URL(`../i18n/locales/${lang}.json`, import.meta.url),
          'utf-8'
        )
      ) as Record<string, unknown>;
      for (const code of CODES) {
        const key = chatFailureToastKey(code);
        assert.ok(key, `mapper covers ${code}`);
        const copy = resolveKey(locale, key);
        assert.equal(typeof copy, 'string', `${lang}:${key} resolves`);
        assert.ok((copy as string).length > 0, `${lang}:${key} non-empty`);
      }
    });
  }
});
