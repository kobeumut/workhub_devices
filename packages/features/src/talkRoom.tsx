import { useEffect, useState } from 'react';
import { FlatList, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import {
  isModeratorType, presenceLabel, roomActions, PARTICIPANT_TYPE, TALK_LIMITS,
  type AccountId, type InviteCandidate, type MessageSearchHit, type RoomKind, type TalkFeatures, type TalkParticipant, type TalkRoom,
} from '@workhub-devices/core';
import { useServices } from './services';
import { useActivity } from './talkState';
import { Button, Empty, ErrorBanner, Field, Header, Loading, card, styles as ui } from './ui';
import { colors, font, space } from './theme';
import { formatTime } from './i18n';

const ROLE_LABEL: Record<number, string> = {
  [PARTICIPANT_TYPE.owner]: 'Sahip',
  [PARTICIPANT_TYPE.moderator]: 'Moderatör',
  [PARTICIPANT_TYPE.guestModerator]: 'Misafir moderatör',
  [PARTICIPANT_TYPE.guest]: 'Misafir',
};

/** Two-step confirmation without a modal: first press arms, second press runs. */
function ConfirmButton({ title, confirmTitle, onConfirm, busy }: { title: string; confirmTitle: string; onConfirm: () => void; busy?: boolean }) {
  const [armed, setArmed] = useState(false);
  return armed ? (
    <View style={{ flexDirection: 'row', gap: space(2) }}>
      <Button kind="danger" title={confirmTitle} onPress={onConfirm} {...(busy ? { busy } : {})} />
      <Button kind="secondary" title="Vazgeç" onPress={() => setArmed(false)} />
    </View>
  ) : (
    <Button kind="danger" title={title} onPress={() => setArmed(true)} />
  );
}

/** New group / public conversation (shown only when `can-create`). */
export function NewRoomForm({ accountId, onCreated, onCancel }: { accountId: AccountId; onCreated: (r: TalkRoom) => void; onCancel: () => void }) {
  const { backend } = useServices();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<RoomKind>('group');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onCreated(await backend.createRoom(accountId, kind, name.trim()));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={[card, { margin: space(2) }]}>
      <Field label="Sohbet adı" value={name} onChangeText={setName} maxLength={TALK_LIMITS.roomName} />
      <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: space(2), marginBottom: space(2) }}>
        {([['group', 'Grup (davetle)'], ['public', 'Herkese açık (bağlantıyla)']] as const).map(([k, label]) => (
          <Pressable key={k} accessibilityRole="radio" accessibilityState={{ checked: kind === k }} onPress={() => setKind(k)}
            style={{ paddingHorizontal: space(3), paddingVertical: space(2), borderRadius: 16, borderWidth: 1, borderColor: kind === k ? colors.primary : colors.border, backgroundColor: kind === k ? colors.bubbleMine : colors.bg }}>
            <Text style={{ color: colors.text }}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <ErrorBanner error={error} />
      <View style={{ flexDirection: 'row', gap: space(2) }}>
        <Button title="Sohbeti oluştur" onPress={create} disabled={!name.trim()} busy={busy} />
        <Button kind="secondary" title="İptal" onPress={onCancel} />
      </View>
    </View>
  );
}

/** Search results list shared by the global (room list) and per-room search. */
export function SearchResults({ hits, onPick, roomName }: { hits: MessageSearchHit[]; onPick: (h: MessageSearchHit) => void; roomName?: (token: string) => string | undefined }) {
  return (
    <View>
      {hits.map((h) => (
        <Pressable key={`${h.token}-${h.messageId}`} accessibilityRole="button" onPress={() => onPick(h)}
          style={{ paddingHorizontal: space(4), paddingVertical: space(2), borderBottomWidth: 1, borderColor: colors.border }}>
          <Text numberOfLines={1} style={{ fontWeight: '600', color: colors.text }}>{h.title || roomName?.(h.token) || h.token}</Text>
          <Text numberOfLines={2} style={{ color: colors.muted, fontSize: font.small }}>{h.excerpt}</Text>
          {h.timestamp ? <Text style={{ color: colors.muted, fontSize: 11 }}>{formatTime(h.timestamp)}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}

/** Message search (unified search `talk-message`); `token` limits it to one conversation. */
export function MessageSearch({ accountId, token, onPick, onClose }: { accountId: AccountId; token: string | null; onPick: (h: MessageSearchHit) => void; onClose?: () => void }) {
  const { backend } = useServices();
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<MessageSearchHit[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const run = async (more: boolean) => {
    if (!term.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const page = await backend.searchMessages(accountId, term.trim().slice(0, TALK_LIMITS.searchTerm), token, more ? cursor : null);
      setHits((prev) => (more && prev ? [...prev, ...page.hits] : page.hits));
      setCursor(page.cursor);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', gap: space(2), padding: space(2), alignItems: 'center' }}>
        <TextInput accessibilityLabel={token ? 'Bu sohbette ara' : 'Mesajlarda ara'} placeholder={token ? 'Bu sohbette ara' : 'Mesajlarda ara'} placeholderTextColor={colors.muted}
          value={term} onChangeText={setTerm} onSubmitEditing={() => void run(false)} style={[ui.input, { flex: 1 }]} />
        <Button title="Ara" accessibilityLabel="Aramayı başlat" onPress={() => void run(false)} disabled={!term.trim()} busy={busy && !hits} />
        {onClose ? <Button kind="secondary" title="Kapat" onPress={onClose} /> : null}
      </View>
      <ErrorBanner error={error} />
      <ScrollView>
        {hits && hits.length === 0 ? <Empty text="Eşleşen mesaj yok." /> : null}
        {hits ? <SearchResults hits={hits} onPick={onPick} /> : null}
        {cursor ? <View style={{ padding: space(2) }}><Button kind="secondary" title="Daha fazla sonuç" onPress={() => void run(true)} busy={busy} /></View> : null}
      </ScrollView>
    </View>
  );
}

/**
 * Conversation details: name/description (moderator), participants with role actions, invite,
 * leave and delete. Every button is derived from the CURRENT room (`roomActions`); the Backend
 * re-checks on a fresh read and the server decides.
 */
export function RoomSettings({ accountId, room, features, selfId, onChanged, onGone, onClose }: {
  accountId: AccountId;
  room: TalkRoom;
  features: TalkFeatures;
  selfId: string;
  onChanged: (r: TalkRoom) => void;
  onGone: () => void;
  onClose: () => void;
}) {
  const { backend } = useServices();
  const acts = roomActions(room, features);
  const [name, setName] = useState(room.displayName);
  const [description, setDescription] = useState(room.description ?? '');
  const [people, setPeople] = useState<TalkParticipant[] | null>(null);
  const [search, setSearch] = useState('');
  const [cands, setCands] = useState<InviteCandidate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState('');

  const active = useActivity();
  useEffect(() => {
    if (!active) { setPeople((prev) => prev?.map(({ status: _status, ...p }) => p) ?? null); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const people = await backend.participants(accountId, room.token);
        if (alive) { setPeople(people); setError(undefined); }
      } catch (e) {
        if (alive) { setError(e); setPeople((prev) => prev?.map(({ status: _status, ...p }) => p) ?? null); }
      }
      if (alive) timer = setTimeout(() => void refresh(), 5000);
    };
    void refresh();
    return () => { alive = false; clearTimeout(timer); };
  }, [accountId, room.token, backend, active]);

  // Debounced invite autocomplete (moderators only).
  useEffect(() => {
    if (!acts.manageParticipants || search.trim().length < 1) {
      setCands([]);
      return;
    }
    let alive = true;
    const id = setTimeout(() => {
      backend.inviteCandidates(accountId, room.token, search.trim()).then((c) => alive && setCands(c), () => alive && setCands([]));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [search, acts.manageParticipants, accountId, room.token, backend]);

  const act = async (key: string, fn: () => Promise<void>, done?: string) => {
    setBusy(key);
    setError(undefined);
    setNotice('');
    try {
      await fn();
      if (done) setNotice(done);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const members = new Set((people ?? []).map((p) => `${p.actorType}:${p.actorId}`));
  const dirty = name.trim() !== room.displayName || description !== (room.description ?? '');

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title="Sohbet bilgileri" right={<Button kind="secondary" title="Kapat" onPress={onClose} />} />
      <ScrollView contentContainerStyle={{ padding: space(3) }}>
        <ErrorBanner error={error} />
        {notice ? <Text accessibilityRole="alert" style={{ color: colors.ok, marginBottom: space(2) }}>{notice}</Text> : null}
        {acts.rename ? (
          <View style={card}>
            <Field label="Sohbet adı" value={name} onChangeText={setName} maxLength={TALK_LIMITS.roomName} />
            {acts.describe ? (
              <Field label="Açıklama" value={description} onChangeText={setDescription} multiline maxLength={TALK_LIMITS.description} style={{ minHeight: 72, paddingTop: 10 }} />
            ) : null}
            <Button title="Bilgileri kaydet" disabled={!dirty || !name.trim()} busy={busy === 'save'}
              onPress={() => void act('save', async () => {
                const patch = { ...(name.trim() !== room.displayName ? { name: name.trim() } : {}), ...(acts.describe && description !== (room.description ?? '') ? { description } : {}) };
                onChanged(await backend.updateRoom(accountId, room.token, patch));
              }, 'Sohbet bilgileri kaydedildi.')} />
          </View>
        ) : (
          <View style={card}>
            <Text style={{ fontSize: font.title, fontWeight: '700', color: colors.text }}>{room.displayName}</Text>
            {room.description ? <Text style={{ color: colors.text, marginTop: space(1) }}>{room.description}</Text> : null}
          </View>
        )}

        <Text accessibilityRole="header" style={{ fontWeight: '700', color: colors.text, marginVertical: space(2) }}>
          Katılımcılar{people ? ` (${people.length})` : ''}
        </Text>
        {acts.manageParticipants ? (
          <View style={{ marginBottom: space(2) }}>
            <TextInput accessibilityLabel="Katılımcı ekle: kişi veya grup ara" placeholder="Katılımcı ekle: kişi veya grup ara" placeholderTextColor={colors.muted}
              value={search} onChangeText={setSearch} style={ui.input} />
            {cands.filter((c) => !members.has(`${c.source}:${c.id}`)).map((c) => (
              <Pressable key={`${c.source}:${c.id}`} accessibilityRole="button" accessibilityLabel={`${c.label} ekle`}
                onPress={() => void act(`add:${c.id}`, async () => {
                  setPeople(await backend.addParticipant(accountId, room.token, c.source, c.id));
                  setSearch('');
                }, `${c.label} eklendi.`)}
                style={{ padding: space(2), borderBottomWidth: 1, borderColor: colors.border }}>
                <Text style={{ color: colors.text }}>{c.source === 'groups' ? '👥 ' : ''}{c.label} <Text style={{ color: colors.primary }}>+ ekle</Text></Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {!people ? <Loading /> : (
          <FlatList
            scrollEnabled={false}
            data={people}
            keyExtractor={(p) => String(p.attendeeId)}
            renderItem={({ item: p }) => {
              const self = p.actorType === 'users' && p.actorId === selfId;
              const mod = isModeratorType(p.participantType);
              const canTouch = acts.manageParticipants && !self && p.participantType !== PARTICIPANT_TYPE.owner && p.actorType !== 'groups' && p.actorType !== 'circles';
              return (
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: space(2), borderBottomWidth: 1, borderColor: colors.border, gap: space(2), flexWrap: 'wrap' }}>
                  <Text style={{ flex: 1, color: colors.text }}>
                    {p.displayName || p.actorId}{self ? ' (siz)' : ''}
                    {p.actorType === 'users' ? ` · ${presenceLabel(p.status)}` : ''}
                    {ROLE_LABEL[p.participantType] ? <Text style={{ color: colors.muted }}> · {ROLE_LABEL[p.participantType]}</Text> : null}
                  </Text>
                  {canTouch && (p.actorType === 'users' || p.actorType === 'guests' || p.actorType === 'emails') ? (
                    <Button kind="secondary" title={mod ? 'Moderatörlüğü al' : 'Moderatör yap'} accessibilityLabel={`${p.displayName || p.actorId}: ${mod ? 'moderatörlüğü al' : 'moderatör yap'}`}
                      busy={busy === `mod:${p.attendeeId}`}
                      onPress={() => void act(`mod:${p.attendeeId}`, async () => setPeople(await backend.setModerator(accountId, room.token, p.attendeeId, !mod)))} />
                  ) : null}
                  {canTouch && !mod ? (
                    <Button kind="danger" title="Çıkar" accessibilityLabel={`${p.displayName || p.actorId}: sohbetten çıkar`} busy={busy === `rm:${p.attendeeId}`}
                      onPress={() => void act(`rm:${p.attendeeId}`, async () => setPeople(await backend.removeParticipant(accountId, room.token, p.attendeeId)), `${p.displayName || p.actorId} çıkarıldı.`)} />
                  ) : null}
                </View>
              );
            }}
          />
        )}

        <View style={{ marginTop: space(4), gap: space(2) }}>
          {acts.leave ? (
            <ConfirmButton title="Sohbetten ayrıl" confirmTitle="Evet, ayrıl" busy={busy === 'leave'}
              onConfirm={() => void act('leave', async () => {
                await backend.leaveRoom(accountId, room.token);
                onGone();
              })} />
          ) : (
            <Text style={{ color: colors.muted }}>Son moderatör olduğunuz için ayrılamazsınız; önce başka birini moderatör yapın.</Text>
          )}
          {acts.delete ? (
            <ConfirmButton title="Sohbeti herkes için sil" confirmTitle="Evet, kalıcı olarak sil" busy={busy === 'delete'}
              onConfirm={() => void act('delete', async () => {
                await backend.deleteRoom(accountId, room.token);
                onGone();
              })} />
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
