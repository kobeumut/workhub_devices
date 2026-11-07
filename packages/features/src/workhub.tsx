import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, SectionList, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { emptyFilters, kanbanColumns, moveToColumn, type AccountId, type BoardPayload, type ProjectSummary, type Task, type TaskDetail, type TaskFilters } from '@workhub-devices/core';
import { useAsync, useServices } from './services';
import { Button, Empty, ErrorBanner, Header, Loading, Row, card, styles as ui } from './ui';
import { colors, font, hexColor, radius, space } from './theme';
import { Icon, type IconName } from './icons';
import { AvatarStack, BoardToolbar, Chip, DueBadge, IconButton, KanbanBoard, LabelChips, PriorityBadge, stackColor } from './kanban';
import { describeError, formatDate, t } from './i18n';
import { DependencySection, SubtaskSection, TaskEditor } from './taskEdit';
import { TaskGoalsSection } from './goals';
import { TaskWorkflowSection } from './workflows';
import { CreateProjectForm, ProjectAdminPanel } from './projectAdmin';
import { ActivityView, GanttView, WorkloadScreen } from './views';

const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** `version` changes whenever a task changes elsewhere, so open/done counters never stay stale. */
export function ProjectsScreen({ accountId, selected, onOpen, version = 0 }: { accountId: AccountId; selected?: number; onOpen: (p: Pick<ProjectSummary, 'id' | 'title'>) => void; version?: number }) {
  const { backend } = useServices();
  const s = useAsync(() => backend.projects(accountId), [accountId, version]);
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <CreateProjectForm
        accountId={accountId}
        onCreated={(p) => {
          s.reload();
          onOpen(p);
        }}
      />
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
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: item.id === selected }}
              accessibilityLabel={`${item.title}: ${item.openCount} açık, ${item.doneCount} tamamlandı${item.overdueCount ? `, ${item.overdueCount} gecikmiş` : ''}`}
              onPress={() => onOpen(item)}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space(3), paddingHorizontal: space(4), paddingVertical: space(3), minHeight: 64, borderBottomWidth: 1, borderColor: colors.border, backgroundColor: item.id === selected ? colors.primarySoft : pressed ? colors.hover : colors.bg })}
            >
              <View style={{ width: 36, height: 36, borderRadius: radius.md, backgroundColor: hexColor(item.color), alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="kanban" size={18} color="#fff" />
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <Text numberOfLines={1} style={{ fontSize: font.body, fontWeight: '600', color: colors.textStrong }}>{item.title}</Text>
                <View style={{ flexDirection: 'row', gap: space(3) }}>
                  <Text style={{ fontSize: 12.5, color: colors.muted }}>{item.openCount} açık</Text>
                  <Text style={{ fontSize: 12.5, color: colors.ok }}>{item.doneCount} tamamlandı</Text>
                  {item.overdueCount ? <Text style={{ fontSize: 12.5, color: colors.danger, fontWeight: '600' }}>{item.overdueCount} gecikmiş</Text> : null}
                </View>
              </View>
              <Icon name="chevronRight" size={18} color={colors.faint} />
            </Pressable>
          )}
        />
      )}
    </View>
  );
}


type BoardView = 'kanban' | 'board' | 'gantt' | 'activity' | 'workload';

/** View tabs of the project workspace (web `ProjectWorkspace.vue`: Board, List, Gantt, Activity, Workload). */
const VIEWS: readonly (readonly [BoardView, string, IconName])[] = [
  ['kanban', 'Kanban', 'kanban'],
  ['board', 'Pano', 'list'],
  ['gantt', 'Gantt', 'gantt'],
  ['activity', 'Etkinlik', 'activity'],
  ['workload', 'İş yükü', 'users'],
];

/**
 * Project workspace with the web app's layout: colour-dot title bar with "Proje ayarları" and
 * "+ Görev ekle", view tabs, and the search/filter toolbar shared by Kanban and Pano.
 * Kanban = horizontal columns with cards; Pano = the same tasks as an accessible sectioned list.
 */
export function BoardScreen({ accountId, project, onOpenTask, onBack, onChanged, me = '', version = 0 }: { accountId: AccountId; project: { id: number; title: string }; onOpenTask: (cardId: number) => void; onBack?: () => void; onChanged?: () => void; me?: string; version?: number }) {
  const { backend } = useServices();
  // `version` bumps when a task changes elsewhere (e.g. the task drawer), so cards never go stale.
  const s = useAsync(() => backend.board(accountId, project.id), [accountId, project.id, version]);
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [moving, setMoving] = useState<Task | null>(null);
  const [managing, setManaging] = useState(false);
  const [view, setView] = useState<BoardView>('kanban');
  const [filters, setFilters] = useState<TaskFilters>(emptyFilters);
  const [addIn, setAddIn] = useState<number | null>(null);
  // Optimistic board while a move/toggle is in flight (the server answer replaces it).
  const [optimistic, setOptimistic] = useState<BoardPayload | null>(null);
  const board = optimistic ?? (s.data as BoardPayload | undefined);
  const canEdit = board?.project.permissions.edit ?? false;
  // Settings are offered only for permissions the server granted (fail closed until the board loads).
  const canAdmin = !!board && (board.project.permissions.manage || board.project.permissions.share);
  const columns = useMemo(() => (board ? kanbanColumns(board, filters, me) : []), [board, filters, me]);
  const sections = columns.map((c) => ({ stack: c.stack, title: c.stack.title, data: c.tasks, total: c.totalCount }));
  const { width } = useWindowDimensions();
  const narrow = width < 600;

  const refresh = () => {
    s.reload();
    onChanged?.();
  };
  useEffect(() => setOptimistic(null), [s.data]);

  const createIn = async (stackId: number, title: string) => {
    setErr(undefined);
    try {
      await backend.createTask(accountId, project.id, stackId, title, uuid());
      refresh();
    } catch (e) {
      setErr(e);
      throw e;
    }
  };

  const create = async () => {
    const first = sections[0]?.stack;
    if (!first || !newTitle.trim()) return;
    setBusy(true);
    try {
      await createIn(first.id, newTitle.trim());
      setNewTitle('');
    } catch {
      // shown in the banner
    } finally {
      setBusy(false);
    }
  };

  const moveTo = async (task: Task, target: { stackId: number; order: number }) => {
    setMoving(null);
    setErr(undefined);
    if (board) {
      // Place the card at its new slot right away; ordering is rebuilt from the full stack order.
      const rest = board.tasks.filter((x) => x.id !== task.id);
      const ids = rest.filter((x) => x.stackId === target.stackId && !x.archived).sort((a, b) => a.order - b.order || a.id - b.id).map((x) => x.id);
      ids.splice(target.order, 0, task.id);
      const pos = new Map(ids.map((id, i) => [id, i]));
      setOptimistic({ ...board, tasks: board.tasks.map((x) => (x.id === task.id ? { ...x, stackId: target.stackId, order: target.order } : pos.has(x.id) ? { ...x, order: pos.get(x.id)! } : x)) });
    }
    try {
      await backend.moveTask(accountId, task.id, target.stackId, target.order);
    } catch (e) {
      setErr(e);
    }
    refresh();
  };

  const toggleDone = async (task: Task) => {
    setErr(undefined);
    if (board) setOptimistic({ ...board, tasks: board.tasks.map((x) => (x.id === task.id ? { ...x, done: x.done ? null : new Date().toISOString() } : x)) });
    try {
      await backend.updateTask(accountId, task.id, { done: !task.done });
    } catch (e) {
      setErr(e);
    }
    refresh();
  };

  const color = hexColor(board?.project.board.color);
  const showToolbar = view === 'kanban' || view === 'board';

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), paddingHorizontal: space(3), minHeight: 56, backgroundColor: colors.bg, borderBottomWidth: 1, borderColor: colors.border }}>
        {onBack ? <IconButton icon="back" label={t.back} onPress={onBack} color={colors.primary} size={22} /> : null}
        <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: color }} />
        <Text accessibilityRole="header" numberOfLines={1} style={{ flex: 1, fontSize: font.title, fontWeight: '700', color: colors.textStrong }}>
          {board?.project.board.title ?? project.title}
        </Text>
        {canAdmin ? (
          narrow ? (
            <IconButton icon="settings" label={t.projectSettings} onPress={() => setManaging((m) => !m)} expanded={managing} />
          ) : (
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: managing }} onPress={() => setManaging((m) => !m)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: space(3), borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: pressed || managing ? colors.hover : colors.bg })}>
              <Icon name="settings" size={16} color={colors.muted} />
              <Text style={{ color: colors.text, fontWeight: '500' }}>{t.projectSettings}</Text>
            </Pressable>
          )
        ) : null}
        {canEdit && view !== 'activity' && view !== 'workload' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Görev ekle"
            onPress={() => {
              setView((v) => (v === 'gantt' ? 'kanban' : v));
              setAddIn(sections[0]?.stack.id ?? null);
            }}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: space(3), borderRadius: radius.sm, backgroundColor: pressed ? colors.primaryStrong : colors.primary })}
          >
            <Icon name="plus" size={16} color={colors.primaryText} />
            {narrow ? null : <Text style={{ color: colors.primaryText, fontWeight: '600' }}>Görev ekle</Text>}
          </Pressable>
        ) : null}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="tablist" style={{ flexGrow: 0, backgroundColor: colors.bg, borderBottomWidth: 1, borderColor: colors.border }} contentContainerStyle={{ paddingHorizontal: space(2) }}>
        {VIEWS.map(([key, label, icon]) => (
          <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected: view === key }} onPress={() => setView(key)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space(3), paddingVertical: space(3), borderBottomWidth: 2, borderColor: view === key ? colors.primary : 'transparent' }}>
            <Icon name={icon} size={16} color={view === key ? colors.primary : colors.muted} />
            <Text style={{ color: view === key ? colors.primary : colors.muted, fontWeight: view === key ? '700' : '500' }}>{label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <ErrorBanner error={s.error ?? err} onRetry={s.reload} />
      {managing && board && canAdmin ? (
        <ScrollView style={{ flexGrow: 0, maxHeight: '60%' }}>
          <ProjectAdminPanel
            key={`${board.project.board.title}|${board.project.stacks.map((x) => `${x.id}:${x.title}`).join(',')}`}
            accountId={accountId}
            board={board.project}
            onChanged={refresh}
          />
        </ScrollView>
      ) : null}
      {showToolbar && board ? <BoardToolbar filters={filters} onChange={setFilters} /> : null}
      {view === 'gantt' ? <GanttView accountId={accountId} boardId={project.id} onOpenTask={onOpenTask} /> : null}
      {view === 'activity' ? <ActivityView accountId={accountId} boardId={project.id} onOpenTask={onOpenTask} /> : null}
      {view === 'workload' ? <WorkloadScreen accountId={accountId} boardIds={[project.id]} onOpenTask={onOpenTask} /> : null}
      {view === 'kanban' ? (
        s.loading && !board ? (
          <Loading />
        ) : board ? (
          <KanbanBoard
            board={board}
            columns={columns}
            canEdit={canEdit}
            addInStack={addIn}
            onAddHandled={() => setAddIn(null)}
            actions={{ open: (task) => onOpenTask(task.id), toggleDone: (task) => void toggleDone(task), move: (task, target) => void moveTo(task, target), create: createIn }}
          />
        ) : null
      ) : null}
      {view === 'board' ? (
      <>
      {canEdit ? (
        <View style={{ flexDirection: 'row', gap: space(2), padding: space(2), backgroundColor: colors.bg }}>
          <TextInput accessibilityLabel={t.newTask} placeholder={`${t.newTask} (${sections[0]?.title ?? ''})`} placeholderTextColor={colors.muted} value={newTitle} onChangeText={setNewTitle} onSubmitEditing={() => void create()} style={[ui.input, { flex: 1 }]} />
          <Button title="+" accessibilityLabel={t.newTask} onPress={() => void create()} busy={busy} disabled={!newTitle.trim()} />
        </View>
      ) : null}
      {moving ? (
        <View style={[card, { margin: space(2) }]}>
          <Text style={{ fontWeight: '700', marginBottom: space(2) }}>“{moving.title}” → hangi listeye?</Text>
          {sections.map((sec) => {
            const target = moveToColumn(columns, moving.id, sec.stack.id);
            return <Button key={sec.stack.id} kind="secondary" title={sec.title} disabled={!target || sec.stack.id === moving.stackId} onPress={() => target && void moveTo(moving, target)} />;
          })}
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
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), backgroundColor: colors.surface, paddingHorizontal: space(4), paddingVertical: space(2) }}>
              <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: stackColor(sections.indexOf(section), section.stack.isDone) }} />
              <Text accessibilityRole="header" style={{ fontWeight: '700', color: colors.text }}>
                {section.title} <Text style={{ color: colors.muted, fontWeight: '500' }}>({section.data.length === section.total ? section.total : `${section.data.length}/${section.total}`})</Text>
              </Text>
              {section.stack.isDone ? <Icon name="checkCircle" size={15} color={colors.ok} /> : null}
            </View>
          )}
          renderSectionFooter={({ section }) => (section.data.length === 0 ? <Text style={{ paddingHorizontal: space(4), paddingBottom: space(2), color: colors.muted }}>{section.total ? 'Eşleşen görev yok' : t.noTasks}</Text> : null)}
          renderItem={({ item }) => (
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.bg, borderBottomWidth: 1, borderColor: colors.border }}>
              <Pressable accessibilityRole="button" onPress={() => onOpenTask(item.id)} style={({ pressed }) => ({ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space(3), paddingHorizontal: space(4), paddingVertical: space(3), backgroundColor: pressed ? colors.hover : colors.bg })}>
                <Icon name={item.done ? 'checkCircle' : 'circle'} size={18} color={item.done ? colors.ok : colors.faint} />
                <View style={{ flex: 1, gap: 4 }}>
                  <Text numberOfLines={1} style={{ fontSize: font.body, fontWeight: '600', color: item.done ? colors.muted : colors.text, textDecorationLine: item.done ? 'line-through' : 'none' }}>
                    {item.title}
                  </Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), flexWrap: 'wrap' }}>
                    <Text style={{ fontSize: 12, color: colors.muted }}>#{item.id}</Text>
                    <PriorityBadge priority={item.priority} />
                    <DueBadge due={item.dueDate} done={item.done} />
                    {item.subtasks.total ? <Text style={{ fontSize: 12, color: colors.muted }}>☑ {item.subtasks.done}/{item.subtasks.total}</Text> : null}
                  </View>
                </View>
                <AvatarStack people={item.assignees} size={22} />
              </Pressable>
              {canEdit ? (
                <Pressable accessibilityRole="button" accessibilityLabel={`${t.move}: ${item.title}`} onPress={() => setMoving(item)} style={{ padding: space(3) }}>
                  <Text style={{ color: colors.primary }}>{t.move}</Text>
                </Pressable>
              ) : null}
            </View>
          )}
        />
      )}
      </>
      ) : null}
    </View>
  );
}

/** Task detail always comes from a fresh, ACL-checked fetch (never from notification payload). */
export function TaskScreen({ accountId, cardId, onBack, onClose, timeEnabled, goalsEnabled, onChanged }: { accountId: AccountId; cardId: number; onBack?: () => void; onClose?: () => void; timeEnabled?: boolean; goalsEnabled?: boolean; onChanged?: () => void }) {
  const closeBtn = onClose ? <IconButton icon="close" label={t.close} onPress={onClose} size={20} /> : undefined;
  const { backend } = useServices();
  const s = useAsync(() => backend.openTask(accountId, cardId), [accountId, cardId]);
  const boardId = s.data?.state === 'ok' ? s.data.task.boardId : 0;
  // Board metadata (members, labels, sibling tasks, permissions) for the editor and dependency picker.
  const board = useAsync(() => (boardId ? backend.board(accountId, boardId) : Promise.resolve(undefined)), [accountId, boardId]);
  const [editing, setEditing] = useState(false);
  const changed = () => {
    s.reload();
    board.reload();
    onChanged?.();
  };
  const comments = useAsync(() => (s.data?.state === 'ok' ? backend.comments(accountId, cardId) : Promise.resolve([])), [accountId, cardId, s.data?.state]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [timerNote, setTimerNote] = useState<string>();

  if (s.loading && !s.data) return <Loading />;
  if (s.error) {
    return (
      <View style={{ flex: 1 }}>
        <Header title={`#${cardId}`} {...(onBack ? { onBack } : {})} right={closeBtn} />
        <ErrorBanner error={s.error} onRetry={s.reload} />
      </View>
    );
  }
  const r = s.data!;
  if (r.state !== 'ok') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <Header title={`#${cardId}`} {...(onBack ? { onBack } : {})} right={closeBtn} />
        <Empty text={r.state === 'gone' ? t.taskGone : r.state === 'forbidden' ? t.taskForbidden : t.featureOff} />
      </View>
    );
  }
  const task: TaskDetail = r.task;
  const project = board.data?.project;
  const canEdit = project?.permissions.edit ?? false;
  const labelNames = (project?.labels ?? []).filter((l) => !l.priority && task.labels.includes(l.id)).map((l) => l.title).join(', ');

  const toggleDone = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await backend.updateTask(accountId, cardId, { done: !task.done });
      changed();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const startTimer = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await backend.timerStart(accountId, cardId, '', uuid());
      setTimerNote('Zamanlayıcı bu görev için başladı (İşler → Zaman).');
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
      <Header title={task.title} {...(onBack ? { onBack } : {})} right={closeBtn} />
      <ScrollView contentContainerStyle={{ padding: space(3) }}>
        <ErrorBanner error={err} />
        <View style={card}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), flexWrap: 'wrap', marginBottom: space(2) }}>
            <Text style={{ fontSize: 12, color: colors.muted }}>#{task.id}</Text>
            <PriorityBadge priority={task.priority} />
            {task.done ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, height: 20, borderRadius: radius.sm, backgroundColor: colors.okSoft }}>
                <Icon name="checkCircle" size={13} color={colors.ok} />
                <Text style={{ color: colors.ok, fontSize: 11.5, fontWeight: '600' }}>Tamamlandı · {formatDate(task.done)}</Text>
              </View>
            ) : null}
          </View>
          <Text accessibilityRole="header" style={{ fontSize: font.h1, fontWeight: '700', color: colors.textStrong }}>{task.title}</Text>
          {labelNames ? <View style={{ marginTop: space(2) }}><LabelChips ids={task.labels} labels={project?.labels ?? []} /></View> : null}
          <View style={{ marginTop: space(3), gap: space(2) }}>
            {(
              [
                ['Atananlar', task.assignees.length ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2) }}><AvatarStack people={task.assignees} size={24} /><Text style={{ color: colors.text, flexShrink: 1 }}>{task.assignees.map((a) => a.displayName).join(', ')}</Text></View> : <Text style={{ color: colors.muted }}>—</Text>],
                ['Başlangıç', <Text style={{ color: task.startDate ? colors.text : colors.muted }}>{task.startDate ? formatDate(task.startDate) : '—'}</Text>],
                ['Bitiş', task.dueDate ? <DueBadge due={task.dueDate} done={task.done} /> : <Text style={{ color: colors.muted }}>—</Text>],
                ['Puan', <Text style={{ color: task.storyPoints != null ? colors.text : colors.muted }}>{task.storyPoints != null ? String(task.storyPoints) : '—'}</Text>],
                ['Tahmini', <Text style={{ color: task.estimateSec != null ? colors.text : colors.muted }}>{task.estimateSec != null ? `${Math.round((task.estimateSec / 3600) * 100) / 100} sa` : '—'}</Text>],
              ] as const
            ).map(([k, v]) => (
              <View key={k} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 24 }}>
                <Text style={{ width: 96, color: colors.muted, fontSize: font.small }}>{k}</Text>
                <View style={{ flex: 1 }}>{v}</View>
              </View>
            ))}
          </View>
          {task.description ? <Text style={{ marginTop: space(3), color: colors.text, lineHeight: 21 }} selectable>{task.description}</Text> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginTop: space(3) }}>
            {canEdit && !editing ? <Chip label={t.edit} icon="settings" selected={false} onPress={() => setEditing(true)} /> : null}
            <Chip label={task.done ? t.markUndone : t.markDone} icon="checkCircle" selected={!!task.done} onPress={() => (busy ? undefined : void toggleDone())} />
            {timeEnabled ? <Chip label="Zamanlayıcı başlat" icon="timer" selected={false} onPress={() => (busy ? undefined : void startTimer())} /> : null}
          </View>
          {timerNote ? <Text style={{ color: colors.ok, marginTop: space(2) }}>{timerNote}</Text> : null}
        </View>
        {editing && project ? (
          <TaskEditor
            key={task.lastModified}
            accountId={accountId}
            task={task}
            board={project}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              changed();
            }}
          />
        ) : null}
        <SubtaskSection accountId={accountId} task={task} canEdit={canEdit} onChanged={changed} />
        {project ? <DependencySection accountId={accountId} task={task} board={project} tasks={board.data?.tasks ?? []} canEdit={canEdit} onChanged={changed} /> : null}
        {goalsEnabled ? <TaskGoalsSection accountId={accountId} cardId={cardId} /> : null}
        <TaskWorkflowSection key={`wf-${task.done ?? 'open'}`} accountId={accountId} cardId={cardId} />
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
