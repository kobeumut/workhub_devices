import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { unreadTotal, talkFeaturesOf, type AccountId, type AccountSummary, type AppRoute, type Backend, type RoutedTarget, type SessionInfo } from '@workhub-devices/core';
import { ServicesProvider, useAsync, useServices, type LocalePreference, type PlatformServices } from './services';
import { LoginScreen } from './LoginScreen';
import { ChatView, RoomList } from './talk';
import { useTalkState } from './talkState';
import { BoardScreen, TaskScreen } from './workhub';
import { WorkhubHome, WorkhubWide } from './modules';
import { Icon, type IconName } from './icons';
import { InboxScreen } from './inbox';
import { Button, Empty, ErrorBanner, Header, Loading, card } from './ui';
import { colors, font, space } from './theme';
import { LOCALE_NAMES, SUPPORTED_LOCALES, describeError, detectDeviceLocale, isLocale, messages, setLocale, t, useLocale } from './i18n';

const m = messages.shell;

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

/** The language choice shown in the Account screen; `choose` applies it at once and persists it. */
interface LanguageState {
  pref: LocalePreference;
  choose(pref: LocalePreference): Promise<void>;
}
const LanguageContext = createContext<LanguageState | null>(null);

/** Concrete language for a stored preference; unknown or missing values follow the device. */
const localeFor = (pref: LocalePreference | null | undefined) => (isLocale(pref) ? pref : detectDeviceLocale());

function Root() {
  const { backend, platform } = useServices();
  // Device language synchronously on the very first render (no flash of the wrong language);
  // the saved choice, if the shell can persist one, is applied by the effect below.
  useState(() => {
    setLocale(detectDeviceLocale());
    return true;
  });
  // Re-render the whole tree when the language changes (`t.*` / `messages.*` read the active one).
  useLocale();
  const [pref, setPref] = useState<LocalePreference>('system');
  const pickedInSession = useRef(false);
  useEffect(() => {
    const store = platform.localePreference;
    if (!store) return;
    let alive = true;
    store.load().then(
      (saved) => {
        // A choice made before the stored one arrived wins; a failed read keeps the device language.
        if (!alive || pickedInSession.current) return;
        setPref(isLocale(saved) ? saved : 'system');
        setLocale(localeFor(saved));
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [platform]);
  const choose = useCallback(
    async (next: LocalePreference) => {
      pickedInSession.current = true;
      setPref(next);
      setLocale(localeFor(next));
      await platform.localePreference?.save(next);
    },
    [platform],
  );
  const language = useMemo(() => ({ pref, choose }), [pref, choose]);
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
    <LanguageContext.Provider value={language}>
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
    </LanguageContext.Provider>
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
  const [loggingOut, setLoggingOut] = useState(false);
  const rooms = useTalkState(account.id, !!session.data && !loggingOut);
  const bumpRooms = rooms.reload;
  const unread = unreadTotal(rooms.data ?? []);
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
        <AccountPanel account={account} accounts={accounts} onSwitch={onSwitch} onAdd={onAdd} onLoggedOut={onLoggedOut} onLoggingOut={setLoggingOut} session={undefined} />
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
            state={rooms}
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
        return <AccountPanel account={account} accounts={accounts} onSwitch={onSwitch} onAdd={onAdd} onLoggedOut={onLoggedOut} onLoggingOut={setLoggingOut} session={s} />;
    }
  })();

  const back = wide ? undefined : () => setDetail(detail?.kind === 'task' && detail.from ? { kind: 'project', ...detail.from } : null);
  const detailPane =
    detail?.kind === 'room' ? (
      <ChatView
        key={detail.token}
        accountId={account.id}
        room={{ token: detail.token, displayName: detail.displayName || m.chatFallbackName }}
        selfId={selfId}
        features={talkFeatures}
        onRoomChanged={bumpRooms}
        onRead={bumpRooms}
        onRoomGone={() => {
          setDetail(null);
          bumpRooms();
        }}
        {...(back ? { onBack: back } : {})}
      />
    ) : detail?.kind === 'project' ? (
      <BoardScreen key={detail.id} accountId={account.id} project={detail} me={selfId} onChanged={bumpTasks} onOpenTask={(cardId) => setDetail({ kind: 'task', cardId, from: { id: detail.id, title: detail.title } })} {...(back ? { onBack: back } : {})} />
    ) : detail?.kind === 'task' ? (
      <TaskScreen key={detail.cardId} accountId={account.id} cardId={detail.cardId} timeEnabled={!!s.workhub?.modules.time} goalsEnabled={!!s.workhub?.modules.goals} onChanged={bumpTasks} {...(back || detail.from ? { onBack: () => setDetail(detail.from ? { kind: 'project', ...detail.from } : null) } : {})} />
    ) : null;

  const tabs = (
    <View accessibilityRole="tablist" style={wide ? { width: 88, borderRightWidth: 1, borderColor: colors.border, paddingTop: space(4), backgroundColor: colors.bg } : { flexDirection: 'row', borderTopWidth: 1, borderColor: colors.border, backgroundColor: colors.bg }}>
      {(
        [
          ['chats', t.chats, 'chat'],
          ['tasks', t.tasks, 'tasks'],
          ['inbox', t.inbox, 'bell'],
          ['account', t.account, 'user'],
        ] as const satisfies readonly (readonly [Tab, string, IconName])[]
      ).map(([key, label, icon]) => (
        <Pressable
          key={key}
          accessibilityRole="tab"
          accessibilityState={{ selected: tab === key }}
          accessibilityLabel={key === 'chats' && unread > 0 ? m.tabChatsUnread(label, unread) : label}
          onPress={() => {
            setTab(key);
            setDetail(null);
          }}
          style={{ flex: wide ? undefined : 1, alignItems: 'center', gap: 4, paddingVertical: space(2), minHeight: 56, marginHorizontal: wide ? space(2) : 0, marginBottom: wide ? space(1) : 0 }}
        >
          <View style={{ paddingHorizontal: 16, paddingVertical: 4, borderRadius: 14, backgroundColor: tab === key ? colors.primarySoft : 'transparent' }}>
            <Icon name={icon} size={22} color={tab === key ? colors.primary : colors.muted} strokeWidth={tab === key ? 2.1 : 1.75} />
            {key === 'chats' && unread > 0 ? <Text style={{ position: 'absolute', right: 0, top: -4, borderRadius: 10, paddingHorizontal: 5, backgroundColor: colors.primary, color: '#fff', fontSize: 11 }}>{unread}</Text> : null}
          </View>
          <Text style={{ fontSize: 12, color: tab === key ? colors.primary : colors.muted, fontWeight: tab === key ? '700' : '500' }}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );

  const title = `${tab === 'chats' ? t.chats : tab === 'tasks' ? t.tasks : tab === 'inbox' ? t.inbox : t.account}${accounts.length > 1 ? ` · ${account.loginName}@${new URL(account.serverBase).host}` : ''}`;

  if (wide && tab === 'tasks' && s.workhub) {
    const openProject = detail?.kind === 'project' ? detail : detail?.kind === 'task' && detail.from ? detail.from : null;
    const taskId = detail?.kind === 'task' ? detail.cardId : null;
    return (
      <View style={{ flex: 1, flexDirection: 'row', backgroundColor: colors.bg }}>
        {tabs}
        <View style={{ flex: 1 }}>
          {s.issues.length ? <Incompatible issues={s.issues} /> : null}
          <WorkhubWide
            accountId={account.id}
            serverBase={account.serverBase}
            workhub={s.workhub}
            version={tasksVersion}
            project={openProject?.id ?? null}
            onOpenProject={(p) => setDetail(p ? { kind: 'project', id: p.id, title: p.title } : null)}
            onOpenTask={(cardId) => setDetail({ kind: 'task', cardId })}
            drawer={
              taskId !== null ? (
                <TaskScreen
                  key={taskId}
                  accountId={account.id}
                  cardId={taskId}
                  timeEnabled={!!s.workhub.modules.time}
                  goalsEnabled={!!s.workhub.modules.goals}
                  onChanged={bumpTasks}
                  onClose={() => setDetail(openProject ? { kind: 'project', ...openProject } : null)}
                />
              ) : undefined
            }
          >
            {openProject ? (
              <BoardScreen
                key={openProject.id}
                accountId={account.id}
                project={openProject}
                me={selfId}
                version={tasksVersion}
                onChanged={bumpTasks}
                onOpenTask={(cardId) => setDetail({ kind: 'task', cardId, from: { id: openProject.id, title: openProject.title } })}
              />
            ) : null}
          </WorkhubWide>
        </View>
      </View>
    );
  }

  if (wide) {
    return (
      <View style={{ flex: 1, flexDirection: 'row', backgroundColor: colors.bg }}>
        {tabs}
        <View style={{ width: 360, borderRightWidth: 1, borderColor: colors.border }}>
          <Header title={title} />
          {s.issues.length ? <Incompatible issues={s.issues} /> : null}
          {listPane}
        </View>
        <View style={{ flex: 1 }}>{detailPane ?? <Empty text={tab === 'chats' ? m.selectChat : tab === 'tasks' ? m.selectProject : ' '} />}</View>
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
      i.kind === 'talk_missing' ? m.issueTalkMissing : i.kind === 'talk_feature_missing' ? m.issueTalkFeatureMissing(i.feature) : i.kind === 'notifications_missing' ? m.issueNotificationsMissing : i.kind === 'workhub_missing' ? m.issueWorkhubMissing : m.issueWorkhubApiUnsupported(i.apiVersion ?? '?'),
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

function AccountPanel({ account, accounts, onSwitch, onAdd, onLoggedOut, onLoggingOut, session }: {
  account: AccountSummary;
  accounts: AccountSummary[];
  onSwitch: (id: AccountId) => void;
  onAdd: () => void;
  onLoggedOut: () => void;
  session: SessionInfo | undefined;
  onLoggingOut: (value: boolean) => void;
}) {
  const { backend, platform } = useServices();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const logout = async () => {
    setBusy(true);
    onLoggingOut(true);
    try {
      const r = await backend.logout(account.id);
      setMsg(r.appPasswordRevoked ? t.logoutDone : t.logoutAppPasswordNotRevoked);
      onLoggedOut();
    } catch (e) {
      onLoggingOut(false);
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
            {m.serverInfo(session.nextcloudVersion ?? '?', session.talkVersion ?? '?', session.workhub ?? null, session.webPush)}
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
      <LanguageCard />
      {platform.appVersion ? <Text style={{ color: colors.muted, textAlign: 'center' }}>{t.version} {platform.appVersion}</Text> : null}
    </ScrollView>
  );
}

/** Language picker: the device language or one of the supported languages, applied at once. */
function LanguageCard() {
  const language = useContext(LanguageContext);
  const [error, setError] = useState<unknown>();
  if (!language) return null;
  const options: { pref: LocalePreference; label: string }[] = [
    { pref: 'system', label: t.languageSystem },
    // Endonyms (each language in its own language) so every user can find theirs.
    ...SUPPORTED_LOCALES.map((l) => ({ pref: l, label: LOCALE_NAMES[l] })),
  ];
  return (
    <View style={card}>
      <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(2) }}>
        {t.language}
      </Text>
      <View accessibilityRole="radiogroup">
        {options.map(({ pref, label }) => {
          const selected = language.pref === pref;
          return (
            <Pressable
              key={pref}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              onPress={() => {
                setError(undefined);
                language.choose(pref).catch(setError);
              }}
              style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: space(2) }}
            >
              <Text style={{ color: selected ? colors.primary : colors.text, fontWeight: selected ? '700' : '400' }}>{label}</Text>
              {selected ? <Text style={{ color: colors.primary, fontWeight: '700' }}>✓</Text> : null}
            </Pressable>
          );
        })}
      </View>
      <ErrorBanner error={error} />
    </View>
  );
}
