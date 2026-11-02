import { useCallback, useEffect, useState } from 'react';
import { BackHandler, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { talkFeaturesOf, type AccountId, type AccountSummary, type AppRoute, type Backend, type RoutedTarget, type SessionInfo } from '@workhub-devices/core';
import { ServicesProvider, useAsync, useServices, type PlatformServices } from './services';
import { LoginScreen } from './LoginScreen';
import { ChatView, RoomList } from './talk';
import { BoardScreen, TaskScreen } from './workhub';
import { WorkhubHome } from './modules';
import { InboxScreen } from './inbox';
import { Button, Empty, ErrorBanner, Header, Loading, card } from './ui';
import { colors, font, space } from './theme';
import { describeError, t } from './i18n';

type Tab = 'chats' | 'tasks' | 'inbox' | 'account';
type Detail =
  | { kind: 'room'; token: string; displayName: string }
  | { kind: 'project'; id: number; title: string }
  | { kind: 'task'; cardId: number; from?: { id: number; title: string } }
  | null;

const WIDE = 900;

export function WorkhubApp({ backend, platform }: { backend: Backend; platform: PlatformServices }) {
  return (
    <ServicesProvider backend={backend} platform={platform}>
      <Root />
    </ServicesProvider>
  );
}

function Root() {
  const { backend, platform } = useServices();
  const accounts = useAsync(() => backend.listAccounts(), []);
  const [active, setActive] = useState<AccountId | null>(null);
  const [adding, setAdding] = useState(false);
  const [pendingRoute, setPendingRoute] = useState<RoutedTarget | null>(null);

  const list = accounts.data ?? [];
  useEffect(() => {
    if (!list.length) return setActive(null);
    if (!active || !list.some((a) => a.id === active)) setActive(list[0]!.id);
  }, [list, active]);

  useEffect(() => {
    if (accounts.data) platform.onAccountsChanged?.(accounts.data);
  }, [accounts.data, platform]);

  // Routes from notifications/deep links select the RIGHT account first (multi-account safe).
  useEffect(
    () =>
      platform.subscribeRoutes?.((target) => {
        setPendingRoute(target);
        setActive(target.accountId);
      }),
    [platform],
  );

  if (accounts.loading && !accounts.data) return <Loading />;
  if (!list.length || adding) {
    return (
      <LoginScreen
        onDone={(a) => {
          setAdding(false);
          setActive(a.id);
          accounts.reload();
        }}
        {...(list.length ? { onCancel: () => setAdding(false) } : {})}
      />
    );
  }
  const acc = list.find((a) => a.id === active) ?? list[0]!;
  return (
    <AccountShell
      key={acc.id}
      account={acc}
      accounts={list}
      onSwitch={setActive}
      onAdd={() => setAdding(true)}
      onLoggedOut={() => accounts.reload()}
      pendingRoute={pendingRoute?.accountId === acc.id ? pendingRoute.route : null}
      clearPendingRoute={() => setPendingRoute(null)}
    />
  );
}

function AccountShell({ account, accounts, onSwitch, onAdd, onLoggedOut, pendingRoute, clearPendingRoute }: {
  account: AccountSummary;
  accounts: AccountSummary[];
  onSwitch: (id: AccountId) => void;
  onAdd: () => void;
  onLoggedOut: () => void;
  pendingRoute: AppRoute | null;
  clearPendingRoute: () => void;
}) {
  const { backend } = useServices();
  const session = useAsync(() => backend.session(account.id), [account.id]);
  const [tab, setTab] = useState<Tab>('chats');
  const [detail, setDetail] = useState<Detail>(null);
  const [tasksVersion, setTasksVersion] = useState(0);
  const bumpTasks = useCallback(() => setTasksVersion((v) => v + 1), []);
  const [roomsVersion, setRoomsVersion] = useState(0);
  const bumpRooms = useCallback(() => setRoomsVersion((v) => v + 1), []);
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;

  const go = useCallback((r: AppRoute) => {
    if (r.name === 'room') {
      setTab('chats');
      setDetail({ kind: 'room', token: r.token, displayName: '' });
    } else if (r.name === 'task') {
      setTab('tasks');
      setDetail({ kind: 'task', cardId: r.cardId });
    } else setTab('inbox');
  }, []);

  // Android hardware back: detail → its list (task → board → list) instead of leaving the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!detail) return false;
      setDetail(detail.kind === 'task' && detail.from ? { kind: 'project', ...detail.from } : null);
      return true;
    });
    return () => sub.remove();
  }, [detail]);

  useEffect(() => {
    if (pendingRoute) {
      go(pendingRoute);
      clearPendingRoute();
    }
  }, [pendingRoute, go, clearPendingRoute]);

  if (session.loading && !session.data) return <Loading />;
  if (session.error) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <Header title={t.appName} />
        <ErrorBanner error={session.error} onRetry={session.reload} />
        <AccountPanel account={account} accounts={accounts} onSwitch={onSwitch} onAdd={onAdd} onLoggedOut={onLoggedOut} session={undefined} />
      </View>
    );
  }
  const s = session.data!;
  const selfId = s.workhub?.user.uid ?? account.loginName;
  const talkFeatures = talkFeaturesOf(s.talkFeatures, { attachmentsAllowed: s.talkAttachmentsAllowed });

  const listPane = (() => {
    switch (tab) {
      case 'chats':
        return (
          <RoomList
            accountId={account.id}
            features={talkFeatures}
            canCreate={s.talkCanCreate}
            version={roomsVersion}
            {...(detail?.kind === 'room' ? { selected: detail.token } : {})}
            onOpen={(r) => setDetail({ kind: 'room', token: r.token, displayName: r.displayName })}
          />
        );
      case 'tasks':
        if (!s.workhub) return <Empty text={t.workhubMissing} />;
        return (
          <WorkhubHome
            accountId={account.id}
            serverBase={account.serverBase}
            workhub={s.workhub}
            version={tasksVersion}
            {...(detail?.kind === 'project' ? { selectedProject: detail.id } : {})}
            onOpenProject={(p) => setDetail({ kind: 'project', id: p.id, title: p.title })}
            onOpenTask={(cardId) => setDetail({ kind: 'task', cardId })}
          />
        );
      case 'inbox':
        return <InboxScreen accountId={account.id} serverBase={account.serverBase} onRoute={go} />;
      case 'account':
        return <AccountPanel account={account} accounts={accounts} onSwitch={onSwitch} onAdd={onAdd} onLoggedOut={onLoggedOut} session={s} />;
    }
  })();

  const back = wide ? undefined : () => setDetail(detail?.kind === 'task' && detail.from ? { kind: 'project', ...detail.from } : null);
  const detailPane =
    detail?.kind === 'room' ? (
      <ChatView
        key={detail.token}
        accountId={account.id}
        room={{ token: detail.token, displayName: detail.displayName || 'Sohbet' }}
        selfId={selfId}
        features={talkFeatures}
        onRoomChanged={bumpRooms}
        onRoomGone={() => {
          setDetail(null);
          bumpRooms();
        }}
        {...(back ? { onBack: back } : {})}
      />
    ) : detail?.kind === 'project' ? (
      <BoardScreen key={detail.id} accountId={account.id} project={detail} onChanged={bumpTasks} onOpenTask={(cardId) => setDetail({ kind: 'task', cardId, from: { id: detail.id, title: detail.title } })} {...(back ? { onBack: back } : {})} />
    ) : detail?.kind === 'task' ? (
      <TaskScreen key={detail.cardId} accountId={account.id} cardId={detail.cardId} timeEnabled={!!s.workhub?.modules.time} goalsEnabled={!!s.workhub?.modules.goals} onChanged={bumpTasks} {...(back || detail.from ? { onBack: () => setDetail(detail.from ? { kind: 'project', ...detail.from } : null) } : {})} />
    ) : null;

  const tabs = (
    <View accessibilityRole="tablist" style={wide ? { width: 84, borderRightWidth: 1, borderColor: colors.border, paddingTop: space(4), backgroundColor: colors.surface } : { flexDirection: 'row', borderTopWidth: 1, borderColor: colors.border, backgroundColor: colors.bg }}>
      {(
        [
          ['chats', t.chats, '💬'],
          ['tasks', t.tasks, '✓'],
          ['inbox', t.inbox, '🔔'],
          ['account', t.account, '👤'],
        ] as const
      ).map(([key, label, icon]) => (
        <Pressable
          key={key}
          accessibilityRole="tab"
          accessibilityState={{ selected: tab === key }}
          accessibilityLabel={label}
          onPress={() => {
            setTab(key);
            setDetail(null);
          }}
          style={{ flex: wide ? undefined : 1, alignItems: 'center', paddingVertical: space(2), minHeight: 52 }}
        >
          <Text style={{ fontSize: 18 }}>{icon}</Text>
          <Text style={{ fontSize: 12, color: tab === key ? colors.primary : colors.muted, fontWeight: tab === key ? '700' : '400' }}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );

  const title = `${tab === 'chats' ? t.chats : tab === 'tasks' ? t.tasks : tab === 'inbox' ? t.inbox : t.account}${accounts.length > 1 ? ` · ${account.loginName}@${new URL(account.serverBase).host}` : ''}`;

  if (wide) {
    return (
      <View style={{ flex: 1, flexDirection: 'row', backgroundColor: colors.bg }}>
        {tabs}
        <View style={{ width: 360, borderRightWidth: 1, borderColor: colors.border }}>
          <Header title={title} />
          {s.issues.length ? <Incompatible issues={s.issues} /> : null}
          {listPane}
        </View>
        <View style={{ flex: 1 }}>{detailPane ?? <Empty text={tab === 'chats' ? 'Bir sohbet seçin' : tab === 'tasks' ? 'Bir proje seçin' : ' '} />}</View>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {detailPane ?? (
        <View style={{ flex: 1 }}>
          <Header title={title} />
          {s.issues.length ? <Incompatible issues={s.issues} /> : null}
          {listPane}
        </View>
      )}
      {detailPane ? null : tabs}
    </View>
  );
}

function Incompatible({ issues }: { issues: SessionInfo['issues'] }) {
  const text = issues
    .map((i) =>
      i.kind === 'talk_missing' ? 'Talk kurulu değil' : i.kind === 'talk_feature_missing' ? `Talk özelliği eksik: ${i.feature}` : i.kind === 'notifications_missing' ? 'Notifications uygulaması yok' : i.kind === 'workhub_missing' ? 'Workhub kurulu değil' : `Workhub API sürümü desteklenmiyor (${i.apiVersion ?? '?'})`,
    )
    .join(' · ');
  return (
    <View accessibilityRole="alert" style={{ backgroundColor: '#fff4e5', padding: space(3) }}>
      <Text style={{ color: '#7a4b00' }}>
        {t.incompatible}: {text}
      </Text>
    </View>
  );
}

function AccountPanel({ account, accounts, onSwitch, onAdd, onLoggedOut, session }: {
  account: AccountSummary;
  accounts: AccountSummary[];
  onSwitch: (id: AccountId) => void;
  onAdd: () => void;
  onLoggedOut: () => void;
  session: SessionInfo | undefined;
}) {
  const { backend, platform } = useServices();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const logout = async () => {
    setBusy(true);
    try {
      const r = await backend.logout(account.id);
      setMsg(r.appPasswordRevoked ? t.logoutDone : `${t.logoutDone} Sunucudaki uygulama parolası çevrimdışı olduğu için iptal edilemedi; Nextcloud ayarlarından silebilirsiniz.`);
      onLoggedOut();
    } catch (e) {
      setMsg(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScrollView contentContainerStyle={{ padding: space(3) }}>
      <View style={card}>
        <Text style={{ fontSize: font.title, fontWeight: '700' }}>{account.loginName}</Text>
        <Text style={{ color: colors.muted }}>{account.serverBase}</Text>
        {session ? (
          <Text style={{ color: colors.muted, marginTop: space(2), fontSize: font.small }}>
            Nextcloud {session.nextcloudVersion ?? '?'} · Talk {session.talkVersion ?? '?'}
            {session.workhub ? ` · Workhub API ${session.workhub.apiVersion} (${session.workhub.backend})` : ''}
            {session.webPush ? ' · Web Push hazır' : ' · Web Push kapalı'}
          </Text>
        ) : null}
        <Button title={t.logout} kind="danger" onPress={() => void logout()} busy={busy} />
        {msg ? <Text style={{ color: colors.muted }}>{msg}</Text> : null}
      </View>
      <View style={card}>
        <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(2) }}>
          {t.servers}
        </Text>
        {accounts.map((a) => (
          <Pressable key={a.id} accessibilityRole="button" accessibilityState={{ selected: a.id === account.id }} onPress={() => onSwitch(a.id)} style={{ paddingVertical: space(2) }}>
            <Text style={{ color: a.id === account.id ? colors.primary : colors.text, fontWeight: a.id === account.id ? '700' : '400' }}>
              {a.loginName} — {new URL(a.serverBase).host}
            </Text>
          </Pressable>
        ))}
        <Button title={t.addAccount} kind="secondary" onPress={onAdd} />
      </View>
      {platform.appVersion ? <Text style={{ color: colors.muted, textAlign: 'center' }}>{t.version} {platform.appVersion}</Text> : null}
    </ScrollView>
  );
}
