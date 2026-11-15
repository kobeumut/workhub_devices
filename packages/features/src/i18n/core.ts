/**
 * Locale handling shared by every screen. Pure TypeScript (no React, no native modules) so it can
 * be unit-tested with the Node test runner; the React binding lives in `./react.ts`.
 *
 * Adding a language: add its tag to `SUPPORTED_LOCALES`, give it a display name and an `Intl` tag
 * below, then add a translation to every catalog under `./catalogs` (the compiler lists what is
 * missing because `defineCatalog` requires every key).
 */

export const SUPPORTED_LOCALES = ['en', 'tr'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Source language and the fallback for any missing translation or unsupported device language. */
export const DEFAULT_LOCALE: Locale = 'en';

/** Endonyms, shown in the language picker so every user can find their own language. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', tr: 'Türkçe' };

/** BCP 47 tags handed to `Intl` / `toLocale*String` for dates, times and numbers. */
const INTL_TAGS: Record<Locale, string> = { en: 'en-US', tr: 'tr-TR' };

/** A catalog entry: plain text, or a function for text with parameters or plural forms. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Message = string | ((...args: any[]) => string);
export type Catalog = Record<string, Message>;
export interface CatalogPair<T extends Catalog> {
  en: T;
  tr: T;
}

/**
 * Declares the English source texts and their translations side by side. `tr` must have exactly
 * the keys and function signatures of `en`, so a missing translation is a compile error.
 */
export function defineCatalog<T extends Catalog>(en: T, tr: T): CatalogPair<T> {
  return { en, tr };
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Maps a BCP 47 tag (`tr-TR`, `en_GB`, `TR`) to a supported locale; unknown tags give the default. */
export function resolveLocale(tag: string | null | undefined): Locale {
  const primary = (tag ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
  return isLocale(primary) ? primary : DEFAULT_LOCALE;
}

/** The device language, from `Intl` (React Native/Hermes, Electron, browsers) or `navigator`. */
export function detectDeviceLocale(): Locale {
  try {
    const tag = Intl.DateTimeFormat().resolvedOptions().locale;
    if (tag) return resolveLocale(tag);
  } catch {
    // Intl unavailable: fall through to navigator.
  }
  const nav = (globalThis as { navigator?: { language?: string } }).navigator;
  return resolveLocale(nav?.language);
}

let current: Locale = DEFAULT_LOCALE;
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  for (const fn of [...listeners]) fn();
}

/** Subscribes to locale changes; returns the unsubscribe function. */
export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The `Intl` tag of the active locale, e.g. for `toLocaleDateString(intlTag(), …)`. */
export function intlTag(locale: Locale = current): string {
  return INTL_TAGS[locale];
}

/**
 * Turns a catalog pair into an object whose properties resolve against the *current* locale each
 * time they are read, so `t.save` always returns the active language (components re-render on a
 * locale change through `useLocale`). A key missing from the active catalog falls back to English.
 */
export function createMessages<T extends Catalog>(pair: CatalogPair<T>): T {
  const out = {} as T;
  for (const key of Object.keys(pair.en) as (keyof T & string)[]) {
    Object.defineProperty(out, key, {
      enumerable: true,
      get: () => pair[current][key] ?? pair.en[key],
    });
  }
  return out;
}
