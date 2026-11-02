import { useEffect, useMemo } from 'react';
import { Linking, Platform, StatusBar } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { createDirectBackend, type AccountSummary, type RoutedTarget } from '@workhub-devices/core';
import { WorkhubApp, type PlatformServices } from '@workhub-devices/features';
import { native, nativeEvents, parseNativeRoute, plainStore, secretStore } from './native';
import { accountTag, ensurePush, removePush } from './push';

const backend = createDirectBackend({
  secrets: secretStore,
  plain: plainStore,
  userAgent: `WorkhubMobile/0.1 (${Platform.OS})`,
  // Plain http only for local development builds (emulator → dev server).
  ...(__DEV__ ? { urlOptions: { allowInsecureHttp: true } } : {}),
  onLogout: (a, client) => removePush(a, client),
});

async function tagToAccount(tag: string): Promise<AccountSummary | undefined> {
  for (const a of await backend.listAccounts()) if ((await accountTag(a)) === tag) return a;
  return undefined;
}

export default function App() {
  const platform = useMemo<PlatformServices>(
    () => ({
      kind: Platform.OS === 'ios' ? 'ios' : 'android',
      openExternal: async (url) => {
        await Linking.openURL(url);
      },
      appVersion: '0.1.0',
      saveFile: (filename, content, mime) => native.shareFile(filename, content, mime),
      onAccountsChanged: (accounts) => {
        for (const a of accounts) {
          backend
            .session(a.id)
            .then((s) => ensurePush(a, s.webPush))
            .catch(() => undefined);
        }
      },
      onForegroundRoute: (t: RoutedTarget | null) => {
        if (!t || t.route.name !== 'room') return native.setForeground(null, null);
        const token = t.route.token;
        void accountTag({ id: t.accountId }).then((tag) => native.setForeground(tag, token));
      },
      subscribeRoutes: (cb) => {
        const deliver = async (raw: string | null) => {
          const r = parseNativeRoute(raw);
          if (!r) return;
          const a = await tagToAccount(r.tag);
          if (a) cb({ accountId: a.id, route: r.route });
        };
        void native.consumeInitialRoute().then(deliver);
        const sub = nativeEvents.addListener('WorkhubRoute', (raw) => void deliver(typeof raw === 'string' ? raw : null));
        return () => sub.remove();
      },
    }),
    [],
  );
  useEffect(() => {
    StatusBar.setBarStyle('dark-content');
  }, []);
  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }} edges={['top', 'bottom']}>
        <WorkhubApp backend={backend} platform={platform} />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
