import { useSyncExternalStore } from 'react';
import { getLocale, subscribeLocale, type Locale } from './core';

/**
 * Re-renders the calling component when the language changes. Mount it once near the root; the
 * `t.*` / `messages.*` getters then return the new language during that re-render.
 */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}
