import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allCatalogs } from '../src/i18n/catalogs';
import { DEFAULT_LOCALE, createMessages, defineCatalog, detectDeviceLocale, getLocale, intlTag, resolveLocale, setLocale, subscribeLocale } from '../src/i18n/core';

const TURKISH_LETTERS = /[ğüşıöçĞÜŞİÖÇ]/;

/** Calls a message function with dummy arguments so its output can be inspected. */
function render(message: unknown): string {
  if (typeof message === 'string') return message;
  assert.equal(typeof message, 'function');
  return (message as (...a: unknown[]) => string)(...Array.from({ length: (message as () => void).length }, () => 2));
}

test('every catalog has the same keys and function arities in English and Turkish', () => {
  for (const [name, pair] of Object.entries(allCatalogs)) {
    assert.deepEqual(Object.keys(pair.tr).sort(), Object.keys(pair.en).sort(), `${name}: key mismatch`);
    for (const key of Object.keys(pair.en)) {
      const en = pair.en[key];
      const tr = pair.tr[key];
      assert.equal(typeof tr, typeof en, `${name}.${key}: type mismatch`);
      if (typeof en === 'function') assert.equal((tr as () => void).length, en.length, `${name}.${key}: arity mismatch`);
      assert.notEqual(render(tr).trim(), '', `${name}.${key}: empty Turkish text`);
      assert.notEqual(render(en).trim(), '', `${name}.${key}: empty English text`);
    }
  }
});

test('English source texts contain no Turkish letters', () => {
  for (const [name, pair] of Object.entries(allCatalogs)) {
    for (const key of Object.keys(pair.en)) {
      assert.ok(!TURKISH_LETTERS.test(render(pair.en[key])), `${name}.${key} looks Turkish: ${render(pair.en[key])}`);
    }
  }
});

test('resolveLocale maps device tags to a supported locale and falls back to English', () => {
  assert.equal(resolveLocale('tr'), 'tr');
  assert.equal(resolveLocale('tr-TR'), 'tr');
  assert.equal(resolveLocale('TR_tr'), 'tr');
  assert.equal(resolveLocale('en-GB'), 'en');
  assert.equal(resolveLocale('de-DE'), DEFAULT_LOCALE);
  assert.equal(resolveLocale(''), DEFAULT_LOCALE);
  assert.equal(resolveLocale(null), DEFAULT_LOCALE);
  assert.equal(resolveLocale(undefined), DEFAULT_LOCALE);
  assert.ok(['en', 'tr'].includes(detectDeviceLocale()));
});

test('messages follow the active locale, notify subscribers and fall back to English', () => {
  const pair = defineCatalog({ hello: 'Hello', count: (n: number) => `${n} items`, onlyEnglish: 'Fallback' }, { hello: 'Merhaba', count: (n: number) => `${n} öğe`, onlyEnglish: 'Yedek' });
  // Simulate a translation that is missing at runtime (JS callers bypass the compiler).
  delete (pair.tr as Record<string, unknown>).onlyEnglish;
  const m = createMessages(pair);
  let notified = 0;
  const off = subscribeLocale(() => notified++);
  try {
    setLocale('en');
    assert.equal(getLocale(), 'en');
    assert.equal(m.hello, 'Hello');
    assert.equal(m.count(3), '3 items');
    setLocale('tr');
    assert.equal(m.hello, 'Merhaba');
    assert.equal(m.count(3), '3 öğe');
    assert.equal(m.onlyEnglish, 'Fallback');
    assert.equal(intlTag(), 'tr-TR');
    setLocale('tr');
    assert.equal(notified, 1, 'setting the same locale again must not notify');
  } finally {
    off();
    setLocale('en');
  }
  assert.equal(intlTag(), 'en-US');
});
