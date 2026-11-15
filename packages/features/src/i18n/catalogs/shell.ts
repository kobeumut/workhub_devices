import { defineCatalog } from '../core';

/** App shell: login intro, tab bar, server-compatibility notices, account screen and shared UI bits. */
export default defineCatalog(
  {
    // Login.
    loginIntro: 'Connect to your Nextcloud server: chats (Talk) and tasks (Workhub) in one app.',

    // Shell and navigation.
    chatFallbackName: 'Chat',
    selectChat: 'Select a chat',
    selectProject: 'Select a project',
    tabChatsUnread: (label: string, count: number) => `${label}, ${count === 1 ? '1 unread message' : `${count} unread messages`}`,

    // Server compatibility notices (joined with " · " in a banner).
    issueTalkMissing: 'Talk is not installed',
    issueTalkFeatureMissing: (feature: string) => `Talk feature missing: ${feature}`,
    issueNotificationsMissing: 'The Notifications app is missing',
    issueWorkhubMissing: 'Workhub is not installed',
    issueWorkhubApiUnsupported: (version: string) => `Workhub API version is not supported (${version})`,

    // Account screen. `workhub` is null when the server has no Workhub.
    serverInfo: (nextcloud: string, talk: string, workhub: { apiVersion: string; backend: string } | null, webPush: boolean) =>
      `Nextcloud ${nextcloud} · Talk ${talk}${workhub ? ` · Workhub API ${workhub.apiVersion} (${workhub.backend})` : ''}${webPush ? ' · Web Push ready' : ' · Web Push off'}`,

    // Shared UI.
    unreadBadge: (count: number | string) => `${count} unread`,
  },
  {
    loginIntro: 'Nextcloud sunucunuza bağlanın: sohbetler (Talk) ve işler (Workhub) tek uygulamada.',

    chatFallbackName: 'Sohbet',
    selectChat: 'Bir sohbet seçin',
    selectProject: 'Bir proje seçin',
    tabChatsUnread: (label: string, count: number) => `${label}, ${count} okunmamış mesaj`,

    issueTalkMissing: 'Talk kurulu değil',
    issueTalkFeatureMissing: (feature: string) => `Talk özelliği eksik: ${feature}`,
    issueNotificationsMissing: 'Notifications uygulaması yok',
    issueWorkhubMissing: 'Workhub kurulu değil',
    issueWorkhubApiUnsupported: (version: string) => `Workhub API sürümü desteklenmiyor (${version})`,

    serverInfo: (nextcloud: string, talk: string, workhub: { apiVersion: string; backend: string } | null, webPush: boolean) =>
      `Nextcloud ${nextcloud} · Talk ${talk}${workhub ? ` · Workhub API ${workhub.apiVersion} (${workhub.backend})` : ''}${webPush ? ' · Web Push hazır' : ' · Web Push kapalı'}`,

    unreadBadge: (count: number | string) => `${count} okunmamış`,
  },
);
