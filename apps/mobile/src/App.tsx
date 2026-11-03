import { useEffect, useMemo } from 'react';
import { Linking, Platform, StatusBar, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { createDirectBackend, type AccountSummary, type RoutedTarget } from '@workhub-devices/core';
import { WorkhubApp, type PlatformServices } from '@workhub-devices/features';
import { native, nativeEvents, parseNativeRoute, plainStore, secretStore } from './native';
import { accountTag, ensurePush, removePush } from './push';
import { filesSupported, mobileFileHost, mobileFileServices } from './files';
import { createMobileCallMedia } from './call';
import { useAndroidKeyboardPadding } from './keyboard';
import { configureDevLogs } from './devLogs';
import identity from '../../../config/app-identity.json';

configureDevLogs();

const backend = createDirectBackend({
  secrets: secretStore,
  plain: plainStore,
  userAgent: `WorkhubMobile/${identity.version} (${Platform.OS})`,
  // Plain http only for local development builds (emulator → dev server).
  ...(__DEV__ ? { urlOptions: { allowInsecureHttp: true } } : {}),
  onLogout: (a, client) => removePush(a, client),
  ...(filesSupported ? { files: mobileFileHost } : {}),
});

const callMedia = createMobileCallMedia();

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
      appVersion: identity.version,
      saveFile: (filename, content, mime) => native.shareFile(filename, content, mime),
      ...mobileFileServices(),
      ...(callMedia ? { call: callMedia } : {}),
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
  const keyboardPad = useAndroidKeyboardPadding();
  useEffect(() => {
    StatusBar.setBarStyle('dark-content');
  }, []);
  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }} edges={['top', 'bottom']}>
        <View style={{ flex: 1, paddingBottom: keyboardPad }}>
          <WorkhubApp backend={backend} platform={platform} />
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
