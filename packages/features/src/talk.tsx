import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, FlatList, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import {
  classifySendFailure, lastServerId, mergeRooms, mergeTimeline, newReferenceId, reconnectDelay, renderMessageSegments, setPendingState,
  type AccountId, type ChatItem, type TalkMessage, type TalkRoom,
} from '@workhub-devices/core';
import { useAsync, useServices } from './services';
import { Empty, ErrorBanner, Header, Loading, Row, styles as ui } from './ui';
import { colors, font, space } from './theme';
import { formatTime, t } from './i18n';

const ROOM_REFRESH_MS = 30_000;

function lastMessagePreview(r: TalkRoom): string {
  const m = r.lastMessage as TalkMessage | undefined;
  if (!m || !('message' in m)) return '';
  const text = renderMessageSegments(m.message, m.messageParameters).map((s) => s.text).join('');
  return m.actorDisplayName && m.systemMessage === '' ? `${m.actorDisplayName}: ${text}` : text;
}

export function RoomList({ accountId, selected, onOpen }: { accountId: AccountId; selected?: string; onOpen: (r: TalkRoom) => void }) {
  const { backend } = useServices();
  const [query, setQuery] = useState('');
  const cursor = useRef<number | null>(null);
  const state = useAsync(async () => {
    const r = await backend.rooms(accountId);
    cursor.current = r.modifiedBefore;
    return mergeRooms([], r.rooms, 'full');
  }, [accountId]);

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
      <View style={{ padding: space(2) }}>
        <TextInput
          accessibilityLabel="Sohbetlerde ara"
          placeholder="Ara"
          placeholderTextColor={colors.muted}
          value={query}
          onChangeText={setQuery}
          style={ui.input}
        />
      </View>
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

function MessageText({ m }: { m: TalkMessage }) {
  const segs = renderMessageSegments(m.message, m.messageParameters);
  return (
    <Text style={{ color: colors.text, fontSize: font.body }} selectable>
      {segs.map((s, i) =>
        s.type === 'mention' ? (
          <Text key={i} style={{ color: colors.primary, fontWeight: '600' }}>
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

/**
 * Chat: history (no read-marker side effect) → bounded long-poll while visible & app active →
 * explicit read marker for the focused chat → optimistic send reconciled by referenceId.
 */
export function ChatView({ accountId, room, selfId, onBack }: { accountId: AccountId; room: { token: string; displayName: string }; selfId: string; onBack?: () => void }) {
  const { backend, platform } = useServices();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const token = room.token;

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
  }, [accountId, token, backend, loading, markReadUpTo]);

  const sendText = async (message: string, referenceId = newReferenceId()) => {
    if (!message.trim()) return;
    setItems((prev) => [...prev.filter((p) => !(p.kind === 'pending' && p.referenceId === referenceId)), { kind: 'pending', referenceId, text: message, state: 'sending', createdAt: Date.now() }]);
    try {
      const m = await backend.send(accountId, token, message, referenceId);
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

  const submit = () => {
    const msg = text;
    setText('');
    void sendText(msg);
  };

  const reversed = [...items].reverse();
  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title={room.displayName} {...(onBack ? { onBack } : {})} />
      <ErrorBanner error={error} />
      {loading ? (
        <Loading />
      ) : (
        <FlatList
          inverted
          data={reversed}
          keyExtractor={(i) => (i.kind === 'server' ? `s${i.message.id}` : `p${i.referenceId}`)}
          ListEmptyComponent={<Empty text={t.noMessages} />}
          contentContainerStyle={{ padding: space(3) }}
          renderItem={({ item }) => {
            if (item.kind === 'pending') {
              return (
                <Pressable
                  accessibilityRole="button"
                  disabled={item.state !== 'failed'}
                  onPress={() => void sendText(item.text, item.referenceId)}
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
              return <Text style={{ alignSelf: 'center', color: colors.muted, fontSize: font.small, marginVertical: space(1) }}>{renderMessageSegments(m.message, m.messageParameters).map((s) => s.text).join('')}</Text>;
            }
            const mine = m.actorType === 'users' && m.actorId === selfId;
            return (
              <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%', backgroundColor: mine ? colors.bubbleMine : colors.bubbleOther, borderRadius: 12, padding: space(2), marginVertical: 2 }}>
                {!mine ? <Text style={{ fontSize: font.small, fontWeight: '700', color: colors.muted }}>{m.actorDisplayName}</Text> : null}
                {m.parent && 'message' in m.parent ? (
                  <Text numberOfLines={2} style={{ fontSize: font.small, color: colors.muted, borderLeftWidth: 2, borderColor: colors.border, paddingLeft: space(2), marginBottom: 2 }}>
                    {m.parent.actorDisplayName}: {renderMessageSegments(m.parent.message, m.parent.messageParameters).map((s) => s.text).join('')}
                  </Text>
                ) : null}
                <MessageText m={m} />
                <Text style={{ fontSize: 11, color: colors.muted, alignSelf: 'flex-end' }}>{formatTime(m.timestamp)}</Text>
              </View>
            );
          }}
        />
      )}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', padding: space(2), borderTopWidth: 1, borderColor: colors.border, gap: space(2) }}>
        <TextInput
          accessibilityLabel={t.messagePlaceholder}
          placeholder={t.messagePlaceholder}
          placeholderTextColor={colors.muted}
          value={text}
          onChangeText={setText}
          multiline
          style={[ui.input, { flex: 1, maxHeight: 140, paddingTop: 10 }]}
          onKeyPress={(e) => {
            // Desktop: Enter sends, Shift+Enter newline
            const ne = e.nativeEvent as { key?: string; shiftKey?: boolean };
            if (platform.kind === 'desktop' && ne.key === 'Enter' && !ne.shiftKey) {
              (e as unknown as { preventDefault?: () => void }).preventDefault?.();
              submit();
            }
          }}
        />
        <Pressable accessibilityRole="button" accessibilityLabel={t.send} onPress={submit} disabled={!text.trim()} style={[ui.button, ui.primary, { opacity: text.trim() ? 1 : 0.5 }]}>
          <Text style={ui.buttonText}>{t.send}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
