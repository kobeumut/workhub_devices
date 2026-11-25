import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, SectionList, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { ASSIGNMENT_STATUSES, OcsError, canTrackTask, canWriteTaskComment, emptyFilters, kanbanColumns, loadPendingRequestApprovals, moveToColumn, projectWritePermissions, type AccountId, type AssignmentStatus, type BoardPayload, type ProjectSummary, type Task, type TaskDetail, type TaskFilters, type TaskSchedule, type WorkhubBadges } from '@workhub-devices/core';
import { useAsync, useServices } from './services';
import { Button, CountChip, Empty, ErrorBanner, Header, Loading, PageHeader, Pill, Row, card, styles as ui } from './ui';
import { colors, font, hexColor, radius, shadow, space } from './theme';
import { Icon, type IconName } from './icons';
import { AvatarStack, BoardToolbar, Chip, DueBadge, IconButton, KanbanBoard, LabelChips, PriorityBadge, RunningTimers, stackColor } from './kanban';
import { describeError, formatDate, formatDuration, formatTaskDate, t } from './i18n';
import { DependencySection, SubtaskSection, TaskEditor } from './taskEdit';
import { TaskGoalsSection } from './goals';
import { TaskWorkflowSection } from './workflows';
import { CreateProjectForm, ProjectAdminPanel } from './projectAdmin';
import { ActivityView, GanttView, TaskActivity, WorkloadScreen } from './views';
import { TaskTimeEntries } from './time';

const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** `version` changes whenever a task changes elsewhere, so open/done counters never stay stale. */
export function ProjectsScreen({ accountId, selected, onOpen, version = 0, onOpenTask, onOpenRequest, onOpenApprovals, requestsEnabled = false, timeReviewEnabled = false, badges, onRefreshBadges }: {
  accountId: AccountId;
  selected?: number;
  onOpen: (p: Pick<ProjectSummary, 'id' | 'title'>) => void;
  version?: number;
  onOpenTask?: (id: number) => void;
  onOpenRequest?: (id: number) => void;
  onOpenApprovals?: (kind: 'requests' | 'time') => void;
  requestsEnabled?: boolean;
  timeReviewEnabled?: boolean;
  badges?: WorkhubBadges | undefined;
  onRefreshBadges?: () => void;
}) {
  const { backend } = useServices();
  const s = useAsync(async () => ({ accountId, projects: await backend.projects(accountId) }), [accountId, version]);
  const projects = s.data?.accountId === accountId ? s.data.projects : undefined;
  const [personalBusy, setPersonalBusy] = useState(false);
  const [personalError, setPersonalError] = useState<unknown>();
  const approvals = badges?.approvals.total;
  const preview = useAsync(async () => {
    const [requests, timesheets] = await Promise.allSettled([
      requestsEnabled && onOpenRequest && approvals !== 0 ? loadPendingRequestApprovals((scope, state, cursor) => backend.requestPage(accountId, scope, state, cursor), null) : null,
      timeReviewEnabled && approvals !== 0 ? backend.timeReviews(accountId, 'pending') : [],
    ]);
    return { accountId, failed: requests.status === 'rejected' || timesheets.status === 'rejected',
      requests: requests.status === 'fulfilled' ? requests.value?.items ?? [] : [],
      timesheets: timesheets.status === 'fulfilled' ? timesheets.value.filter((row) => row.canReview === true && row.submission.status === 'pending') : [] };
  }, [backend, accountId, requestsEnabled, timeReviewEnabled, version, approvals]);
  const approvalRows = preview.data?.accountId === accountId && approvals !== 0 ? preview.data : undefined;
  const refresh = () => {
    s.reload();
    preview.reload();
    onRefreshBadges?.();
  };
  const openPersonal = async () => {
    if (personalBusy) return;
    setPersonalBusy(true);
    setPersonalError(undefined);
    try {
      const p = await backend.personalProject(accountId);
      refresh();
      onOpen({ id: p.id, title: t.personalProject });
    } catch (e) {
      setPersonalError(e);
    } finally {
      setPersonalBusy(false);
    }
  };
  const { width } = useWindowDimensions();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [showAllApprovals, setShowAllApprovals] = useState(false);
  const q = query.trim().toLocaleLowerCase('tr');
  const shown = (projects ?? []).filter((p) => !q || p.title.toLocaleLowerCase('tr').includes(q));
  // Web grid: `repeat(auto-fill, minmax(280px, 1fr))` inside the page padding.
  const columns = Math.max(1, Math.min(3, Math.floor((width >= 900 ? width - 600 : width) / 300)));
  const approvalItems = [
    ...(approvalRows?.requests ?? []).map((row) => ({ key: `request:${row.id}`, title: row.title, meta: `${row.requesterName} → ${row.recipientName} · ${formatDate(row.createdAt)}`, badge: t.page.sentToYou, open: () => onOpenRequest?.(row.id) })),
    ...(approvalRows?.timesheets ?? []).map((row) => ({ key: `time:${row.submission.id}`, title: row.user.displayName, meta: t.timesheetApprovalPeriod(formatDate(row.period.localStartDate), formatDate(row.period.localEndDate)), badge: t.page.timesheetPending, open: () => onOpenApprovals?.('time') })),
  ];
  const approvalTotal = approvals ?? approvalItems.length;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: space(6) }}>
      <PageHeader
        title={t.page.projects}
        subtitle={t.page.projectsSub}
        actions={<>
          <TextInput accessibilityLabel={t.page.searchProjects} placeholder={t.page.searchProjects} placeholderTextColor={colors.muted} value={query} onChangeText={setQuery} style={[ui.input, { minHeight: 36, width: width >= 600 ? 220 : 160, paddingVertical: 6 }]} />
          {projects && !projects.some((p) => p.personal) ? <Button title={t.personalProject} kind="secondary" busy={personalBusy} onPress={() => void openPersonal()} /> : null}
          <Button title={creating ? t.page.closeForm : t.page.newProject} kind={creating ? 'secondary' : 'primary'} onPress={() => setCreating((c) => !c)} />
        </>}
      />
      {creating ? (
        <CreateProjectForm
          accountId={accountId}
          onCreated={(p) => {
            setCreating(false);
            refresh();
            onOpen(p);
          }}
        />
      ) : null}
      <ErrorBanner error={personalError} />
      {onOpenApprovals && (approvalTotal > 0 || approvalItems.length > 0) ? (
        <View style={[card, shadow, { marginHorizontal: space(4), marginTop: space(2), borderColor: '#f5c27a', gap: space(2) }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2) }}>
            <Text accessibilityRole="header" style={{ fontSize: font.title, fontWeight: '800', color: colors.textStrong }}>{t.page.pendingApprovals}</Text>
            {approvalTotal ? <CountChip count={approvalTotal} /> : null}
            <View style={{ flex: 1 }} />
            <Button title={t.page.goToApprovals} kind="secondary" accessibilityLabel={approvals ? t.approvalsCount(approvals) : t.waitingApprovals} onPress={() => onOpenApprovals(requestsEnabled ? 'requests' : 'time')} />
          </View>
          {approvalRows?.failed ? <Text style={{ color: colors.muted }}>{t.approvalsPartial}</Text> : null}
          {(showAllApprovals ? approvalItems : approvalItems.slice(0, 5)).map((row) => (
            <Pressable key={row.key} accessibilityRole="button" accessibilityLabel={`${row.title}, ${row.badge}`} onPress={row.open} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space(2), padding: space(3), borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: pressed ? colors.hover : colors.bg })}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text numberOfLines={1} style={{ fontWeight: '700', color: colors.textStrong }}>{row.title}</Text>
                <Text numberOfLines={1} style={{ fontSize: font.small, color: colors.muted }}>{row.meta}</Text>
              </View>
              <Pill label={row.badge} tone="warning" />
            </Pressable>
          ))}
          {!showAllApprovals && approvalItems.length > 5 ? (
            <Pressable accessibilityRole="button" onPress={() => setShowAllApprovals(true)} style={{ alignSelf: 'flex-start', paddingVertical: space(1) }}>
              <Text style={{ color: colors.text, fontSize: font.small }}>{t.page.showAll(approvalTotal)}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {onOpenTask ? <AssignedTaskList key={accountId} accountId={accountId} version={version} onOpenTask={onOpenTask} /> : null}
      <Text accessibilityRole="header" style={{ fontSize: font.title, fontWeight: '800', color: colors.textStrong, marginHorizontal: space(4), marginTop: space(4), marginBottom: space(2) }}>{t.page.allProjects}</Text>
      <ErrorBanner error={s.error} onRetry={refresh} />
      {s.loading && !projects ? <Loading /> : !shown.length && !s.error ? <Empty text={projects?.length ? t.page.noProjectMatch : t.noProjects} /> : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(3), paddingHorizontal: space(4) }}>
          {shown.map((item) => {
            const attention = badges?.overdueByProject[item.id] ?? 0;
            const overdue = attention || item.overdueCount;
            const total = item.openCount + item.doneCount;
            const color = hexColor(item.color);
            return (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityState={{ selected: item.id === selected }}
                accessibilityLabel={[item.title, item.reviewer && t.reviewerProject, t.projectOpenCount(item.openCount), t.projectDoneCount(item.doneCount), overdue > 0 && t.projectOverdueCount(overdue)].filter(Boolean).join(', ')}
                onPress={() => onOpen(item)}
                style={({ pressed }) => [card, shadow, { marginBottom: 0, width: columns === 1 ? '100%' : `${(100 - columns * 2) / columns}%`, flexGrow: 1, minHeight: 96, gap: space(2), borderColor: item.id === selected ? colors.primary : colors.border, backgroundColor: pressed ? colors.hover : colors.bg }]}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2) }}>
                  <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: color }} accessibilityElementsHidden />
                  <Text numberOfLines={1} style={{ flex: 1, fontSize: font.body, fontWeight: '700', color: colors.textStrong }}>{item.title}</Text>
                </View>
                {total > 0 ? (
                  <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.hover, overflow: 'hidden' }} accessibilityElementsHidden>
                    <View style={{ width: `${Math.round((item.doneCount / total) * 100)}%`, height: 4, backgroundColor: color }} />
                  </View>
                ) : null}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(3) }}>
                  <Text style={{ fontSize: font.small, color: colors.muted }}>{t.projectOpenCount(item.openCount)}</Text>
                  <Text style={{ fontSize: font.small, color: colors.muted }}>{t.projectDoneCount(item.doneCount)}</Text>
                  {overdue ? <Text style={{ fontSize: font.small, color: attention ? colors.danger : colors.muted, fontWeight: attention ? '600' : '400' }}>{t.projectOverdueCount(overdue)}</Text> : null}
                  {item.reviewer ? <Pill label={t.reviewerProject} /> : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

/** Web `AssignedTasks.vue`: status filter + the first rows, "Tümünü göster" for the rest. */
function AssignedTaskList({ accountId, version, onOpenTask }: { accountId: AccountId; version: number; onOpenTask: (id: number) => void }) {
  const { backend } = useServices();
  const [status, setStatus] = useState<AssignmentStatus>('open');
  const [all, setAll] = useState(false);
  const s = useAsync(async () => ({ status, list: await backend.assignedTasks(accountId, status) }), [accountId, status, version]);
  const list = s.data?.status === status ? s.data.list : undefined;
  const boards = new Map(list?.boards.map((p) => [p.id, p]));
  const tasks = list?.tasks ?? [];
  return (
    <View style={{ marginHorizontal: space(4), marginTop: space(4), gap: space(2) }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(2) }}>
        <Text accessibilityRole="header" style={{ fontSize: font.title, fontWeight: '800', color: colors.textStrong }}>{t.page.assignedTasks}</Text>
        {list ? <Pill label={String(tasks.length)} /> : null}
        <Text style={{ fontSize: font.small, color: colors.muted }}>{t.page.assignedTasksSub}</Text>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
        {ASSIGNMENT_STATUSES.map((key) => <Chip key={key} label={t.assignmentStatus[key]} selected={key === status} onPress={() => setStatus(key)} />)}
      </View>
      <ErrorBanner error={s.error} onRetry={s.reload} />
      {s.loading && !list ? <Loading /> : (
        <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: 'hidden' }}>
          {list?.truncated ? <Text style={{ padding: space(2), color: colors.muted }}>{t.assignmentsTruncated}</Text> : null}
          {!tasks.length && !s.error ? <Text style={{ padding: space(3), color: colors.muted }}>{t.noAssignedTasks}</Text> : null}
          {(all ? tasks : tasks.slice(0, 8)).map((item) => {
            const project = boards.get(item.boardId);
            return (
              <Pressable key={item.id} accessibilityRole="button" onPress={() => onOpenTask(item.id)} style={({ pressed }) => ({ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(2), paddingHorizontal: space(3), paddingVertical: space(2), minHeight: 48, backgroundColor: pressed ? colors.hover : colors.bg, borderBottomWidth: 1, borderColor: colors.border })}>
                {item.done ? <Icon name="checkCircle" size={16} color={colors.ok} /> : null}
                <Text style={{ fontSize: font.small, color: colors.faint, fontVariant: ['tabular-nums'] }}>#{item.id}</Text>
                <Text numberOfLines={1} style={{ flexGrow: 1, flexShrink: 1, minWidth: 140, color: colors.textStrong, fontWeight: '600' }}>{item.title}</Text>
                {project ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: hexColor(project.color) }} />
                    <Text numberOfLines={1} style={{ color: colors.muted, fontSize: font.small, maxWidth: 220 }}>{project.title}</Text>
                  </View>
                ) : null}
                <PriorityBadge priority={item.priority} />
                <DueBadge due={item.dueDate} done={item.done} />
              </Pressable>
            );
          })}
        </View>
      )}
      {!all && tasks.length > 8 ? (
        <Pressable accessibilityRole="button" onPress={() => setAll(true)} style={{ alignSelf: 'flex-start', paddingVertical: space(1) }}>
          <Text style={{ color: colors.text, fontSize: font.small }}>{t.page.showAll(tasks.length)}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

type BoardView = 'kanban' | 'board' | 'gantt' | 'activity' | 'workload' | 'archived';

/** View tabs of the project workspace (web `ProjectWorkspace.vue`: Board, List, Gantt, Activity, Workload). */
const VIEWS: readonly (readonly [BoardView, string, IconName])[] = [
  ['archived', t.archivedTasks, 'archive'],
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
  const { backend, platform } = useServices();
  // `version` bumps when a task changes elsewhere (e.g. the task drawer), so cards never go stale.
  const [view, setView] = useState<BoardView>('kanban');
  const s = useAsync(async () => ({ accountId, board: await backend.board(accountId, project.id) }), [accountId, project.id, version]);
  const archived = useAsync(async () => ({ accountId, projectId: project.id, tasks: view === 'archived' ? (await backend.board(accountId, project.id, true)).tasks.filter((task) => task.archived) : [] }), [accountId, project.id, version, view]);
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [moving, setMoving] = useState<Task | null>(null);
  const [managing, setManaging] = useState(false);
  const [filters, setFilters] = useState<TaskFilters>(emptyFilters);
  const [addIn, setAddIn] = useState<number | null>(null);
  // Optimistic board while a move/toggle is in flight (the server answer replaces it).
  const [optimistic, setOptimistic] = useState<BoardPayload | null>(null);
  const loaded = s.data?.accountId === accountId ? s.data.board : undefined;
  const readDenied = s.error instanceof OcsError && ['unauthorized', 'forbidden', 'not_found'].includes(s.error.kind);
  const board = !readDenied && loaded?.project.board.id === project.id ? optimistic ?? loaded : undefined;
  const archivedTasks = !archived.error && archived.data?.accountId === accountId && archived.data.projectId === project.id ? archived.data.tasks : [];
  const teamTimers = (board?.tasks ?? []).filter((task) => !task.archived).flatMap((task) =>
    (task.runningTimers ?? []).filter((timer) => timer.uid !== me).map((timer) => ({ task, timer })),
  ).sort((a, b) => a.timer.startedAt.localeCompare(b.timer.startedAt));
  const { edit: canEdit, share, manage } = projectWritePermissions(s.error ? undefined : board?.project);
  const canAdmin = manage || share;
  const columns = useMemo(() => (board ? kanbanColumns(board, filters, me) : []), [board, filters, me]);
  const sections = columns.map((c) => ({ stack: c.stack, title: c.stack.title, data: c.tasks, total: c.totalCount }));
  const { width } = useWindowDimensions();
  const narrow = width < 600;

  const refresh = () => {
    s.reload();
    onChanged?.();
  };
  useEffect(() => {
    setOptimistic(null);
    setMoving(null);
    setAddIn(null);
  }, [s.data, accountId, project.id]);
  useEffect(() => {
    if (managing || addIn !== null || moving || busy || optimistic) return;
    const poll = setInterval(() => { if (platform.isActive?.() !== false) s.reload(); }, 60_000);
    return () => clearInterval(poll);
  }, [platform, s.reload, managing, addIn, moving, busy, optimistic]);

  const createIn = async (stackId: number, title: string, schedule?: TaskSchedule) => {
    if (!canEdit) throw new OcsError('forbidden');
    setErr(undefined);
    try {
      await backend.createTask(accountId, project.id, stackId, title, uuid(), schedule);
      refresh();
    } catch (e) {
      setErr(e);
      throw e;
    }
  };

  const create = async () => {
    const first = sections[0]?.stack;
    if (busy || !first || !newTitle.trim()) return;
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
    if (!canEdit || task.archived) return;
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
      setOptimistic(null);
      setErr(e);
    }
    refresh();
  };

  const toggleDone = async (task: Task) => {
    if (!canEdit || task.archived) return;
    setErr(undefined);
    if (board) setOptimistic({ ...board, tasks: board.tasks.map((x) => (x.id === task.id ? { ...x, done: x.done ? null : new Date().toISOString() } : x)) });
    try {
      await backend.updateTask(accountId, task.id, { done: !task.done });
    } catch (e) {
      setOptimistic(null);
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
        {board?.project.reviewer ? <Text style={{ color: colors.muted, fontSize: font.small }}>{t.reviewerProject}</Text> : null}
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
        {canEdit && (showToolbar || view === 'gantt') ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.newTask}
            onPress={() => {
              setView('kanban');
              setAddIn(sections[0]?.stack.id ?? null);
            }}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: space(3), borderRadius: radius.sm, backgroundColor: pressed ? colors.primaryStrong : colors.primary })}
          >
            <Icon name="plus" size={16} color={colors.primaryText} />
            {narrow ? null : <Text style={{ color: colors.primaryText, fontWeight: '600' }}>{t.newTask}</Text>}
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
            key={`${accountId}:${project.id}|${board.project.board.title}|${board.project.stacks.map((x) => `${x.id}:${x.title}:${x.order}`).join(',')}`}
            accountId={accountId}
            board={board.project}
            onChanged={refresh}
          />
        </ScrollView>
      ) : null}
      {teamTimers.length ? (
        <ScrollView horizontal style={{ flexGrow: 0 }} contentContainerStyle={{ gap: space(2), paddingHorizontal: space(2) }}>
          {teamTimers.map(({ task, timer }) => <Pressable key={`${task.id}:${timer.uid}`} accessibilityRole="button" onPress={() => onOpenTask(task.id)} style={{ padding: space(2) }}>
            <Text numberOfLines={1} style={{ color: colors.text }}>{task.title}</Text>
            <RunningTimers timers={[timer]} />
          </Pressable>)}
        </ScrollView>
      ) : null}
      {showToolbar && board ? <BoardToolbar filters={filters} onChange={setFilters} /> : null}
      {view === 'gantt' ? <GanttView accountId={accountId} boardId={project.id} onOpenTask={onOpenTask} /> : null}
      {view === 'activity' ? <ActivityView accountId={accountId} boardId={project.id} onOpenTask={onOpenTask} /> : null}
      {view === 'archived' && board ? (
        <>
          <ErrorBanner error={archived.error} onRetry={archived.reload} />
          {s.loading || archived.loading ? <Loading /> : <FlatList
            data={archivedTasks}
            keyExtractor={(task) => String(task.id)}
            ListEmptyComponent={!archived.error ? <Empty text={t.noArchivedTasks} /> : undefined}
            renderItem={({ item }) => <Row title={item.title} subtitle={`#${item.id}`} onPress={() => onOpenTask(item.id)} />}
            refreshing={archived.loading}
            onRefresh={archived.reload}
          />}
        </>
      ) : null}
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
          <TextInput accessibilityLabel={t.newTask} placeholder={`${t.newTask} (${sections[0]?.title ?? ''})`} placeholderTextColor={colors.muted} value={newTitle} maxLength={255} onChangeText={setNewTitle} onSubmitEditing={() => void create()} style={[ui.input, { flex: 1 }]} />
          <Button title="+" accessibilityLabel={t.newTask} onPress={() => void create()} busy={busy} disabled={!newTitle.trim()} />
        </View>
      ) : null}
      {canEdit && moving ? (
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
                    <RunningTimers timers={item.runningTimers} />
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
  const [history, setHistory] = useState<'comments' | 'activity'>('comments');
  const [revision, setRevision] = useState(0);
  const week = useAsync(() => timeEnabled && s.data?.state === 'ok' && !s.data.task.archived ? backend.timeWeek(accountId) : Promise.resolve(undefined), [accountId, cardId, timeEnabled, s.data?.state === 'ok' && !s.data.task.archived]);
  const changed = () => {
    s.reload();
    board.reload();
    week.reload();
    setRevision((n) => n + 1);
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
  const canManageTask = projectWritePermissions(project).edit;
  const canEdit = canManageTask && !task.archived;
  const canComment = !task.archived && canWriteTaskComment(project, task);
  const canTrack = !!timeEnabled && !task.archived && canTrackTask(project, week.data?.policy);
  const timer = week.data?.timer;
  const ownTimer = !!timer && timer.cardId === cardId;
  const labelNames = (project?.labels ?? []).filter((l) => !l.priority && task.labels.includes(l.id)).map((l) => l.title).join(', ');

  const patchTask = async (patch: { done: boolean } | { archived: boolean }) => {
    if (busy || ('archived' in patch ? !canManageTask : !canEdit)) return;
    setBusy(true);
    setErr(undefined);
    try {
      await backend.updateTask(accountId, cardId, patch);
      setEditing(false);
      changed();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const changeTimer = async () => {
    if (!canTrack || busy || week.loading || (timer && !ownTimer)) return;
    setBusy(true);
    setErr(undefined);
    setTimerNote(undefined);
    try {
      if (ownTimer) await backend.timerStop(accountId);
      else await backend.timerStart(accountId, cardId, '', uuid());
      setTimerNote(ownTimer ? t.timerStopped : t.timerStarted);
      // The server chooses whether to move the card. Re-read both the card and board.
      changed();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const addComment = async () => {
    const msg = comment.trim();
    if (!canComment || busy || !msg) return;
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
          {task.archived ? <Text style={{ color: colors.muted }}>{t.taskArchived}</Text> : null}
          {labelNames ? <View style={{ marginTop: space(2) }}><LabelChips ids={task.labels} labels={project?.labels ?? []} /></View> : null}
          <View style={{ marginTop: space(3), gap: space(2) }}>
            {(
              [
                [t.assignees, task.assignees.length ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2) }}><AvatarStack people={task.assignees} size={24} /><Text style={{ color: colors.text, flexShrink: 1 }}>{task.assignees.map((a) => a.displayName).join(', ')}</Text></View> : <Text style={{ color: colors.muted }}>—</Text>],
                [t.start, <Text style={{ color: task.startDate ? colors.text : colors.muted }}>{task.startDate ? formatTaskDate(task.startDate, 'start', true) : '—'}</Text>],
                [t.due, task.dueDate ? <DueBadge due={task.dueDate} done={task.done} /> : <Text style={{ color: colors.muted }}>—</Text>],
                ['Puan', <Text style={{ color: task.storyPoints != null ? colors.text : colors.muted }}>{task.storyPoints != null ? String(task.storyPoints) : '—'}</Text>],
                [t.taskEstimate, <Text style={{ color: task.estimateSec != null ? colors.text : colors.muted }}>{task.estimateSec != null ? formatDuration(task.estimateSec) : '—'}</Text>],
                ...(timeEnabled && typeof task.trackedSec === 'number' ? [[t.taskTimeTracked, <Text style={{ color: colors.text }}>{formatDuration(task.trackedSec)}</Text>]] as const : []),
                ...(timeEnabled && typeof task.mySec === 'number' ? [[t.myTimeTracked, <Text style={{ color: colors.text }}>{formatDuration(task.mySec)}</Text>]] as const : []),
              ] as const
            ).map(([k, v]) => (
              <View key={k} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 24 }}>
                <Text style={{ width: 96, color: colors.muted, fontSize: font.small }}>{k}</Text>
                <View style={{ flex: 1 }}>{v}</View>
              </View>
            ))}
          </View>
          {task.description ? <Text style={{ marginTop: space(3), color: colors.text, lineHeight: 21 }} selectable>{task.description}</Text> : null}
          <RunningTimers timers={task.runningTimers} />
          <ErrorBanner error={week.error} onRetry={week.reload} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginTop: space(3) }}>
            {canEdit && !editing ? <Chip label={t.edit} icon="settings" selected={false} onPress={() => setEditing(true)} /> : null}
            {canEdit ? <Chip label={task.done ? t.markUndone : t.markDone} icon="checkCircle" selected={!!task.done} onPress={() => void patchTask({ done: !task.done })} /> : null}
            {canManageTask ? <Button title={task.archived ? t.unarchiveTask : t.archiveTask} kind="secondary" disabled={busy} onPress={() => void patchTask({ archived: !task.archived })} /> : null}
            {canTrack && (!timer || ownTimer) ? <Button title={ownTimer ? t.stopTimer : t.startTimer} kind="secondary" disabled={busy || week.loading} onPress={() => void changeTimer()} /> : null}
          </View>
          {timerNote ? <Text style={{ color: colors.ok, marginTop: space(2) }}>{timerNote}</Text> : null}
        </View>
        {editing && project && canEdit ? (
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
        {goalsEnabled ? <TaskGoalsSection accountId={accountId} cardId={cardId} readOnly={!canEdit} /> : null}
        <TaskWorkflowSection key={`wf-${task.done ?? 'open'}`} accountId={accountId} cardId={cardId} readOnly={!canEdit} />
        {timeEnabled ? <TaskTimeEntries key={`${accountId}:${cardId}`} accountId={accountId} task={task} week={week.data} canTrack={canTrack} onChanged={changed} /> : null}
        <View style={card}>
          <View accessibilityRole="tablist" style={{ flexDirection: 'row', gap: space(2), marginBottom: space(2) }}>
            {(['comments', 'activity'] as const).map((tab) => (
              <Pressable key={tab} accessibilityRole="tab" accessibilityState={{ selected: tab === history }} onPress={() => setHistory(tab)} style={{ padding: space(2), borderBottomWidth: 2, borderColor: tab === history ? colors.primary : 'transparent' }}>
                <Text style={{ color: colors.text, fontWeight: '600' }}>{t[tab]}</Text>
              </Pressable>
            ))}
          </View>
          {history === 'activity' ? <TaskActivity key={`${accountId}:${cardId}:${revision}`} accountId={accountId} cardId={cardId} /> : <>
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
          {canComment ? <><TextInput accessibilityLabel={t.addComment} placeholder={t.addComment} placeholderTextColor={colors.muted} value={comment} onChangeText={setComment} maxLength={4000} multiline style={[ui.input, { minHeight: 64, paddingTop: 10 }]} />
          <Button title={t.addComment} onPress={() => void addComment()} busy={busy} disabled={!comment.trim()} /></> : null}
          </>}
        </View>
      </ScrollView>
    </View>
  );
}
