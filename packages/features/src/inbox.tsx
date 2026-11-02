import { FlatList, Pressable, Text, View } from 'react-native';
import { parseServerLink, routeForObject, type AccountId, type AppRoute, type InboxNotification, type ServerBase } from '@workhub-devices/core';
import { useAsync, useServices } from './services';
import { Empty, ErrorBanner, Loading, Row } from './ui';
import { colors, space } from './theme';
import { t } from './i18n';

/** Untrusted notification → typed route only (object id first, then validated server link). */
export function routeOf(n: InboxNotification, serverBase: ServerBase): AppRoute {
  const r = routeForObject(n.app, n.objectType, n.objectId, n.id);
  if (r.name !== 'inbox') return r;
  return (n.link && parseServerLink(serverBase, n.link)) || r;
}

export function InboxScreen({ accountId, serverBase, onRoute }: { accountId: AccountId; serverBase: ServerBase; onRoute: (r: AppRoute) => void }) {
  const { backend } = useServices();
  const s = useAsync(() => backend.notifications(accountId), [accountId]);
  const dismiss = async (id: number) => {
    s.setData((prev) => prev?.filter((n) => n.id !== id));
    try {
      await backend.dismissNotification(accountId, id);
    } catch {
      s.reload();
    }
  };
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ErrorBanner error={s.error} onRetry={s.reload} />
      {s.loading && !s.data ? (
        <Loading />
      ) : (
        <FlatList
          data={s.data ?? []}
          keyExtractor={(n) => String(n.id)}
          refreshing={s.loading}
          onRefresh={s.reload}
          ListEmptyComponent={s.error ? undefined : <Empty text={t.noNotifications} />}
          renderItem={({ item }) => (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Row
                  title={item.subject}
                  subtitle={`${item.app === 'spreed' ? 'Talk' : item.app === 'workhub' ? 'Workhub' : item.app}${item.message ? ` · ${item.message}` : ''}`}
                  right={item.datetime ? new Date(item.datetime).toLocaleString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}
                  onPress={() => {
                    const r = routeOf(item, serverBase);
                    if (r.name !== 'inbox') onRoute(r);
                  }}
                />
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel={`${t.dismiss}: ${item.subject}`} onPress={() => void dismiss(item.id)} style={{ padding: space(3) }}>
                <Text style={{ color: colors.muted, fontSize: 18 }}>×</Text>
              </Pressable>
            </View>
          )}
        />
      )}
    </View>
  );
}
