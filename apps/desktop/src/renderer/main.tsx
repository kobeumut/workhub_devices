import { createRoot } from 'react-dom/client';
import { createWireBackend, type BackendMethod, type PickedFile, type RoutedTarget, type WireResult } from '@workhub-devices/core';
import { WorkhubApp, isLocale, type LocalePreference, type PlatformServices } from '@workhub-devices/features';
// Not re-exported by the package entry point; same module instance as the one the UI uses.
import { getLocale, subscribeLocale } from '@workhub-devices/features/src/i18n';
import { createVoiceRecorder, playAudio } from './voice';
import identity from '../../../../config/app-identity.json';

declare global {
  interface Window {
    workhub: {
      invoke(method: BackendMethod, args: unknown[]): Promise<WireResult>;
      openExternal(url: string): Promise<boolean>;
      saveFile(filename: string, content: string, mime: string): Promise<'saved' | 'cancelled'>;
      pickFiles(): Promise<PickedFile[]>;
      stageRecording(wav: Uint8Array): Promise<PickedFile | null>;
      releaseFile(handle: string): Promise<void>;
      setBadgeCount(count: number): void;
      setForeground(target: RoutedTarget | null): void;
      onRoute(cb: (t: RoutedTarget) => void): () => void;
      platform: string;
      /** Language forced through `WORKHUB_LOCALE` (smoke tests, screenshots); `null` in normal use. */
      localeOverride: 'en' | 'tr' | null;
    };
  }
}

const bridge = window.workhub;

// Keep <html lang> in step with the UI language (screen readers, hyphenation, spell checking).
const syncHtmlLang = () => {
  document.documentElement.lang = getLocale();
};
syncHtmlLang();
subscribeLocale(syncHtmlLang);

/**
 * Language preference (`system` | `en` | `tr`) in the renderer's localStorage: a non-secret setting,
 * so it needs no OS secret store. A language forced by `WORKHUB_LOCALE` always wins on startup.
 */
const LOCALE_KEY = 'workhub.locale';
const localePreference: NonNullable<PlatformServices['localePreference']> = {
  load: async () => {
    if (bridge.localeOverride) return bridge.localeOverride;
    try {
      const v = localStorage.getItem(LOCALE_KEY);
      return v === 'system' || isLocale(v) ? (v as LocalePreference) : null;
    } catch {
      return null;
    }
  },
  save: async (pref) => {
    try {
      localStorage.setItem(LOCALE_KEY, pref);
    } catch {
      /* storage unavailable: the choice then only lasts for this session */
    }
  },
};
const backend = createWireBackend((m, a) => bridge.invoke(m, a));
const platform: PlatformServices = {
  kind: 'desktop',
  setBadgeCount: (count) => bridge.setBadgeCount(count),
  isActive: () => document.visibilityState === 'visible' && document.hasFocus(),
  subscribeActivity: (cb) => {
    const report = () => cb(document.visibilityState === 'visible' && document.hasFocus());
    document.addEventListener('visibilitychange', report);
    window.addEventListener('focus', report);
    window.addEventListener('blur', report);
    window.addEventListener('online', report);
    return () => {
      document.removeEventListener('visibilitychange', report);
      window.removeEventListener('focus', report);
      window.removeEventListener('blur', report);
      window.removeEventListener('online', report);
    };
  },
  openExternal: async (url) => {
    await bridge.openExternal(url);
  },
  saveFile: (filename, content, mime) => bridge.saveFile(filename, content, mime),
  files: { pick: () => bridge.pickFiles(), release: (h) => bridge.releaseFile(h) },
  ...(typeof navigator.mediaDevices?.getUserMedia === 'function' ? { voice: createVoiceRecorder((wav) => bridge.stageRecording(wav)) } : {}),
  playAudio,
  onForegroundRoute: (t) => bridge.setForeground(t),
  subscribeRoutes: (cb) => bridge.onRoute(cb),
  appVersion: identity.version,
  localePreference,
};

createRoot(document.getElementById('root')!).render(<WorkhubApp backend={backend} platform={platform} />);
