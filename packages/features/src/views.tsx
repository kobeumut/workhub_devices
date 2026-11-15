import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import {
  ACTIVITY_TYPES, deviceDay, ganttBar, ganttSchedule, mergeActivity, workloadLoad, workloadWeek, addDays,
  type AccountId, type ActivityEvent, type ActivityFilter, type ActivityType, type DependencyType, type GanttRow, type WorkloadDay, type WorkloadMatrix, type WorkloadMember,
} from '@workhub-devices/core';
import { useAsync, useServices } from './services';
import { Button, Empty, ErrorBanner, Loading, card, styles as ui } from './ui';
import { colors, font, space } from './theme';
import { formatDate, intlTag, messages, t } from './i18n';

// Not `m`: the workload screen below keeps its matrix in a local named `m`.
const msg = messages.tasks;

// ---- shared bits ---------------------------------------------------------------------------

const weekdayOf = (day: string) => ((Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000) + 3) % 7 + 7) % 7;
/** "Nov 2" / "2 Kas" for a local day string (no time-zone shift: the day is formatted as UTC). */
export const shortDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(intlTag(), { day: 'numeric', month: 'short', timeZone: 'UTC' });
const longDay = (day: string) => msg.longDay(msg.weekdayLong(weekdayOf(day)), new Date(`${day}T00:00:00Z`).toLocaleDateString(intlTag(), { day: 'numeric', month: 'long', timeZone: 'UTC' }));
/** Hours with one decimal in the active language's number format ("3.5" / "3,5"). */
export const hours = (sec: number) => {
  const h = Math.round((sec / 3600) * 10) / 10;
  return sec > 0 && h === 0 ? msg.hoursLessThanTenth : h.toLocaleString(intlTag(), { maximumFractionDigits: 1 });
};
const today = () => deviceDay(new Date().toISOString());

function Chip({ label, selected, onPress, a11y }: { label: string; selected: boolean; onPress: () => void; a11y?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      {...(a11y ? { accessibilityLabel: a11y } : {})}
      onPress={onPress}
      style={{ paddingHorizontal: space(3), minHeight: 36, justifyContent: 'center', borderRadius: 18, borderWidth: 1, borderColor: selected ? colors.primary : colors.border, backgroundColor: selected ? colors.primary : colors.bg }}
    >
      <Text style={{ color: selected ? colors.primaryText : colors.text, fontWeight: selected ? '700' : '400' }}>{label}</Text>
    </Pressable>
  );
}

// ---- Gantt ---------------------------------------------------------------------------------

const depType = (type: DependencyType): string => (type === 'finish_to_start' ? msg.depFinishToStart : type === 'start_to_start' ? msg.depStartToStart : msg.depFinishToFinish);
/** Dependency type, with its lag in days when there is one. */
const depText = (type: DependencyType, lag: number): string => (lag ? msg.depWithLag(depType(type), lag) : depType(type));

function rowDates(r: GanttRow): string {
  if (!r.start || !r.end) return msg.ganttNoDate;
  return r.milestone ? msg.ganttMilestone(shortDay(r.end)) : msg.ganttRange(shortDay(r.start), shortDay(r.end), r.days);
}

/** Full spoken description of a Gantt row; the drawn bar itself is hidden from screen readers. */
export function ganttRowLabel(r: GanttRow): string {
  const parts = [r.task.title, rowDates(r)];
  if (r.done) parts.push(msg.done);
  else if (r.overdue) parts.push(msg.overdue);
  if (r.task.assignees.length) parts.push(msg.ganttSpokenAssigned(r.task.assignees.map((a) => a.displayName).join(', ')));
  if (r.task.subtasks.total) parts.push(msg.ganttSpokenSubtasks(r.task.subtasks.done, r.task.subtasks.total));
  for (const l of r.waitsFor) parts.push(msg.ganttSpokenWaitsFor(l.other.title, depText(l.dependency.type, l.dependency.lagDays), !!l.other.done, l.violated));
  for (const l of r.blocks) parts.push(msg.ganttSpokenBlocks(l.other.title, l.violated));
  return parts.join('; ');
}

/**
 * Accessible Gantt: an ordered list of tasks by date, each with its date range, status and
 * dependencies spelled out, plus a decorative proportional bar. No chart library; nothing is
 * conveyed by colour or position alone.
 */
export function GanttView({ accountId, boardId, onOpenTask }: { accountId: AccountId; boardId: number; onOpenTask: (cardId: number) => void }) {
  const { backend } = useServices();
  const s = useAsync(() => backend.projectGantt(accountId, boardId), [accountId, boardId]);
  const now = today();
  const sched = useMemo(() => (s.data ? ganttSchedule(s.data, now) : null), [s.data, now]);
  if (s.loading && !s.data) return <Loading />;
  if (!sched) return <ErrorBanner error={s.error} onRetry={s.reload} />;
  const range = sched.range;
  const todayAt = range && now >= range.start && now <= range.end ? ganttBar({ start: now, end: now }, range)!.left : null;

  const renderRow = (r: GanttRow) => {
    const bar = range ? ganttBar(r, range) : null;
    return (
      <Pressable key={r.task.id} accessibilityRole="button" accessibilityLabel={ganttRowLabel(r)} accessibilityHint={msg.openTaskHint} onPress={() => onOpenTask(r.task.id)} style={{ paddingHorizontal: space(4), paddingVertical: space(2), borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.bg }}>
        <Text numberOfLines={1} style={{ fontWeight: '600', color: colors.text }}>
          {r.done ? '✓ ' : r.overdue ? '⚠ ' : ''}
          {r.task.title}
        </Text>
        <Text style={{ color: r.overdue ? colors.danger : colors.muted, fontSize: font.small }}>
          {rowDates(r)}
          {r.overdue ? ` · ${msg.overdue}` : ''}
          {r.task.assignees.length ? ` · ${r.task.assignees.map((a) => a.displayName).join(', ')}` : ''}
        </Text>
        {bar ? (
          <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden aria-hidden style={{ height: 10, marginTop: space(1), backgroundColor: colors.surface, borderRadius: 3 }}>
            {todayAt !== null ? <View style={{ position: 'absolute', left: `${todayAt * 100}%`, top: -2, bottom: -2, width: 2, backgroundColor: colors.danger }} /> : null}
            <View
              style={{
                position: 'absolute', left: `${bar.left * 100}%`, width: r.milestone ? 10 : `${Math.max(bar.width * 100, 1)}%`, top: 0, bottom: 0, borderRadius: r.milestone ? 5 : 3,
                backgroundColor: r.done ? colors.ok : r.overdue ? colors.danger : colors.primary, opacity: r.done ? 0.6 : 1,
              }}
            />
          </View>
        ) : null}
        {r.waitsFor.map((l) => (
          <Text key={l.dependency.id} style={{ fontSize: font.small, color: l.violated ? colors.danger : colors.muted }}>
            ↳ {msg.ganttWaitsForLine(l.other.title, depText(l.dependency.type, l.dependency.lagDays), !!l.other.done, l.violated)}
          </Text>
        ))}
        {r.blocks.length ? <Text style={{ fontSize: font.small, color: colors.muted }}>→ {msg.ganttBlocksLine(r.blocks.map((l) => l.other.title).join(', '))}</Text> : null}
      </Pressable>
    );
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.surface }}>
      <ErrorBanner error={s.error} onRetry={s.reload} />
      <View style={{ padding: space(3), flexDirection: 'row', alignItems: 'center', gap: space(2), flexWrap: 'wrap' }}>
        <Text accessibilityRole="header" style={{ fontWeight: '700', color: colors.text }}>
          {range ? msg.ganttTitleRange(shortDay(range.start), shortDay(range.end)) : msg.ganttTitle}
        </Text>
        <Text style={{ color: sched.violations ? colors.danger : colors.muted }}>
          {msg.ganttSummary(sched.rows.length, sched.unscheduled.length, sched.violations)}
        </Text>
        <Pressable accessibilityRole="button" onPress={s.reload}>
          <Text style={{ color: colors.primary, fontWeight: '600' }}>{msg.refresh}</Text>
        </Pressable>
      </View>
      {sched.rows.length === 0 ? <Empty text={msg.ganttEmpty} /> : sched.rows.map(renderRow)}
      {sched.unscheduled.length ? (
        <>
          <Text accessibilityRole="header" style={{ padding: space(3), fontWeight: '700', color: colors.muted }}>
            {msg.ganttUnscheduledHeader(sched.unscheduled.length)}
          </Text>
          {sched.unscheduled.map(renderRow)}
        </>
      ) : null}
    </ScrollView>
  );
}

// ---- Activity --------------------------------------------------------------------------------

const typeLabel = (type: ActivityType): string =>
  ({ all: msg.typeAll, status: msg.typeStatus, comments: t.comments, subtasks: msg.typeSubtasks, time: msg.typeTime, goal: msg.typeGoal })[type];
const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const clip = (v: string, n = 120) => (v.length > n ? `${v.slice(0, n)}…` : v);
const pct = (bp: unknown) => (typeof bp === 'number' ? msg.percent(Math.round(bp / 100)) : '—');
const dateOf = (v: unknown) => (typeof v === 'string' && v ? formatDate(v) : '—');

/** One-line summary of an event in the active language (plain text; server strings are never rendered as HTML). */
export function activityText(e: ActivityEvent): string {
  const d = e.data;
  const name = (o: unknown) => str((o as { displayName?: string } | null)?.displayName);
  switch (e.kind) {
    case 'card_create': return msg.actCardCreate;
    case 'card_delete': return msg.actCardDelete;
    case 'card_restore': return msg.actCardRestore;
    case 'card_update_stackId': return msg.actCardMove(str(d.from) || '—', str(d.to) || '—');
    case 'card_update_done': return msg.actCardDone;
    case 'card_update_undone': return msg.actCardUndone;
    case 'card_update_archive': return msg.actCardArchive;
    case 'card_update_unarchive': return msg.actCardUnarchive;
    case 'card_comment_create': return d.comment ? msg.actComment(clip(str(d.comment))) : msg.actCommentPlain;
    case 'card_update_title': return msg.actTitle(clip(str(d.before), 60), clip(str(d.after), 60));
    case 'card_update_description': return msg.actDescription;
    case 'card_update_duedate': return msg.actDueDate(dateOf(d.before), dateOf(d.after));
    case 'card_user_assign': return msg.actAssign(name(d.assignee));
    case 'card_user_unassign': return msg.actUnassign(name(d.assignee));
    case 'label_assign': return msg.actLabelAdd(str((d.label as { title?: string } | null)?.title));
    case 'label_unassign': return msg.actLabelRemove(str((d.label as { title?: string } | null)?.title));
    case 'attachment_create': return msg.actAttachmentAdd(clip(str(d.attachment), 60));
    case 'attachment_delete': return msg.actAttachmentDelete(clip(str(d.attachment), 60));
    case 'time_logged': return msg.actTimeLogged(hours(Number(d.durationSec) || 0), hours(Number(d.cardTotalSec) || 0), d.description ? clip(str(d.description), 80) : '');
    case 'goal.create': return msg.actGoalCreate(str((d.goal as { title?: string })?.title));
    case 'goal.progress': return msg.actGoalProgress(str((d.goal as { title?: string })?.title), pct(d.fromBp), pct(d.toBp));
    case 'target.cards': return msg.actTargetCards(str((d.goal as { title?: string })?.title), Number(d.added) || 0, Number(d.removed) || 0);
    case 'target.create': return msg.actTargetCreate(str(d.title));
    case 'target.delete': return msg.actTargetDelete(str(d.title));
    case 'goal.checkin': {
      const v = (x: unknown) => (typeof x === 'boolean' ? (x ? msg.yes : msg.no) : str(x) || '—');
      return msg.actCheckin(str(d.target), v(d.from), v(d.to), d.note ? clip(str(d.note), 80) : '');
    }
    case 'task.subtask.add': return msg.actSubtaskAdd(clip(str(d.text), 80), Number(d.done) || 0, Number(d.total) || 0);
    case 'task.subtask.check': return msg.actSubtaskCheck(clip(str(d.text), 80), Number(d.done) || 0, Number(d.total) || 0);
    case 'task.subtask.uncheck': return msg.actSubtaskUncheck(clip(str(d.text), 80));
    case 'task.subtask.remove': return msg.actSubtaskRemove(clip(str(d.text), 80));
    case 'task.subtask.rename': return msg.actSubtaskRename(clip(str(d.previous), 60), clip(str(d.text), 60));
    default: return e.kind;
  }
}

const eventTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(intlTag(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

/** Project activity stream: type filter, search, cursor paging ("Older"). */
export function ActivityView({ accountId, boardId, onOpenTask }: { accountId: AccountId; boardId: number; onOpenTask: (cardId: number) => void }) {
  const { backend } = useServices();
  const [type, setType] = useState<ActivityType>('all');
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const filter: ActivityFilter = { type, ...(q ? { q } : {}) };
  const first = useAsync(() => backend.projectActivity(accountId, boardId, filter, null), [accountId, boardId, type, q]);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  useEffect(() => {
    if (!first.data) return;
    setEvents(first.data.events);
    setCursor(first.data.nextCursor);
    setErr(undefined);
  }, [first.data]);

  const more = async () => {
    if (!cursor) return;
    setBusy(true);
    setErr(undefined);
    try {
      const page = await backend.projectActivity(accountId, boardId, filter, cursor);
      setEvents((shown) => mergeActivity(shown, page.events));
      setCursor(page.nextCursor);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const sources = first.data?.sources;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.surface }} contentContainerStyle={{ paddingBottom: space(6) }}>
      <View accessibilityLabel={msg.activityTypeLabel} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), padding: space(3) }}>
        {ACTIVITY_TYPES.map((k) => (
          <Chip key={k} label={typeLabel(k)} a11y={msg.activityFilterLabel(typeLabel(k))} selected={type === k} onPress={() => setType(k)} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: space(2), paddingHorizontal: space(3), paddingBottom: space(2) }}>
        <TextInput accessibilityLabel={msg.activitySearchLabel} placeholder={msg.activitySearchPlaceholder} placeholderTextColor={colors.muted} value={query} onChangeText={setQuery} onSubmitEditing={() => setQ(query.trim())} style={[ui.input, { flex: 1 }]} />
        <Button title={msg.search} kind="secondary" onPress={() => setQ(query.trim())} />
      </View>
      {q ? <Text style={{ paddingHorizontal: space(3), color: colors.muted, fontSize: font.small }}>{msg.activitySearchNote(msg.activityOlder)}</Text> : null}
      {sources && !sources.deck ? <Text style={{ paddingHorizontal: space(3), color: colors.muted, fontSize: font.small }}>{msg.activityAppOff}</Text> : null}
      <ErrorBanner error={first.error ?? err} onRetry={first.error ? first.reload : () => void more()} />
      {first.loading && !first.data ? (
        <Loading />
      ) : events.length === 0 ? (
        <Empty text={first.error ? '' : msg.activityEmpty} />
      ) : (
        <View accessibilityRole="list">
          {events.map((e) => {
            const who = e.actor?.displayName ?? msg.activitySystem;
            const text = activityText(e);
            const target = e.card ? msg.activityTarget(e.card.title || `#${e.card.id}`, !e.card.exists) : '';
            const label = msg.activityRowLabel(who, text, target, eventTime(e.occurredAt));
            const open = e.card?.exists ? () => onOpenTask(e.card!.id) : undefined;
            return (
              <Pressable key={e.id} accessibilityRole={open ? 'button' : 'text'} accessibilityLabel={label} {...(open ? { onPress: open, accessibilityHint: msg.openTaskHint } : {})} style={{ paddingHorizontal: space(4), paddingVertical: space(2), borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.bg }}>
                <Text style={{ color: colors.text }}>
                  <Text style={{ fontWeight: '700' }}>{who}</Text> {text}
                </Text>
                <Text style={{ color: colors.muted, fontSize: font.small }}>
                  {target ? `${target} · ` : ''}
                  {eventTime(e.occurredAt)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
      {cursor ? <Button title={msg.activityOlder} kind="secondary" busy={busy} onPress={() => void more()} /> : events.length ? <Text style={{ padding: space(3), color: colors.muted, textAlign: 'center' }}>{msg.activityEnd}</Text> : null}
    </ScrollView>
  );
}

// ---- Workload --------------------------------------------------------------------------------

const loadText = (load: 'off' | 'free' | 'ok' | 'full' | 'over'): string =>
  ({ off: msg.loadOff, free: msg.loadFree, ok: msg.loadOk, full: msg.loadFull, over: msg.loadOver })[load];
const LOAD_BG = { off: colors.surface, free: colors.bg, ok: '#e6f0fa', full: '#fff3d6', over: '#fdecea' } as const;

export function workloadCellLabel(m: Pick<WorkloadMember, 'displayName'>, d: WorkloadDay): string {
  const load = workloadLoad(d);
  const parts = [`${m.displayName}, ${longDay(d.date)}`, msg.loadPlanned(hours(d.plannedSec)), msg.loadCapacity(hours(d.capacitySec))];
  if (d.actualSec !== null) parts.push(msg.loadActual(hours(d.actualSec)));
  parts.push(loadText(load));
  if (d.tasks.length) parts.push(msg.taskCount(d.tasks.length));
  return parts.join(', ');
}

/**
 * Person × day workload table (role=table with row/column headers). Each cell is a button with
 * the full spoken value and opens that day's tasks; load is shown as text, not only colour.
 */
export function WorkloadScreen({ accountId, onOpenTask, boardIds }: { accountId: AccountId; onOpenTask?: (cardId: number) => void; boardIds?: number[] }) {
  const { backend } = useServices();
  const [span, setSpan] = useState<7 | 14>(7);
  const [from, setFrom] = useState(() => workloadWeek(today()).from);
  const to = addDays(from, span - 1);
  const boards = boardIds?.join(',') ?? '';
  const s = useAsync(() => backend.workload(accountId, { from, to, ...(boardIds?.length ? { boardIds } : {}) }), [accountId, from, to, boards]);
  const [cell, setCell] = useState<{ uid: string; date: string } | null>(null);
  const m: WorkloadMatrix | undefined = s.data;
  const weekStart = m?.weekStart ?? 1;

  const shift = (n: number) => {
    setCell(null);
    setFrom((f) => addDays(f, n * span));
  };
  const selMember = cell && m ? m.members.find((x) => x.uid === cell.uid) : undefined;
  const selDay = selMember?.days.find((d) => d.date === cell!.date);
  const cellW = 76;
  const headW = 132;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.surface }} contentContainerStyle={{ paddingBottom: space(6) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space(2), padding: space(3) }}>
        <Button title="‹" kind="secondary" accessibilityLabel={msg.workloadPrevPeriod} onPress={() => shift(-1)} />
        <Text accessibilityRole="header" style={{ fontWeight: '700', color: colors.text }}>
          {shortDay(from)} – {shortDay(to)}
        </Text>
        <Button title="›" kind="secondary" accessibilityLabel={msg.workloadNextPeriod} onPress={() => shift(1)} />
        <Button title={msg.thisWeek} kind="secondary" onPress={() => { setCell(null); setFrom(workloadWeek(today(), weekStart).from); }} />
        <Chip label={msg.oneWeek} selected={span === 7} onPress={() => setSpan(7)} />
        <Chip label={msg.twoWeeks} selected={span === 14} onPress={() => setSpan(14)} />
      </View>
      <ErrorBanner error={s.error} onRetry={s.reload} />
      {s.loading && !m ? <Loading /> : null}
      {m ? (
        <>
          <Text style={{ paddingHorizontal: space(3), color: colors.muted }}>
            {msg.workloadSummary(
              hours(m.summary.capacitySec),
              hours(m.summary.plannedSec),
              m.summary.utilizationBp !== null ? Math.round(m.summary.utilizationBp / 100) : null,
              m.summary.actualSec !== null ? hours(m.summary.actualSec) : null,
              m.summary.overallocatedMembers,
            )}
          </Text>
          <Text style={{ paddingHorizontal: space(3), paddingBottom: space(2), color: colors.muted, fontSize: font.small }}>
            {msg.workloadNote(m.zone)}
          </Text>
          {m.truncated ? <Text style={{ paddingHorizontal: space(3), color: colors.danger }}>{msg.workloadTruncated}</Text> : null}
          {m.members.length === 0 ? (
            <Empty text={msg.workloadNoMembers} />
          ) : (
            <ScrollView horizontal>
              <View role="table" aria-label={msg.workloadTableLabel(shortDay(m.from), shortDay(m.to))} style={{ backgroundColor: colors.bg, borderTopWidth: 1, borderColor: colors.border }}>
                <View role="row" style={{ flexDirection: 'row', borderBottomWidth: 2, borderColor: colors.border }}>
                  <Text role="columnheader" style={{ width: headW, padding: space(2), fontWeight: '700', color: colors.text }}>{msg.person}</Text>
                  {m.days.map((d) => (
                    <Text key={d.date} role="columnheader" aria-label={longDay(d.date)} style={{ width: cellW, padding: space(2), fontWeight: '700', textAlign: 'center', color: d.workday ? colors.text : colors.muted, backgroundColor: d.date === m.today ? '#e6f0fa' : undefined }}>
                      {msg.weekdayShort(weekdayOf(d.date))}
                      {'\n'}
                      {shortDay(d.date)}
                    </Text>
                  ))}
                  <Text role="columnheader" style={{ width: cellW + 24, padding: space(2), fontWeight: '700', textAlign: 'right', color: colors.text }}>{msg.total}</Text>
                </View>
                {m.members.map((mem) => (
                  <View key={mem.uid} role="row" style={{ flexDirection: 'row', borderBottomWidth: 1, borderColor: colors.border }}>
                    <View role="rowheader" style={{ width: headW, padding: space(2) }}>
                      <Text numberOfLines={1} style={{ fontWeight: '600', color: colors.text }}>{mem.displayName}</Text>
                      <Text style={{ fontSize: font.small, color: mem.overdue.length ? colors.danger : colors.muted }}>
                        {msg.workloadMemberStats(mem.taskCount, mem.overdue.length, mem.unscheduled.length, mem.storyPoints ?? null, mem.missingPoints?.length ?? 0)}
                      </Text>
                    </View>
                    {mem.days.map((d) => {
                      const load = workloadLoad(d);
                      const selected = cell?.uid === mem.uid && cell.date === d.date;
                      return (
                        <View key={d.date} role="cell" style={{ width: cellW, borderLeftWidth: 1, borderColor: colors.border }}>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={workloadCellLabel(mem, d)}
                          accessibilityState={{ selected }}
                          onPress={() => setCell(selected ? null : { uid: mem.uid, date: d.date })}
                          style={{ flex: 1, padding: space(2), alignItems: 'center', justifyContent: 'center', backgroundColor: LOAD_BG[load], borderWidth: 2, borderColor: selected ? colors.primary : 'transparent' }}
                        >
                          <Text style={{ color: load === 'over' ? colors.danger : colors.text, fontWeight: load === 'over' ? '700' : '400' }}>
                            {load === 'off' ? '—' : `${hours(d.plannedSec)}/${hours(d.capacitySec)}`}
                          </Text>
                          {load === 'over' ? <Text style={{ fontSize: 11, color: colors.danger }}>{msg.loadOverShort}</Text> : null}
                          {d.actualSec ? <Text style={{ fontSize: 11, color: colors.muted }}>⏱ {hours(d.actualSec)}</Text> : null}
                        </Pressable>
                        </View>
                      );
                    })}
                    <View role="cell" style={{ width: cellW + 24, padding: space(2), alignItems: 'flex-end' }} aria-label={msg.workloadTotalLabel(mem.displayName, hours(mem.plannedSec), hours(mem.capacitySec), mem.actualSec !== null ? hours(mem.actualSec) : null)}>
                      <Text style={{ fontWeight: '700', color: mem.plannedSec > mem.capacitySec ? colors.danger : colors.text }}>{hours(mem.plannedSec)}/{hours(mem.capacitySec)}</Text>
                      {mem.actualSec !== null ? <Text style={{ fontSize: 11, color: colors.muted }}>⏱ {hours(mem.actualSec)}</Text> : null}
                    </View>
                  </View>
                ))}
              </View>
            </ScrollView>
          )}
          {selMember && selDay ? (
            <View style={[card, { margin: space(3) }]} accessibilityLiveRegion="polite">
              <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(2), color: colors.text }}>
                {selMember.displayName} · {longDay(selDay.date)}
              </Text>
              <Text style={{ color: colors.muted, marginBottom: space(2) }}>{workloadCellLabel(selMember, selDay)}</Text>
              {selDay.tasks.length === 0 ? <Text style={{ color: colors.muted }}>{msg.workloadNoTasksDay}</Text> : null}
              {selDay.tasks.map((x) => {
                const info = m.tasks[String(x.cardId)];
                const title = info?.title ?? `#${x.cardId}`;
                return (
                  <Pressable key={x.cardId} accessibilityRole="button" accessibilityLabel={msg.workloadTaskLabel(title, info?.boardTitle ?? '', hours(x.plannedSec))} disabled={!onOpenTask} onPress={() => onOpenTask?.(x.cardId)} style={{ paddingVertical: space(2), borderTopWidth: 1, borderColor: colors.border }}>
                    <Text style={{ color: onOpenTask ? colors.primary : colors.text, fontWeight: '600' }}>{title}</Text>
                    <Text style={{ color: colors.muted, fontSize: font.small }}>
                      {msg.workloadTaskLine(info?.boardTitle ?? '', hours(x.plannedSec), info?.estimateSec == null ? null : hours(info.estimateSec), info?.storyPoints ?? null)}
                    </Text>
                  </Pressable>
                );
              })}
              {selMember.overdue.length ? <Text style={{ marginTop: space(2), color: colors.danger }}>{msg.workloadOverdueList(selMember.overdue.map((id) => m.tasks[String(id)]?.title ?? `#${id}`).join(', '))}</Text> : null}
              {selMember.unscheduled.length ? <Text style={{ marginTop: space(1), color: colors.muted }}>{msg.workloadUnscheduledList(selMember.unscheduled.map((id) => m.tasks[String(id)]?.title ?? `#${id}`).join(', '))}</Text> : null}
            </View>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}
