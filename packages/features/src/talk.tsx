import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, FlatList, KeyboardAvoidingView, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import {
  activeMentionQuery, classifySendFailure, editableText, fileOf, insertMention, isHiddenSystemMessage, lastServerId, mentionsSelf, mergeRooms, mergeTimeline, messageActions,
  newReferenceId, reactionSummary, reconnectDelay, renderMessageSegments, roomActions, setPendingState, withReactions, TALK_LIMITS,
  type AccountId, type ChatItem, type MentionSuggestion, type MessageSearchHit, type ReactionMap, type TalkFeatures, type TalkMessage, type TalkRoom,
} from '@workhub-devices/core';
import { useAsync, useServices } from './services';
import { Button, Empty, ErrorBanner, Header, Loading, Row, keyboardAvoidBehavior, styles as ui } from './ui';
import { colors, font, space } from './theme';
import { formatTime, t } from './i18n';
import { MessageSearch, NewRoomForm, RoomSettings, SearchResults } from './talkRoom';
import { FileCard, UploadTray, useUploads, VoiceBar } from './talkFiles';
import { CALL_SYSTEM_MESSAGES, CallButtons, OngoingCallBanner, callUnavailableText, useCalls } from './call';

/** Quick reactions offered in the picker (any emoji is accepted by the server). */
const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👏', '😮', '😢', '🙏'];
const plain = (m: Pick<TalkMessage, 'message' | 'messageParameters'>) => renderMessageSegments(m.message, m.messageParameters).map((s) => s.text).join('');

const ROOM_REFRESH_MS = 30_000;

function lastMessagePreview(r: TalkRoom): string {
  const m = r.lastMessage as TalkMessage | undefined;
  if (!m || !('message' in m)) return '';
  const text = renderMessageSegments(m.message, m.messageParameters).map((s) => s.text).join('');
  return m.actorDisplayName && m.systemMessage === '' ? `${m.actorDisplayName}: ${text}` : text;
}

export function RoomList({ accountId, selected, onOpen, features, canCreate, version = 0 }: {
  accountId: AccountId;
  selected?: string;
  onOpen: (r: { token: string; displayName: string }) => void;
  features?: TalkFeatures;
  canCreate?: boolean;
  /** Bumped by the parent after a room was left/deleted/renamed → full reload. */
  version?: number;
}) {
  const { backend } = useServices();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [hits, setHits] = useState<MessageSearchHit[] | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<unknown>();
  const cursor = useRef<number | null>(null);
  const state = useAsync(async () => {
    const r = await backend.rooms(accountId);
    cursor.current = r.modifiedBefore;
    return mergeRooms([], r.rooms, 'full');
  }, [accountId, version]);

  useEffect(() => setHits(null), [query]);
  const searchMessages = async () => {
    setSearchBusy(true);
    setSearchError(undefined);
    try {
      setHits((await backend.searchMessages(accountId, query.trim().slice(0, TALK_LIMITS.searchTerm), null, null)).hits);
    } catch (e) {
      setSearchError(e);
    } finally {
      setSearchBusy(false);
    }
  };

  // Foreground refresh: deltas while visible, full reload every 5th tick (deletions aren't in deltas).
  useEffect(() => {
    let n = 0;
    const id = setInterval(async () => {
      if (AppState.currentState !== 'active') return;
      n++;
      try {
        if (n % 5 === 0 || !cursor.current) return state.reload();
        const r = await backend.rooms(accountId, cursor.current);
        cursor.current = r.modifiedBefore ?? cursor.current;
        if (r.rooms.length) state.setData((prev) => mergeRooms(prev ?? [], r.rooms, 'delta'));
      } catch {
        /* surfaced on next full reload */
      }
    }, ROOM_REFRESH_MS);
    return () => clearInterval(id);
  }, [accountId, backend, state]);

  const rooms = (state.data ?? []).filter((r) => !query || r.displayName.toLocaleLowerCase('tr').includes(query.toLocaleLowerCase('tr')));
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ padding: space(2), flexDirection: 'row', gap: space(2), alignItems: 'center' }}>
        <TextInput
          accessibilityLabel="Sohbetlerde ara"
          placeholder="Ara"
          placeholderTextColor={colors.muted}
          value={query}
          onChangeText={setQuery}
          style={[ui.input, { flex: 1 }]}
        />
        {canCreate && !creating ? <Button kind="secondary" title="+ Yeni sohbet" onPress={() => setCreating(true)} /> : null}
      </View>
      {creating ? (
        <NewRoomForm
          accountId={accountId}
          onCancel={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false);
            state.reload();
            onOpen(r);
          }}
        />
      ) : null}
      {features?.search && query.trim() ? (
        <View>
          {!hits ? (
            <View style={{ paddingHorizontal: space(2) }}>
              <Button kind="secondary" title={`Mesajlarda ara: “${query.trim()}”`} accessibilityLabel="Mesajlarda ara" onPress={() => void searchMessages()} busy={searchBusy} />
            </View>
          ) : (
            <View style={{ maxHeight: 280 }}>
              <Text accessibilityRole="header" style={{ paddingHorizontal: space(4), fontWeight: '700', color: colors.text }}>Mesajlar ({hits.length})</Text>
              <ScrollView>
                {hits.length ? (
                  <SearchResults hits={hits} onPick={(h) => onOpen({ token: h.token, displayName: state.data?.find((r) => r.token === h.token)?.displayName ?? '' })} />
                ) : (
                  <Text style={{ color: colors.muted, padding: space(4) }}>Eşleşen mesaj yok.</Text>
                )}
              </ScrollView>
            </View>
          )}
          <ErrorBanner error={searchError} />
        </View>
      ) : null}
      <ErrorBanner error={state.error} onRetry={state.reload} />
      {state.loading && !state.data ? (
        <Loading />
      ) : (
        <FlatList
          data={rooms}
          keyExtractor={(r) => r.token}
          refreshing={state.loading}
          onRefresh={state.reload}
          ListEmptyComponent={<Empty text={t.noRooms} />}
          renderItem={({ item }) => (
            <Row
              title={`${item.isFavorite ? '★ ' : ''}${item.displayName}`}
              subtitle={lastMessagePreview(item)}
              right={item.lastActivity ? formatTime(item.lastActivity) : ''}
              badge={item.unreadMessages > 0 ? (item.unreadMention ? `@${item.unreadMessages}` : item.unreadMessages) : undefined}
              selected={item.token === selected}
              onPress={() => onOpen(item)}
            />
          )}
        />
      )}
    </View>
  );
}

function MessageText({ m, selfId }: { m: TalkMessage; selfId: string }) {
  const segs = renderMessageSegments(m.message, m.messageParameters);
  return (
    <Text style={{ color: colors.text, fontSize: font.body }} selectable>
      {segs.map((s, i) =>
        s.type === 'mention' ? (
          <Text
            key={i}
            accessibilityLabel={`Bahsedilen: ${s.text.slice(1)}`}
            style={[{ color: colors.primary, fontWeight: '600' }, (s.mentionType === 'user' && s.id === selfId) || s.mentionType === 'call' ? { backgroundColor: colors.bubbleMine } : null]}
          >
            {s.text}
          </Text>
        ) : s.type === 'file' ? (
          <Text key={i} style={{ textDecorationLine: 'underline' }}>
            📎 {s.text}
          </Text>
        ) : (
          <Text key={i}>{s.text}</Text>
        ),
      )}
    </Text>
  );
}

type Mode = { kind: 'reply'; message: TalkMessage } | { kind: 'edit'; message: TalkMessage } | null;

/**
 * Chat: history (no read-marker side effect) → bounded long-poll while visible & app active →
 * explicit read marker for the focused chat → optimistic send reconciled by referenceId.
 * Reply / edit / delete / reactions / mentions / search / room settings are capability-gated
 * (`features`) and role-gated from the CURRENT room; edits, deletions and reactions of others
 * arrive through the same feed (update system messages, merged by `mergeTimeline`).
 */
export function ChatView({ accountId, room: roomRef, selfId, features, onBack, onRoomChanged, onRoomGone }: {
  accountId: AccountId;
  room: { token: string; displayName: string };
  selfId: string;
  features: TalkFeatures;
  onBack?: () => void;
  onRoomChanged?: () => void;
  onRoomGone?: () => void;
}) {
  const { backend, platform } = useServices();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [error, setError] = useState<unknown>();
  const [actionError, setActionError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>();
  const [mode, setMode] = useState<Mode>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [picker, setPicker] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [reactors, setReactors] = useState<{ id: number; map: ReactionMap } | null>(null);
  const [panel, setPanel] = useState<'search' | 'info' | null>(null);
  const [suggestions, setSuggestions] = useState<MentionSuggestion[]>([]);
  const [notice, setNotice] = useState('');
  const [recording, setRecording] = useState(false);
  const uploads = useUploads(accountId, roomRef.token);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const token = roomRef.token;
  const self = { actorType: 'users', actorId: selfId };

  // The CURRENT room drives every role/permission gate (re-read after management actions).
  const roomState = useAsync(() => backend.talkRoom(accountId, token), [accountId, token]);
  const room = roomState.data;
  const reloadRoom = roomState.reload;
  const acts = room ? roomActions(room, features) : null;
  const title = room?.displayName || roomRef.displayName;
  const calls = useCalls();
  const callNote = callUnavailableText(room, calls);

  useEffect(() => {
    platform.onForegroundRoute?.({ accountId, route: { name: 'room', token } });
    return () => platform.onForegroundRoute?.(null);
  }, [accountId, token, platform]);

  const markReadUpTo = useCallback(
    (list: ChatItem[]) => {
      const last = lastServerId(list);
      if (last && AppState.currentState === 'active') backend.markRead(accountId, token, last).catch(() => {});
    },
    [accountId, token, backend],
  );

  // initial history
  useEffect(() => {
    let alive = true;
    setItems([]);
    setLoading(true);
    setError(undefined);
    backend
      .chat(accountId, token, { lookIntoFuture: false, limit: 100 })
      .then((r) => {
        if (!alive) return;
        const merged = mergeTimeline([], r.messages);
        setItems(merged);
        markReadUpTo(merged);
      })
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [accountId, token, backend, markReadUpTo]);

  // long-poll loop
  useEffect(() => {
    if (loading) return;
    let alive = true;
    let attempt = 0;
    let pollId = '';
    const loop = async () => {
      while (alive) {
        if (AppState.currentState !== 'active') {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        pollId = `poll-${token}-${Date.now()}`;
        try {
          const last = lastServerId(itemsRef.current);
          const r = await backend.chat(accountId, token, { lookIntoFuture: true, timeout: 30, pollId, ...(last ? { lastKnownMessageId: last } : {}) });
          attempt = 0;
          if (!alive) return;
          setError(undefined);
          if (r.messages.length) {
            const merged = mergeTimeline(itemsRef.current, r.messages);
            setItems(merged);
            markReadUpTo(merged);
            // Room renamed / permissions changed by someone else → refresh the gate source.
            // Calls started/ended → `hasCall` for the join banner.
            if (r.messages.some((m) => /^(conversation_renamed|description_set|description_removed|moderator_promoted|moderator_demoted|read_only|read_only_off|user_removed|lobby_.*)$/.test(m.systemMessage) || CALL_SYSTEM_MESSAGES.has(m.systemMessage))) reloadRoom();
          }
        } catch (e) {
          if (!alive) return;
          setError(attempt > 1 ? e : undefined);
          await new Promise((r) => setTimeout(r, reconnectDelay(attempt++)));
        }
      }
    };
    void loop();
    return () => {
      alive = false;
      if (pollId) void backend.cancel(pollId);
    };
  }, [accountId, token, backend, loading, markReadUpTo, reloadRoom]);

  // Mention autocomplete for the `@…` word before the caret (debounced).
  const mentionAt = features.mentions && acts?.chat ? activeMentionQuery(text, caret) : null;
  const mentionQuery = mentionAt?.query ?? null;
  useEffect(() => {
    if (mentionQuery === null) {
      setSuggestions([]);
      return;
    }
    let alive = true;
    const id = setTimeout(() => {
      backend.mentions(accountId, token, mentionQuery).then((s) => alive && setSuggestions(s.slice(0, 8)), () => alive && setSuggestions([]));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [mentionQuery, accountId, token, backend]);

  const pickMention = (s: MentionSuggestion) => {
    if (!mentionAt) return;
    const r = insertMention(text, mentionAt, s.mentionId);
    setText(r.text);
    setCaret(r.caret);
    setSelection({ start: r.caret, end: r.caret });
    setSuggestions([]);
  };

  const replaceMessage = (id: number, fn: (m: TalkMessage) => TalkMessage) =>
    setItems((prev) => prev.map((it) => (it.kind === 'server' && it.message.id === id ? { ...it, message: fn(it.message) } : it)));

  const runAction = async (fn: () => Promise<void>) => {
    setActionError(undefined);
    try {
      await fn();
    } catch (e) {
      setActionError(e);
    }
  };

  const sendText = async (message: string, referenceId = newReferenceId(), replyTo?: number) => {
    if (!message.trim()) return;
    setItems((prev) => [...prev.filter((p) => !(p.kind === 'pending' && p.referenceId === referenceId)), { kind: 'pending', referenceId, text: message, state: 'sending', createdAt: Date.now() }]);
    try {
      const m = await backend.send(accountId, token, message, referenceId, ...(replyTo ? [replyTo] : []));
      if (m) setItems((prev) => mergeTimeline(prev, [m]));
    } catch (e) {
      const st = classifySendFailure(e);
      setItems((prev) => setPendingState(prev, referenceId, st));
      if (st === 'unknown') {
        // reconcile: a lost response may still have been stored; the poll/history will show it
        try {
          const r = await backend.chat(accountId, token, { lookIntoFuture: false, limit: 30 });
          setItems((prev) => {
            const merged = mergeTimeline(prev, r.messages);
            return merged.some((i) => i.kind === 'pending' && i.referenceId === referenceId) ? setPendingState(merged, referenceId, 'failed') : merged;
          });
        } catch {
          setItems((prev) => setPendingState(prev, referenceId, 'failed'));
        }
      }
    }
  };
  const replyTargets = useRef(new Map<string, number>());

  const submit = () => {
    const msg = text;
    if (!msg.trim()) return;
    if (mode?.kind === 'edit') {
      const id = mode.message.id;
      void runAction(async () => {
        const sys = await backend.editMessage(accountId, token, id, msg);
        setItems((prev) => mergeTimeline(prev, [sys]));
        setMode(null);
        setText('');
        setNotice('Mesaj düzenlendi.');
      });
      return;
    }
    setText('');
    setCaret(0);
    const ref = newReferenceId();
    const replyTo = mode?.kind === 'reply' ? mode.message.id : undefined;
    if (replyTo) replyTargets.current.set(ref, replyTo);
    setMode(null);
    void sendText(msg, ref, replyTo);
  };

  /** Pick files → upload + share each; the composer text becomes the caption of a single file. */
  const attach = async () => {
    setActionError(undefined);
    try {
      const picked = (await platform.files?.pick()) ?? [];
      if (!picked.length) return;
      const caption = features.caption && picked.length === 1 && mode?.kind !== 'edit' && text.trim() ? text.trim() : undefined;
      const replyTo = mode?.kind === 'reply' ? mode.message.id : undefined;
      if (caption) {
        setText('');
        setCaret(0);
      }
      if (replyTo) setMode(null);
      picked.forEach((f, i) => uploads.start(f, { ...(i === 0 && caption ? { caption } : {}), ...(i === 0 && replyTo ? { replyTo } : {}) }));
    } catch (e) {
      setActionError(e);
    }
  };
  const canAttach = !!acts?.chat && features.files && !!platform.files;
  const canRecord = !!acts?.chat && features.voice && !!platform.voice && !!platform.files;

  const toggleReaction = (m: TalkMessage, emoji: string, mine: boolean) =>
    runAction(async () => {
      const map = await backend.react(accountId, token, m.id, emoji, !mine);
      replaceMessage(m.id, (x) => withReactions(x, map, self));
      setPicker(null);
      setSelected(null);
    });

  if (panel === 'info' && room && acts) {
    return (
      <RoomSettings
        accountId={accountId}
        room={room}
        features={features}
        selfId={selfId}
        onClose={() => setPanel(null)}
        onChanged={(r) => {
          roomState.setData(() => r);
          onRoomChanged?.();
        }}
        onGone={() => onRoomGone?.()}
      />
    );
  }

  const reversed = [...items].filter((i) => i.kind === 'pending' || !isHiddenSystemMessage(i.message)).reverse();
  const nowSec = Math.floor(Date.now() / 1000);
  return (
    <KeyboardAvoidingView behavior={keyboardAvoidBehavior} style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header
        title={title}
        {...(onBack ? { onBack } : {})}
        right={
          <View style={{ flexDirection: 'row', gap: space(2), alignItems: 'center' }}>
            <CallButtons room={room} title={title} />
            {features.search ?  <Button kind="secondary" title="🔍 Ara" accessibilityLabel="Bu sohbette ara" onPress={() => { setSelected(null); setPanel(panel === 'search' ? null : 'search'); }} /> : null}
            {room ? <Button kind="secondary" title="Bilgi" accessibilityLabel="Sohbet bilgileri" onPress={() => setPanel('info')} /> : null}
          </View>
        }
      />
      {room?.description ? <Text numberOfLines={1} style={{ paddingHorizontal: space(4), paddingVertical: space(1), color: colors.muted, fontSize: font.small }}>{room.description}</Text> : null}
      <OngoingCallBanner room={room} title={title} />
      {callNote ? <Text accessibilityRole="text" style={{ paddingHorizontal: space(4), paddingVertical: space(1), color: colors.muted, fontSize: font.small }}>Arama yok: {callNote}</Text> : null}
      <ErrorBanner error={error} />
      <ErrorBanner error={actionError ?? roomState.error} />
      {notice ? (
        <Pressable accessibilityRole="alert" onPress={() => setNotice('')} style={{ paddingHorizontal: space(4), paddingVertical: space(1) }}>
          <Text style={{ color: colors.ok }}>{notice}</Text>
        </Pressable>
      ) : null}
      {panel === 'search' ? (
        <View style={{ maxHeight: 320, borderBottomWidth: 1, borderColor: colors.border }}>
          <MessageSearch
            accountId={accountId}
            token={token}
            onClose={() => setPanel(null)}
            onPick={(h) => {
              const loaded = items.some((i) => i.kind === 'server' && i.message.id === h.messageId);
              setSelected(loaded ? h.messageId : null);
              setNotice(loaded ? 'Mesaj seçildi (vurgulu).' : 'Bu mesaj yüklü son 100 mesajdan daha eski.');
              setPanel(null);
            }}
          />
        </View>
      ) : null}
      {loading ? (
        <Loading />
      ) : (
        <FlatList
          inverted
          data={reversed}
          extraData={[selected, picker, confirmDelete, reactors, acts]}
          keyExtractor={(i) => (i.kind === 'server' ? `s${i.message.id}` : `p${i.referenceId}`)}
          ListEmptyComponent={<Empty text={t.noMessages} />}
          contentContainerStyle={{ padding: space(3) }}
          renderItem={({ item }) => {
            if (item.kind === 'pending') {
              return (
                <Pressable
                  accessibilityRole="button"
                  disabled={item.state !== 'failed'}
                  onPress={() => void sendText(item.text, item.referenceId, replyTargets.current.get(item.referenceId))}
                  style={{ alignSelf: 'flex-end', maxWidth: '85%', backgroundColor: colors.bubbleMine, borderRadius: 12, padding: space(2), marginVertical: 2, opacity: 0.8 }}
                >
                  <Text style={{ color: colors.text }}>{item.text}</Text>
                  <Text style={{ fontSize: 11, color: item.state === 'failed' ? colors.danger : colors.muted }}>
                    {item.state === 'sending' ? t.sending : item.state === 'failed' ? t.failed : t.unknownState}
                  </Text>
                </Pressable>
              );
            }
            const m = item.message;
            if (m.systemMessage) {
              return <Text style={{ alignSelf: 'center', color: colors.muted, fontSize: font.small, marginVertical: space(1) }}>{plain(m)}</Text>;
            }
            const mine = m.actorType === 'users' && m.actorId === selfId;
            const deleted = m.messageType === 'comment_deleted';
            const file = deleted ? null : fileOf(m);
            const can = room ? messageActions(m, room, self, features, nowSec) : { reply: false, edit: false, delete: false, react: false };
            const isSel = selected === m.id;
            const reacts = reactionSummary(m);
            const mentioned = !mine && mentionsSelf(m, selfId);
            return (
              <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%', marginVertical: 2 }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSel }}
                  accessibilityHint="Mesaj işlemlerini göster"
                  onPress={() => {
                    setSelected(isSel ? null : m.id);
                    setPicker(null);
                    setConfirmDelete(null);
                    setReactors(null);
                  }}
                  style={{
                    backgroundColor: mine ? colors.bubbleMine : colors.bubbleOther, borderRadius: 12, padding: space(2),
                    borderWidth: isSel || mentioned ? 2 : 0, borderColor: isSel ? colors.primary : colors.border,
                  }}
                >
                  {!mine ? <Text style={{ fontSize: font.small, fontWeight: '700', color: colors.muted }}>{m.actorDisplayName}</Text> : null}
                  {m.parent ? (
                    <Text numberOfLines={2} style={{ fontSize: font.small, color: colors.muted, borderLeftWidth: 2, borderColor: colors.border, paddingLeft: space(2), marginBottom: 2 }}>
                      {'message' in m.parent ? `${m.parent.actorDisplayName}: ${m.parent.messageType === 'comment_deleted' ? 'Silinmiş mesaj' : plain(m.parent)}` : 'Silinmiş mesaj'}
                    </Text>
                  ) : null}
                  {deleted ? (
                    <Text style={{ color: colors.muted, fontStyle: 'italic' }}>🗑 Bu mesaj silindi</Text>
                  ) : file ? (
                    <>
                      {file.caption ? <MessageText m={m} selfId={selfId} /> : null}
                      <FileCard accountId={accountId} token={token} messageId={m.id} file={file} />
                    </>
                  ) : (
                    <MessageText m={m} selfId={selfId} />
                  )}
                  <Text style={{ fontSize: 11, color: colors.muted, alignSelf: 'flex-end' }}>
                    {formatTime(m.timestamp)}
                    {m.lastEditTimestamp && !deleted ? ' · düzenlendi' : ''}
                  </Text>
                </Pressable>
                {reacts.length && !deleted ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(1), marginTop: 2, justifyContent: mine ? 'flex-end' : 'flex-start' }}>
                    {reacts.map((r) => (
                      <Pressable
                        key={r.emoji}
                        accessibilityRole="button"
                        accessibilityLabel={`${r.emoji} tepkisi, ${r.count} kişi${r.self ? ', sizin tepkiniz — kaldırmak için dokunun' : can.react ? ' — eklemek için dokunun' : ''}`}
                        accessibilityState={{ selected: r.self, disabled: !can.react }}
                        onPress={can.react ? () => void toggleReaction(m, r.emoji, r.self) : undefined}
                        style={{ flexDirection: 'row', paddingHorizontal: space(2), paddingVertical: 2, borderRadius: 12, borderWidth: 1, borderColor: r.self ? colors.primary : colors.border, backgroundColor: r.self ? colors.bubbleMine : colors.bg }}
                      >
                        <Text>{r.emoji} {r.count}</Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
                {isSel && !deleted ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(1), marginTop: space(1), justifyContent: mine ? 'flex-end' : 'flex-start' }}>
                    {can.reply ? <Button kind="secondary" title="Yanıtla" onPress={() => { setMode({ kind: 'reply', message: m }); setSelected(null); }} /> : null}
                    {can.edit ? <Button kind="secondary" title="Düzenle" accessibilityLabel="Mesajı düzenle" onPress={() => { setMode({ kind: 'edit', message: m }); setText(editableText(m)); setSelected(null); }} /> : null}
                    {can.react ? <Button kind="secondary" title="Tepki ekle" onPress={() => setPicker(picker === m.id ? null : m.id)} /> : null}
                    {features.reactions && reacts.length ? (
                      <Button kind="secondary" title="Tepki verenler" onPress={() => void runAction(async () => setReactors({ id: m.id, map: await backend.reactions(accountId, token, m.id) }))} />
                    ) : null}
                    {can.delete ? (
                      confirmDelete === m.id ? (
                        <Button kind="danger" title="Evet, sil" onPress={() => void runAction(async () => {
                          const sys = await backend.deleteMessage(accountId, token, m.id);
                          setItems((prev) => mergeTimeline(prev, [sys]));
                          setSelected(null);
                          setConfirmDelete(null);
                        })} />
                      ) : (
                        <Button kind="danger" title="Sil" accessibilityLabel="Mesajı sil" onPress={() => setConfirmDelete(m.id)} />
                      )
                    ) : null}
                    {!can.reply && !can.edit && !can.react && !can.delete ? <Text style={{ color: colors.muted, fontSize: font.small }}>Bu mesaj için işlem yok.</Text> : null}
                  </View>
                ) : null}
                {picker === m.id ? (
                  <View accessibilityLabel="Tepki seç" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(1), marginTop: space(1) }}>
                    {QUICK_REACTIONS.map((e) => {
                      const minePrev = (m.reactionsSelf ?? []).includes(e);
                      return (
                        <Pressable key={e} accessibilityRole="button" accessibilityLabel={`${e} tepkisi ${minePrev ? 'kaldır' : 'ekle'}`} onPress={() => void toggleReaction(m, e, minePrev)}
                          style={{ padding: space(1), borderRadius: 8, borderWidth: 1, borderColor: minePrev ? colors.primary : colors.border }}>
                          <Text style={{ fontSize: 20 }}>{e}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
                {reactors?.id === m.id ? (
                  <View accessibilityRole="summary" style={{ marginTop: space(1), padding: space(2), borderRadius: 8, backgroundColor: colors.surface }}>
                    {Object.entries(reactors.map).map(([emoji, actors]) => (
                      <Text key={emoji} style={{ color: colors.text }}>{emoji} {actors.map((a) => a.actorDisplayName || a.actorId).join(', ')}</Text>
                    ))}
                  </View>
                ) : null}
              </View>
            );
          }}
        />
      )}
      {mode ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space(3), paddingTop: space(2), gap: space(2), borderTopWidth: 1, borderColor: colors.border }}>
          <Text numberOfLines={1} style={{ flex: 1, color: colors.muted, borderLeftWidth: 2, borderColor: colors.primary, paddingLeft: space(2) }}>
            {mode.kind === 'reply' ? `Yanıtlanıyor — ${mode.message.actorDisplayName}: ${plain(mode.message)}` : 'Mesaj düzenleniyor'}
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel={mode.kind === 'reply' ? 'Yanıtı iptal et' : 'Düzenlemeyi iptal et'} onPress={() => { if (mode.kind === 'edit') setText(''); setMode(null); }} hitSlop={8}>
            <Text style={{ color: colors.primary, fontSize: font.title }}>✕</Text>
          </Pressable>
        </View>
      ) : null}
      {suggestions.length ? (
        <View accessibilityLabel="Bahsetme önerileri" style={{ borderTopWidth: 1, borderColor: colors.border, maxHeight: 200 }}>
          <ScrollView keyboardShouldPersistTaps="always">
            {suggestions.map((s) => (
              <Pressable key={`${s.source}:${s.mentionId}`} accessibilityRole="button" accessibilityLabel={`Bahset: ${s.label}`} onPress={() => pickMention(s)}
                style={{ paddingHorizontal: space(4), paddingVertical: space(2) }}>
                <Text style={{ color: colors.text }}>
                  @{s.label} <Text style={{ color: colors.muted, fontSize: font.small }}>{s.source === 'calls' ? 'herkes' : s.source === 'groups' ? 'grup' : s.mentionId}</Text>
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}
      <UploadTray uploads={uploads} />
      {recording ? (
        <VoiceBar
          onRecorded={(f) => uploads.start(f, { voice: true, ...(mode?.kind === 'reply' ? { replyTo: mode.message.id } : {}) })}
          onError={setActionError}
          onClose={() => setRecording(false)}
        />
      ) : acts && !acts.chat ? (
        <Text style={{ padding: space(3), color: colors.muted, borderTopWidth: 1, borderColor: colors.border }}>Bu sohbette mesaj yazma izniniz yok (salt okunur veya kısıtlı).</Text>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', padding: space(2), borderTopWidth: mode ? 0 : 1, borderColor: colors.border, gap: space(2) }}>
          {canAttach ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Dosya ekle" accessibilityHint={features.caption ? 'Yazdığınız metin tek dosyada açıklama olarak gönderilir' : undefined} onPress={() => void attach()} style={[ui.button, ui.secondary, { paddingHorizontal: space(3) }]}>
              <Text style={{ fontSize: font.title }}>📎</Text>
            </Pressable>
          ) : null}
          {canRecord ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Sesli not kaydet" onPress={() => { setActionError(undefined); setRecording(true); }} style={[ui.button, ui.secondary, { paddingHorizontal: space(3) }]}>
              <Text style={{ fontSize: font.title }}>🎤</Text>
            </Pressable>
          ) : null}
          <TextInput
            accessibilityLabel={t.messagePlaceholder}
            placeholder={t.messagePlaceholder}
            placeholderTextColor={colors.muted}
            value={text}
            onChangeText={(v) => {
              setText(v);
              // Typing is usually at the end; onSelectionChange corrects it when not.
              setCaret(v.length);
              setSelection(undefined);
            }}
            {...(selection ? { selection } : {})}
            onSelectionChange={(e) => setCaret(e.nativeEvent.selection.end)}
            maxLength={TALK_LIMITS.message}
            multiline
            style={[ui.input, { flex: 1, maxHeight: 140, paddingTop: 10 }]}
            onKeyPress={(e) => {
              // Desktop: Enter sends, Shift+Enter newline
              const ne = e.nativeEvent as { key?: string; shiftKey?: boolean };
              if (platform.kind === 'desktop' && ne.key === 'Enter' && !ne.shiftKey) {
                (e as unknown as { preventDefault?: () => void }).preventDefault?.();
                if (suggestions.length && mentionAt) pickMention(suggestions[0]!);
                else submit();
              }
            }}
          />
          <Pressable accessibilityRole="button" accessibilityLabel={mode?.kind === 'edit' ? 'Düzenlemeyi kaydet' : t.send} onPress={submit} disabled={!text.trim()} style={[ui.button, ui.primary, { opacity: text.trim() ? 1 : 0.5 }]}>
            <Text style={ui.buttonText}>{mode?.kind === 'edit' ? t.save : t.send}</Text>
          </Pressable>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}
