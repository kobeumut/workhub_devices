import { app } from 'electron';
import { DEFAULT_HIDDEN_TITLES, type HiddenTitles } from '@workhub-devices/core';

/**
 * Texts the Electron MAIN process shows on its own (tray menu and tooltip, OS notifications).
 * Everything inside the window is localized by the shared UI; these few strings live outside it,
 * so they follow the operating-system language (`app.getLocale()`), English when it is unknown.
 * To add a language: add its tag to `MainLocale` and a table to `TABLES` (the compiler checks it).
 */
export type MainLocale = 'en' | 'tr';

export interface MainTexts {
  trayOpen: string;
  trayQuit: string;
  /** Tray tooltip for a positive unread count. */
  trayUnread(count: number): string;
  replyPlaceholder: string;
  replyAction: string;
  replyFailedTitle: string;
  replyFailedBody: string;
  /** Generic notification titles while content previews are hidden (lock-screen default). */
  hiddenTitles: HiddenTitles;
  /** Prefix of the file name of a recorded voice message. */
  voiceMessage: string;
}

const TABLES: Record<MainLocale, MainTexts> = {
  en: {
    trayOpen: 'Open Workhub',
    trayQuit: 'Quit (notifications stop)',
    trayUnread: (count) => `Workhub — ${count} unread ${count === 1 ? 'message' : 'messages'}`,
    replyPlaceholder: 'Type a reply',
    replyAction: 'Reply',
    replyFailedTitle: 'Reply could not be sent',
    replyFailedBody: 'Open the chat and try again.',
    hiddenTitles: DEFAULT_HIDDEN_TITLES,
    voiceMessage: 'Voice message',
  },
  tr: {
    trayOpen: 'Workhub’u aç',
    trayQuit: 'Çıkış (bildirimler durur)',
    trayUnread: (count) => `Workhub — ${count} okunmamış mesaj`,
    replyPlaceholder: 'Yanıt yazın',
    replyAction: 'Yanıtla',
    replyFailedTitle: 'Yanıt gönderilemedi',
    replyFailedBody: 'Sohbeti açıp tekrar deneyin.',
    hiddenTitles: { chat: 'Yeni mesaj', workhub: 'Workhub bildirimi', other: 'Yeni bildirim' },
    voiceMessage: 'Sesli not',
  },
};

/** `tr-TR`, `tr_TR`, `TR` → `tr`; anything else (including an empty tag) → `en`. */
export function resolveMainLocale(tag: string | null | undefined): MainLocale {
  const primary = (tag ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
  return primary === 'tr' ? 'tr' : 'en';
}

/**
 * Optional `WORKHUB_LOCALE=en|tr` override (smoke tests, screenshots): forces the language of the UI
 * and of these main-process texts. Any other value is ignored. Read once at startup.
 */
export const localeOverride: MainLocale | null = (() => {
  const v = process.env.WORKHUB_LOCALE;
  return v === 'en' || v === 'tr' ? v : null;
})();

/** The table for the OS language; call after Electron's `ready` event (`app.getLocale()` needs it). */
export function mainTexts(): MainTexts {
  return TABLES[localeOverride ?? resolveMainLocale(app.isReady() ? app.getLocale() : '')];
}
