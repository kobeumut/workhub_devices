import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { nextStackOrder, upsertShare, PROJECT_TITLE_MAX, RENAME_MAX, type AccountId, type BoardPayload, type ObjectShare, type Principal, type ShareObjectType, type ShareRole } from '@workhub-devices/core';
import { useAsync, useServices } from './services';
import { Button, ErrorBanner, Field, Loading, card, styles as ui } from './ui';
import { Chip } from './taskEdit';
import { colors, font, space } from './theme';
import { describeError, t } from './i18n';

type Board = BoardPayload['project'];
const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Runs one write at a time and keeps its error visible (403 → "yetkiniz yok", 409 → "değişti"). */
function useWrite() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setErr(undefined);
    try {
      await fn();
      after?.();
      return true;
    } catch (e) {
      setErr(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, run };
}

/** "New project" row on the project list. Every Projects-module user may create; the creator gets manage. */
export function CreateProjectForm({ accountId, onCreated }: { accountId: AccountId; onCreated: (p: { id: number; title: string }) => void }) {
  const { backend } = useServices();
  const [title, setTitle] = useState('');
  // One key per attempt: a retried lost response does not create a second project.
  const [key, setKey] = useState(uuid);
  const w = useWrite();
  const create = () => {
    const v = title.trim();
    if (!v) return;
    void w.run(async () => {
      const p = await backend.createProject(accountId, v, null, key);
      setTitle('');
      setKey(uuid());
      if (p) onCreated({ id: p.id, title: p.title });
    });
  };
  return (
    <View style={{ padding: space(2), borderBottomWidth: 1, borderColor: colors.border }}>
      <ErrorBanner error={w.err} />
      <View style={{ flexDirection: 'row', gap: space(2) }}>
        <TextInput
          accessibilityLabel={t.newProject}
          placeholder={t.newProject}
          placeholderTextColor={colors.muted}
          value={title}
          maxLength={PROJECT_TITLE_MAX}
          onChangeText={(v) => {
            setTitle(v);
            setKey(uuid());
          }}
          onSubmitEditing={create}
          style={[ui.input, { flex: 1 }]}
        />
        <Button title={t.create} onPress={create} busy={w.busy} disabled={!title.trim()} />
      </View>
    </View>
  );
}

/** Debounced user/group search (`GET /principals`). `exclude` hides people who already have access. */
export function PrincipalPicker({ accountId, onPick, exclude = [], label = t.searchPeople, usersOnly = false }: { accountId: AccountId; onPick: (p: Principal) => void; exclude?: string[]; label?: string; usersOnly?: boolean }) {
  const { backend } = useServices();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const h = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(h);
  }, [q]);
  const s = useAsync(() => backend.principals(accountId, debounced), [accountId, debounced]);
  const results = (s.data ?? []).filter((p) => !exclude.includes(`${p.principalType}:${p.principalId}`) && (!usersOnly || p.principalType === 'user'));
  return (
    <View style={{ marginTop: space(2) }}>
      <TextInput accessibilityLabel={label} placeholder={label} placeholderTextColor={colors.muted} value={q} onChangeText={setQ} autoCapitalize="none" maxLength={64} style={ui.input} />
      {s.error ? <Text style={{ color: colors.danger, marginTop: space(1) }}>{describeError(s.error)}</Text> : null}
      {debounced && !s.loading && results.length === 0 && !s.error ? <Text style={{ color: colors.muted, marginTop: space(1) }}>{t.noMatches}</Text> : null}
      {results.map((p) => (
        <Pressable key={`${p.principalType}:${p.principalId}`} accessibilityRole="button" accessibilityLabel={`${t.pick}: ${p.displayName}`} onPress={() => { onPick(p); setQ(''); }} style={{ paddingVertical: space(2) }}>
          <Text style={{ color: colors.primary }}>
            {p.principalType === 'group' ? '👥 ' : ''}
            {p.displayName} <Text style={{ color: colors.muted }}>({p.principalId})</Text>
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * Project settings: rename and columns need `manage`; adding members needs `share`. Buttons are only
 * rendered for the permissions the server reported, and every write still handles 403 visibly.
 * There is no member-removal API in Workhub (recorded Gap).
 */
export function ProjectAdminPanel({ accountId, board, onChanged }: { accountId: AccountId; board: Board; onChanged: () => void }) {
  const { backend } = useServices();
  const perms = board.permissions;
  const w = useWrite();
  const [title, setTitle] = useState(board.board.title);
  const [stackTitles, setStackTitles] = useState<Record<number, string>>({});
  const [newStack, setNewStack] = useState('');
  const [grant, setGrant] = useState({ edit: true, share: false, manage: false });
  const [added, setAdded] = useState<string>();
  const stacks = board.stacks.slice().sort((a, b) => a.order - b.order);

  const addMember = (p: Principal) =>
    void w.run(
      () => backend.addProjectMember(accountId, board.board.id, { type: p.principalType, participant: p.principalId, ...grant }, uuid()),
      () => {
        setAdded(p.displayName);
        onChanged();
      },
    );

  return (
    <View style={[card, { margin: space(2) }]}>
      <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(2) }}>
        {t.projectSettings}
      </Text>
      <ErrorBanner error={w.err} />
      {perms.manage ? (
        <>
          <View style={{ flexDirection: 'row', gap: space(2), alignItems: 'flex-end' }}>
            <View style={{ flex: 1 }}>
              <Field label={t.projectName} value={title} onChangeText={setTitle} maxLength={RENAME_MAX} />
            </View>
            <View style={{ marginBottom: space(3) }}>
              <Button title={t.rename} accessibilityLabel={t.renameProject} kind="secondary" busy={w.busy} disabled={!title.trim() || title.trim() === board.board.title} onPress={() => void w.run(() => backend.renameProject(accountId, board.board.id, title.trim()), onChanged)} />
            </View>
          </View>
          <Text style={ui.label}>{t.columns}</Text>
          {stacks.map((st) => {
            const v = stackTitles[st.id] ?? st.title;
            return (
              <View key={st.id} style={{ flexDirection: 'row', gap: space(2), alignItems: 'center', marginBottom: space(1) }}>
                <TextInput accessibilityLabel={`${t.columnName}: ${st.title}`} value={v} maxLength={RENAME_MAX} onChangeText={(x) => setStackTitles((m) => ({ ...m, [st.id]: x }))} style={[ui.input, { flex: 1 }]} />
                <Button title={t.rename} accessibilityLabel={`${t.rename}: ${st.title}`} kind="secondary" busy={w.busy} disabled={!v.trim() || v.trim() === st.title} onPress={() => void w.run(() => backend.renameStack(accountId, st.id, v.trim()), onChanged)} />
              </View>
            );
          })}
          <View style={{ flexDirection: 'row', gap: space(2), marginTop: space(1) }}>
            <TextInput accessibilityLabel={t.newColumn} placeholder={t.newColumn} placeholderTextColor={colors.muted} value={newStack} maxLength={RENAME_MAX} onChangeText={setNewStack} style={[ui.input, { flex: 1 }]} />
            <Button
              title={t.addColumn}
              busy={w.busy}
              disabled={!newStack.trim()}
              onPress={() => void w.run(() => backend.createStack(accountId, board.board.id, newStack.trim(), nextStackOrder(board.stacks)), () => { setNewStack(''); onChanged(); })}
            />
          </View>
        </>
      ) : null}
      <Text style={[ui.label, { marginTop: space(3) }]}>{t.members}</Text>
      <Text style={{ color: colors.text }}>{board.members.map((m) => m.displayName).join(', ') || '—'}</Text>
      {perms.share ? (
        <>
          <Text style={[ui.label, { marginTop: space(2) }]}>{t.newMemberRights}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
            <Chip label={t.permEdit} selected={grant.edit} disabled={!perms.edit && !perms.manage} onPress={() => setGrant((g) => ({ ...g, edit: !g.edit }))} />
            <Chip label={t.permShare} selected={grant.share} onPress={() => setGrant((g) => ({ ...g, share: !g.share }))} />
            <Chip label={t.permManage} selected={grant.manage} disabled={!perms.manage} onPress={() => setGrant((g) => ({ ...g, manage: !g.manage }))} />
          </View>
          <PrincipalPicker accountId={accountId} onPick={addMember} exclude={board.members.map((m) => `user:${m.uid}`)} label={t.addMember} />
          {added ? <Text style={{ color: colors.ok, marginTop: space(1) }}>{added}: {t.memberAdded}</Text> : null}
        </>
      ) : null}
      <Text style={{ color: colors.muted, fontSize: font.small, marginTop: space(2) }}>{t.memberRemoveGap}</Text>
    </View>
  );
}

const ROLE_LABEL: Record<ShareRole, string> = { view: 'Görüntüle', edit: 'Düzenle', manage: 'Yönet' };

/**
 * Workhub object shares (dashboard / goal / workflow). The list is edited locally and saved as a
 * complete replacement, which is what the server's PUT does. Needs the `manage` role; a 403 is shown.
 */
export function SharesEditor({ accountId, type, objectId, onClose }: { accountId: AccountId; type: ShareObjectType; objectId: number; onClose: () => void }) {
  const { backend } = useServices();
  const s = useAsync(() => backend.objectShares(accountId, type, objectId), [accountId, type, objectId]);
  const [draft, setDraft] = useState<ObjectShare[] | null>(null);
  const [saved, setSaved] = useState(false);
  const w = useWrite();
  if (s.loading && !s.data) return <Loading />;
  if (s.error) {
    return (
      <View style={card}>
        <ErrorBanner error={s.error} onRetry={s.reload} />
        <Button title={t.close} kind="secondary" onPress={onClose} />
      </View>
    );
  }
  const list = draft ?? s.data!.shares;
  const set = (next: ObjectShare[]) => {
    setSaved(false);
    setDraft(next);
  };
  const save = () =>
    void w.run(
      () => backend.setObjectShares(accountId, type, objectId, list.map(({ principalType, principalId, role }) => ({ principalType, principalId, role }))),
      () => {
        setDraft(null);
        setSaved(true);
        s.reload();
      },
    );
  return (
    <View style={card}>
      <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(1) }}>
        {t.shares}
      </Text>
      <Text style={{ color: colors.muted, marginBottom: space(2) }}>
        {t.owner}: {s.data!.owner.displayName}
      </Text>
      <ErrorBanner error={w.err} />
      {list.length === 0 ? <Text style={{ color: colors.muted }}>{t.noShares}</Text> : null}
      {list.map((sh) => (
        <View key={`${sh.principalType}:${sh.principalId}`} style={{ marginBottom: space(2) }}>
          <Text style={{ color: colors.text, fontWeight: '600' }}>
            {sh.principalType === 'group' ? '👥 ' : ''}
            {sh.displayName}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginTop: space(1) }}>
            {(Object.keys(ROLE_LABEL) as ShareRole[]).map((r) => (
              <Chip key={r} label={ROLE_LABEL[r]} selected={sh.role === r} onPress={() => set(list.map((x) => (x === sh ? { ...x, role: r } : x)))} />
            ))}
            <Pressable accessibilityRole="button" accessibilityLabel={`${t.removeShare}: ${sh.displayName}`} onPress={() => set(list.filter((x) => x !== sh))} style={{ padding: space(1) }}>
              <Text style={{ color: colors.danger }}>{t.removeShare}</Text>
            </Pressable>
          </View>
        </View>
      ))}
      <PrincipalPicker accountId={accountId} onPick={(p) => set(upsertShare(list, p, 'view'))} exclude={[`user:${s.data!.owner.uid}`, ...list.map((x) => `${x.principalType}:${x.principalId}`)]} label={t.addShare} />
      {saved ? <Text style={{ color: colors.ok, marginTop: space(1) }}>{t.sharesSaved}</Text> : null}
      <View style={{ flexDirection: 'row', gap: space(2), marginTop: space(2) }}>
        <View style={{ flex: 1 }}>
          <Button title={t.save} onPress={save} busy={w.busy} disabled={draft === null} />
        </View>
        <View style={{ flex: 1 }}>
          <Button title={t.close} kind="secondary" onPress={onClose} disabled={w.busy} />
        </View>
      </View>
    </View>
  );
}
