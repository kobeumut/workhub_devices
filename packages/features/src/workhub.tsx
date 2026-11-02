import { useState } from 'react';
import { FlatList, Pressable, ScrollView, SectionList, Text, TextInput, View } from 'react-native';
import type { AccountId, BoardPayload, ProjectSummary, Task, TaskDetail } from '@workhub-devices/core';
import { useAsync, useServices } from './services';
import { Button, Empty, ErrorBanner, Header, Loading, Row, card, styles as ui } from './ui';
import { colors, font, space } from './theme';
import { describeError, formatDate, t } from './i18n';

const PRIORITY: Record<string, string> = { urgent: 'Acil', high: 'Yüksek', normal: 'Normal', low: 'Düşük' };
const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function ProjectsScreen({ accountId, selected, onOpen }: { accountId: AccountId; selected?: number; onOpen: (p: ProjectSummary) => void }) {
  const { backend } = useServices();
  const s = useAsync(() => backend.projects(accountId), [accountId]);
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ErrorBanner error={s.error} onRetry={s.reload} />
      {s.loading && !s.data ? (
        <Loading />
      ) : (
        <FlatList
          data={s.data ?? []}
          keyExtractor={(p) => String(p.id)}
          refreshing={s.loading}
          onRefresh={s.reload}
          ListEmptyComponent={s.error ? undefined : <Empty text={t.noProjects} />}
          renderItem={({ item }) => (
            <Row
              title={item.title}
              subtitle={`${item.openCount} açık · ${item.doneCount} tamamlandı${item.overdueCount ? ` · ${item.overdueCount} gecikmiş` : ''}`}
              selected={item.id === selected}
              onPress={() => onOpen(item)}
            />
          )}
        />
      )}
    </View>
  );
}

function taskSubtitle(task: Task): string {
  const parts: string[] = [];
  if (task.priority) parts.push(PRIORITY[task.priority] ?? task.priority);
  if (task.dueDate) parts.push(`${t.due}: ${formatDate(task.dueDate)}`);
  if (task.assignees.length) parts.push(task.assignees.map((a) => a.displayName).join(', '));
  if (task.subtasks.total) parts.push(`☑ ${task.subtasks.done}/${task.subtasks.total}`);
  return parts.join(' · ');
}

/** Kanban as sections (accessible on phones; no drag required) + list view in the same component. */
export function BoardScreen({ accountId, project, onOpenTask, onBack }: { accountId: AccountId; project: { id: number; title: string }; onOpenTask: (cardId: number) => void; onBack?: () => void }) {
  const { backend } = useServices();
  const s = useAsync(() => backend.board(accountId, project.id), [accountId, project.id]);
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [moving, setMoving] = useState<Task | null>(null);
  const board = s.data as BoardPayload | undefined;
  const canEdit = board?.project.permissions.edit ?? false;
  const sections = (board?.project.stacks ?? [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((st) => ({ stack: st, title: st.title, data: board!.tasks.filter((x) => x.stackId === st.id && !x.archived).sort((a, b) => a.order - b.order) }));

  const create = async () => {
    const first = sections[0]?.stack;
    if (!first || !newTitle.trim()) return;
    setBusy(true);
    setErr(undefined);
    try {
      await backend.createTask(accountId, project.id, first.id, newTitle.trim(), uuid());
      setNewTitle('');
      s.reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const move = async (task: Task, stackId: number) => {
    setMoving(null);
    setErr(undefined);
    try {
      await backend.moveTask(accountId, task.id, stackId, 0);
      s.reload();
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <Header title={project.title} {...(onBack ? { onBack } : {})} />
      <ErrorBanner error={s.error ?? err} onRetry={s.reload} />
      {canEdit ? (
        <View style={{ flexDirection: 'row', gap: space(2), padding: space(2), backgroundColor: colors.bg }}>
          <TextInput accessibilityLabel={t.newTask} placeholder={`${t.newTask} (${sections[0]?.title ?? ''})`} placeholderTextColor={colors.muted} value={newTitle} onChangeText={setNewTitle} onSubmitEditing={() => void create()} style={[ui.input, { flex: 1 }]} />
          <Button title="+" onPress={() => void create()} busy={busy} disabled={!newTitle.trim()} />
        </View>
      ) : null}
      {moving ? (
        <View style={[card, { margin: space(2) }]}>
          <Text style={{ fontWeight: '700', marginBottom: space(2) }}>“{moving.title}” → hangi listeye?</Text>
          {sections.map((sec) => (
            <Button key={sec.stack.id} kind="secondary" title={sec.title} disabled={sec.stack.id === moving.stackId} onPress={() => void move(moving, sec.stack.id)} />
          ))}
          <Button kind="secondary" title={t.cancel} onPress={() => setMoving(null)} />
        </View>
      ) : null}
      {s.loading && !board ? (
        <Loading />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(x) => String(x.id)}
          refreshing={s.loading}
          onRefresh={s.reload}
          stickySectionHeadersEnabled
          renderSectionHeader={({ section }) => (
            <Text accessibilityRole="header" style={{ backgroundColor: colors.surface, paddingHorizontal: space(4), paddingVertical: space(2), fontWeight: '700', color: colors.muted }}>
              {section.title} ({section.data.length}){section.stack.isDone ? ' ✓' : ''}
            </Text>
          )}
          renderSectionFooter={({ section }) => (section.data.length === 0 ? <Text style={{ paddingHorizontal: space(4), paddingBottom: space(2), color: colors.muted }}>{t.noTasks}</Text> : null)}
          renderItem={({ item }) => (
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.bg }}>
              <View style={{ flex: 1 }}>
                <Row title={`${item.done ? '✓ ' : ''}${item.title}`} subtitle={taskSubtitle(item)} onPress={() => onOpenTask(item.id)} />
              </View>
              {canEdit ? (
                <Pressable accessibilityRole="button" accessibilityLabel={`${t.move}: ${item.title}`} onPress={() => setMoving(item)} style={{ padding: space(3) }}>
                  <Text style={{ color: colors.primary }}>{t.move}</Text>
                </Pressable>
              ) : null}
            </View>
          )}
        />
      )}
    </View>
  );
}

/** Task detail always comes from a fresh, ACL-checked fetch (never from notification payload). */
export function TaskScreen({ accountId, cardId, onBack }: { accountId: AccountId; cardId: number; onBack?: () => void }) {
  const { backend } = useServices();
  const s = useAsync(() => backend.openTask(accountId, cardId), [accountId, cardId]);
  const comments = useAsync(() => (s.data?.state === 'ok' ? backend.comments(accountId, cardId) : Promise.resolve([])), [accountId, cardId, s.data?.state]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();

  if (s.loading && !s.data) return <Loading />;
  if (s.error) {
    return (
      <View style={{ flex: 1 }}>
        <Header title={`#${cardId}`} {...(onBack ? { onBack } : {})} />
        <ErrorBanner error={s.error} onRetry={s.reload} />
      </View>
    );
  }
  const r = s.data!;
  if (r.state !== 'ok') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <Header title={`#${cardId}`} {...(onBack ? { onBack } : {})} />
        <Empty text={r.state === 'gone' ? t.taskGone : r.state === 'forbidden' ? t.taskForbidden : t.featureOff} />
      </View>
    );
  }
  const task: TaskDetail = r.task;

  const toggleDone = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await backend.updateTask(accountId, cardId, { done: !task.done });
      s.reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const addComment = async () => {
    const msg = comment.trim();
    if (!msg) return;
    setBusy(true);
    setErr(undefined);
    try {
      await backend.addComment(accountId, cardId, msg, uuid());
      setComment('');
      comments.reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <Header title={task.title} {...(onBack ? { onBack } : {})} />
      <ScrollView contentContainerStyle={{ padding: space(3) }}>
        <ErrorBanner error={err} />
        <View style={card}>
          <Text style={{ fontSize: font.title, fontWeight: '700', color: colors.text }}>{task.title}</Text>
          <Text style={{ color: colors.muted, marginTop: space(1) }}>{taskSubtitle(task) || ' '}</Text>
          {task.done ? <Text style={{ color: colors.ok, marginTop: space(1) }}>✓ {formatDate(task.done)}</Text> : null}
          {task.description ? <Text style={{ marginTop: space(3), color: colors.text }} selectable>{task.description}</Text> : null}
          <Button title={task.done ? t.markUndone : t.markDone} kind="secondary" onPress={() => void toggleDone()} busy={busy} />
        </View>
        <View style={card}>
          <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(2) }}>
            {t.assignees}
          </Text>
          <Text style={{ color: colors.text }}>{task.assignees.length ? task.assignees.map((a) => a.displayName).join(', ') : '—'}</Text>
        </View>
        <View style={card}>
          <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(2) }}>
            {t.comments}
          </Text>
          {comments.error ? <Text style={{ color: colors.danger }}>{describeError(comments.error)}</Text> : null}
          {(comments.data ?? []).map((c) => (
            <View key={c.id} style={{ marginBottom: space(2) }}>
              <Text style={{ fontWeight: '600', color: colors.text }}>
                {c.actorDisplayName} <Text style={{ color: colors.muted, fontWeight: '400' }}>{formatDate(c.createdAt)}</Text>
              </Text>
              <Text style={{ color: colors.text }} selectable>
                {c.message}
              </Text>
            </View>
          ))}
          <TextInput accessibilityLabel={t.addComment} placeholder={t.addComment} placeholderTextColor={colors.muted} value={comment} onChangeText={setComment} multiline style={[ui.input, { minHeight: 64, paddingTop: 10 }]} />
          <Button title={t.addComment} onPress={() => void addComment()} busy={busy} disabled={!comment.trim()} />
        </View>
      </ScrollView>
    </View>
  );
}
