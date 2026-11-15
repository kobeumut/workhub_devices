import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import {
  OcsError, buildTimeEntry, entryEditable, periodActions, timeEntryFormOf, utcToZoned,
  type AccountId, type CsvScope, type ReviewAction, type ReviewItem, type TimeEntry, type TimeEntryForm, type TimeFormError, type TimeWeek,
} from '@workhub-devices/core';
import { useAsync, useServices } from './services';
import { Button, Field, Loading, card, styles as ui } from './ui';
import { TaskPicker, type PickedTask } from './taskPicker';
import { Chip } from './taskEdit';
import { colors, font, space } from './theme';
import { describeError, formatDate, intlTag, messages, t } from './i18n';

const m = messages.time;

/** Hex UUID v4 (Idempotency-Key must pass the IPC key check even without crypto.randomUUID). */
const uuid = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const h = () => Math.floor(Math.random() * 16).toString(16);
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, h);
};
export const hm = (sec: number) => m.duration(Math.floor(sec / 3600), Math.floor((sec % 3600) / 60));
/** Compact `h:mm` for table cells; the spoken label stays the long form. */
const hmShort = (sec: number) => `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// Label tables read the catalog lazily (getters) so they follow the active language.
export const PERIOD_STATE: Record<string, string> = {
  get draft() { return m.stateDraft; },
  get submitted() { return m.stateSubmitted; },
  get changes_requested() { return m.stateChangesRequested; },
  get approved() { return m.stateApproved; },
  get reopened() { return m.stateReopened; },
};
const SUBMISSION_STATUS: Record<string, string> = {
  get pending() { return m.submissionPending; },
  get approved() { return m.submissionApproved; },
  get changes_requested() { return m.submissionChangesRequested; },
  get withdrawn() { return m.submissionWithdrawn; },
  get superseded() { return m.submissionSuperseded; },
};
const REVIEW_ACTION: Record<string, string> = {
  get submit() { return m.verbSubmit; },
  get withdraw() { return m.verbWithdraw; },
  get approve() { return m.verbApprove; },
  get request_changes() { return m.verbRequestChanges; },
  get reopen() { return m.verbReopen; },
};
const FORM_ERROR: Record<TimeFormError, string> = {
  get date_invalid() { return m.formDateInvalid; },
  get time_invalid() { return m.formTimeInvalid; },
  get duration_invalid() { return m.formDurationInvalid; },
  get too_long() { return m.formTooLong; },
  get task_required() { return m.formTaskRequired; },
  get description_required() { return m.formDescriptionRequired; },
  get description_too_long() { return m.formDescriptionTooLong; },
};

function timeError(e: unknown): string {
  if (e instanceof OcsError) {
    switch (e.errorCode) {
      case 'PERIOD_LOCKED':
        return m.errPeriodLocked;
      case 'TIME_OVERLAP':
        return m.errTimeOverlap;
      case 'TIMER_RUNNING':
        return m.errTimerRunning;
      case 'VERSION_CONFLICT':
      case 'INVALID_STATE':
        return m.errVersionConflict;
      case 'KIND_IMMUTABLE':
        return m.errKindImmutable;
      case 'SELF_APPROVAL':
        return m.errSelfApproval;
      case 'TEAM_REPORT_FORBIDDEN':
        return m.errTeamReportForbidden;
      case 'REASON_REQUIRED':
      case 'FIELD_REQUIRED':
        return m.errReasonRequired;
      case 'TIME_DISABLED':
        return m.errTimeDisabled;
    }
    if (e.kind === 'client' && e.ocsMessage) return e.ocsMessage;
  }
  return describeError(e);
}

function TimeError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <View accessibilityRole="alert" style={ui.error}>
      <Text style={{ color: colors.danger, flex: 1 }}>{timeError(error)}</Text>
      {onRetry ? (
        <Pressable accessibilityRole="button" onPress={onRetry}>
          <Text style={{ color: colors.primary, fontWeight: '600' }}>{t.retry}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Tabs<T extends string>({ value, items, onChange }: { value: T; items: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: 'row', gap: space(2), marginBottom: space(3), flexWrap: 'wrap' }}>
      {items.map(([k, label]) => (
        <Pressable key={k} accessibilityRole="tab" accessibilityState={{ selected: value === k }} onPress={() => onChange(k)} style={{ paddingVertical: space(1), paddingHorizontal: space(3), borderRadius: 16, backgroundColor: value === k ? colors.primary : colors.surface, minHeight: 32, justifyContent: 'center' }}>
          <Text style={{ color: value === k ? colors.primaryText : colors.text }}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

type Tab = 'week' | 'review' | 'team';

/**
 * Native Time module: timer, week with entry CRUD, period submit/withdraw, and — only for users
 * whose Workhub bootstrap grants `canViewTeamReport` (direct manager) — the review queue and the
 * team report. CSV export is offered only when the shell can save/share files.
 */
export function TimeScreen({ accountId, canReview, projectsEnabled = false }: { accountId: AccountId; canReview: boolean; projectsEnabled?: boolean }) {
  const [tab, setTab] = useState<Tab>('week');
  const tabs: Array<[Tab, string]> = [['week', m.tabMyWeek], ...(canReview ? ([['review', m.tabReview], ['team', m.tabTeamReport]] as Array<[Tab, string]>) : [])];
  return (
    <ScrollView contentContainerStyle={{ padding: space(3) }} keyboardShouldPersistTaps="handled">
      {tabs.length > 1 ? <Tabs value={tab} items={tabs} onChange={setTab} /> : null}
      {tab === 'week' ? <WeekView accountId={accountId} projectsEnabled={projectsEnabled} /> : null}
      {tab === 'review' && canReview ? <ReviewQueue accountId={accountId} /> : null}
      {tab === 'team' && canReview ? <TeamReportView accountId={accountId} /> : null}
    </ScrollView>
  );
}

function TimerCard({ accountId, week, onChanged }: { accountId: AccountId; week: TimeWeek | undefined; onChanged: () => void }) {
  const { backend } = useServices();
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  const timer = week?.timer ?? null;
  const elapsed = timer ? Math.max(0, Math.floor((now - Date.parse(timer.startedAt)) / 1000)) : 0;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(undefined);
    try {
      await fn();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  return (
    <View style={card}>
      <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(2) }}>
        {m.timer}
      </Text>
      <TimeError error={err} />
      {timer ? (
        <>
          <Text style={{ fontSize: font.title, color: colors.text }}>⏱ {hm(elapsed)}</Text>
          <Text style={{ color: colors.muted }}>{timer.card?.title ?? timer.description ?? ''}</Text>
          <Button title={m.stop} kind="danger" busy={busy} onPress={() => void act(() => backend.timerStop(accountId))} />
        </>
      ) : (
        <>
          <TextInput accessibilityLabel={m.timerDescriptionLabel} placeholder={m.timerPlaceholder} placeholderTextColor={colors.muted} value={desc} onChangeText={setDesc} style={ui.input} />
          <Button title={m.start} busy={busy} onPress={() => void act(async () => { await backend.timerStart(accountId, null, desc.trim(), uuid()); setDesc(''); })} />
        </>
      )}
    </View>
  );
}

function WeekView({ accountId, projectsEnabled }: { accountId: AccountId; projectsEnabled: boolean }) {
  const { backend, platform } = useServices();
  const [date, setDate] = useState<string | undefined>();
  const week = useAsync(() => backend.timeWeek(accountId, date), [accountId, date]);
  const [editing, setEditing] = useState<TimeEntry | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>();
  const [note, setNote] = useState<string>();
  const w = week.data;

  const act = async (id: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(id);
    setErr(undefined);
    setNote(undefined);
    try {
      await fn();
      if (done) setNote(done);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
      week.reload();
    }
  };

  if (week.loading && !w) return <Loading />;
  const actions = w ? periodActions(w) : null;
  const zone = w?.period.zone ?? 'UTC';
  return (
    <>
      <TimeError error={week.error} onRetry={week.reload} />
      <TimerCard accountId={accountId} week={w} onChanged={week.reload} />
      {w && actions ? (
        <View style={card}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), flexWrap: 'wrap' }}>
            <Button title="‹" accessibilityLabel={m.previousWeek} kind="secondary" onPress={() => setDate(w.navigation.prevDate)} />
            <Text accessibilityRole="header" style={{ fontWeight: '700', color: colors.text, flex: 1 }}>
              {formatDate(w.period.localStartDate)} – {formatDate(w.period.localEndDate)}
            </Text>
            {date && date !== w.navigation.today ? <Button title={m.today} kind="secondary" onPress={() => setDate(undefined)} /> : null}
            <Button title="›" accessibilityLabel={m.nextWeek} kind="secondary" onPress={() => setDate(w.navigation.nextDate)} />
          </View>
          <Text accessibilityLabel={m.periodStatusLabel(PERIOD_STATE[w.period.state] ?? w.period.state)} style={{ color: w.period.open ? colors.muted : colors.danger, marginTop: space(1) }}>
            {m.periodSummary(PERIOD_STATE[w.period.state] ?? w.period.state, w.period.open, hm(w.totals.totalSec), hm(w.totals.billableSec))}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginTop: space(2) }}>
            {w.days.map((d) => (
              <Text key={d.date} style={{ color: d.totalSec ? colors.text : colors.muted, fontSize: font.small }}>
                {new Date(`${d.date}T12:00:00Z`).toLocaleDateString(intlTag(), { weekday: 'short', day: '2-digit' })}: {hm(d.totalSec)}
              </Text>
            ))}
          </View>
        </View>
      ) : null}
      {w ? (
        <View style={card}>
          <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(2) }}>
            {m.entries}
          </Text>
          {w.entries.length === 0 ? <Text style={{ color: colors.muted }}>{m.noEntriesThisWeek}</Text> : null}
          {w.entries.map((e) =>
            editing !== 'new' && editing?.id === e.id ? (
              <EntryForm key={e.id} accountId={accountId} projectsEnabled={projectsEnabled} week={w} entry={e} onDone={() => { setEditing(null); week.reload(); }} />
            ) : (
              <EntryRow key={e.id} entry={e} zone={zone} editable={entryEditable(w, e)} busy={busy === `del:${e.id}`}
                onEdit={() => setEditing(e)}
                onDelete={() => void act(`del:${e.id}`, () => backend.timeEntryDelete(accountId, e.id, e.version), m.entryDeleted)} />
            ),
          )}
          {editing === 'new' ? <EntryForm accountId={accountId} projectsEnabled={projectsEnabled} week={w} entry={null} onDone={() => { setEditing(null); week.reload(); }} /> : null}
          {actions?.canEdit && editing === null ? <Button title={m.addEntry} kind="secondary" onPress={() => setEditing('new')} /> : null}
        </View>
      ) : null}
      {w && actions ? (
        <View style={card}>
          <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(2) }}>
            {m.periodApproval}
          </Text>
          <TimeError error={err} />
          {note ? <Text accessibilityRole="alert" style={{ color: colors.ok }}>{note}</Text> : null}
          {actions.canSubmit ? (
            <>
              {!w.reviewerConfigured ? <Text style={{ color: colors.muted }}>{m.noManagerForSubmit}</Text> : null}
              <Button title={m.submitPeriod} busy={busy === 'submit'} disabled={!!busy} onPress={() => void act('submit', () => backend.timeSubmit(accountId, w.period.id, w.period.version, uuid()), m.periodSubmittedDone)} />
            </>
          ) : null}
          {actions.withdrawable ? (
            <Button title={m.withdrawSubmission} kind="secondary" busy={busy === 'withdraw'} disabled={!!busy} onPress={() => void act('withdraw', () => backend.timeWithdraw(accountId, actions.withdrawable!.id, w.period.version, uuid()), m.submissionWithdrawnDone)} />
          ) : null}
          {w.submissions.length ? (
            <View style={{ marginTop: space(2) }}>
              {w.submissions.slice(-3).reverse().map((s) => (
                <View key={s.id} style={{ paddingVertical: space(1) }}>
                  <Text style={{ color: colors.text }}>
                    #{s.revision} · {SUBMISSION_STATUS[s.status] ?? s.status} · {hm(s.totalSec)}
                  </Text>
                  {s.reviews.filter((r) => r.reason).map((r, i) => (
                    <Text key={i} style={{ color: colors.muted, fontSize: font.small }}>
                      {m.reviewNote(r.actorUid, REVIEW_ACTION[r.action] ?? r.action, r.reason ?? '')}
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      {w && platform.saveFile ? <CsvExport accountId={accountId} scope="own" defaultFrom={w.period.localStartDate} defaultTo={w.period.localEndDate} /> : null}
    </>
  );
}

function EntryRow({ entry: e, zone, editable, busy, onEdit, onDelete }: { entry: TimeEntry; zone: string; editable: boolean; busy: boolean; onEdit: () => void; onDelete: () => void }) {
  const when = e.kind === 'range' && e.startUtc && e.endUtc ? `${utcToZoned(e.startUtc, zone).time}–${utcToZoned(e.endUtc, zone).time}` : m.entryKindDuration;
  const title = e.card?.title ?? (e.description || '—');
  return (
    <View style={{ paddingVertical: space(2), borderBottomWidth: 1, borderColor: colors.border }}>
      <Text style={{ color: colors.text }}>
        {m.entryLine(formatDate(e.localDate), when, hm(e.durationSec), e.billable, editable)}
      </Text>
      <Text style={{ color: colors.muted }}>{title}</Text>
      {editable ? (
        <View style={{ flexDirection: 'row', gap: space(2) }}>
          <Button title={t.edit} accessibilityLabel={m.editEntryLabel(title)} kind="secondary" onPress={onEdit} />
          <Button title={m.deleteButton} accessibilityLabel={m.deleteEntryLabel(title)} kind="danger" busy={busy} onPress={onDelete} />
        </View>
      ) : null}
    </View>
  );
}

function EntryForm({ accountId, projectsEnabled, week, entry, onDone }: { accountId: AccountId; projectsEnabled: boolean; week: TimeWeek; entry: TimeEntry | null; onDone: () => void }) {
  const { backend } = useServices();
  const zone = week.period.zone;
  const today = week.navigation.today >= week.period.localStartDate && week.navigation.today <= week.period.localEndDate ? week.navigation.today : week.period.localStartDate;
  const [form, setForm] = useState<TimeEntryForm>(() => timeEntryFormOf(entry, zone, today));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [warn, setWarn] = useState<string>();
  const set = (p: Partial<TimeEntryForm>) => setForm((f) => ({ ...f, ...p }));
  // Linked task: undefined = unchanged; [] = none; [task] = link (server re-checks card access).
  const initialTask: PickedTask[] = entry?.card ? [{ id: entry.card.id, boardId: entry.card.boardId ?? 0, title: entry.card.title }] : [];
  const [task, setTask] = useState<PickedTask[] | undefined>(undefined);
  const [picking, setPicking] = useState(false);
  const shownTask = task ?? initialTask;
  const save = async () => {
    const cardId = task === undefined ? undefined : (task[0]?.id ?? null);
    const r = buildTimeEntry(form, zone, { maxEntrySeconds: week.policy.maxEntrySeconds, allowTaskless: week.policy.allowTaskless, ...(cardId !== undefined ? { cardId } : {}) }, entry ?? undefined);
    if ('error' in r) return setErr(FORM_ERROR[r.error]);
    setErr(undefined);
    if ('patch' in r && Object.keys(r.patch).length === 1) return onDone();
    setBusy(true);
    try {
      const res = 'create' in r ? await backend.timeEntryCreate(accountId, r.create, uuid()) : await backend.timeEntryUpdate(accountId, entry!.id, r.patch);
      const overlap = res?.warnings.find((x) => x.code === 'TIME_OVERLAP');
      if (overlap) {
        setWarn(m.savedWithOverlap);
        setTimeout(onDone, 1500);
      } else onDone();
    } catch (e) {
      setErr(timeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View accessibilityLabel={entry ? m.editEntry : m.newEntry} style={{ paddingVertical: space(2), borderTopWidth: 1, borderColor: colors.border }}>
      <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(2) }}>
        {entry ? m.editEntry : m.newEntry}
      </Text>
      {!entry ? (
        <View style={{ flexDirection: 'row', gap: space(2), marginBottom: space(2) }}>
          <Chip label={m.timeRange} selected={form.kind === 'range'} onPress={() => set({ kind: 'range' })} />
          <Chip label={m.durationKind} selected={form.kind === 'duration'} onPress={() => set({ kind: 'duration' })} />
        </View>
      ) : null}
      <Field label={m.dateField} value={form.date} onChangeText={(v) => set({ date: v.trim() })} autoCapitalize="none" />
      {form.kind === 'range' ? (
        <View style={{ flexDirection: 'row', gap: space(2) }}>
          <View style={{ flex: 1 }}>
            <Field label={m.startField} value={form.start} onChangeText={(v) => set({ start: v.trim() })} />
          </View>
          <View style={{ flex: 1 }}>
            <Field label={m.endField} value={form.end} onChangeText={(v) => set({ end: v.trim() })} />
          </View>
        </View>
      ) : (
        <Field label={m.durationHoursField} value={form.hours} onChangeText={(v) => set({ hours: v })} placeholder={m.durationPlaceholder} />
      )}
      <Field label={m.description} value={form.description} onChangeText={(v) => set({ description: v })} multiline />
      <View accessibilityLabel={m.linkedTask} style={{ marginBottom: space(2) }}>
        <Text style={ui.label}>{m.task}</Text>
        <Text>{shownTask[0] ? (entry?.card?.restricted && task === undefined ? m.restrictedTask : shownTask[0].title) : m.noTaskLinked}</Text>
        {projectsEnabled ? (
          <View style={{ flexDirection: 'row', gap: space(2), marginTop: space(1) }}>
            <Button title={picking ? m.closePicker : shownTask[0] ? m.changeTask : m.linkTask} kind="secondary" onPress={() => setPicking(!picking)} />
            {shownTask[0] ? <Button title={m.unlinkTask} kind="secondary" onPress={() => { setTask([]); setPicking(false); }} /> : null}
          </View>
        ) : null}
        {picking ? <TaskPicker accountId={accountId} selected={shownTask} onChange={(picked) => { setTask(picked); if (picked.length) setPicking(false); }} /> : null}
      </View>
      <View style={{ flexDirection: 'row', marginBottom: space(2) }}>
        <Chip label={m.billable} selected={form.billable} onPress={() => set({ billable: !form.billable })} />
      </View>
      <Text style={{ color: colors.muted, fontSize: font.small }}>{m.timeZone(zone)}</Text>
      {err ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{err}</Text> : null}
      {warn ? <Text accessibilityRole="alert" style={{ color: colors.text }}>{warn}</Text> : null}
      <View style={{ flexDirection: 'row', gap: space(2) }}>
        <Button title={t.save} accessibilityLabel={entry ? m.saveEntryLabel : m.addEntryLabel} busy={busy} onPress={() => void save()} />
        <Button title={t.cancel} kind="secondary" onPress={onDone} />
      </View>
    </View>
  );
}

function ReviewQueue({ accountId }: { accountId: AccountId }) {
  const { backend } = useServices();
  const [status, setStatus] = useState<'pending' | 'approved'>('pending');
  const list = useAsync(() => backend.timeReviews(accountId, status), [accountId, status]);
  return (
    <>
      <Tabs value={status} items={[['pending', m.queuePending], ['approved', m.queueApproved]]} onChange={setStatus} />
      <TimeError error={list.error} onRetry={list.reload} />
      {list.loading && !list.data ? <Loading /> : null}
      {(list.data ?? []).length === 0 && !list.loading && !list.error ? <Text style={{ color: colors.muted }}>{status === 'pending' ? m.noPendingReviews : m.noApprovedPeriods}</Text> : null}
      {(list.data ?? []).map((item) => (
        <ReviewCard key={item.submission.id} accountId={accountId} item={item} onChanged={list.reload} />
      ))}
    </>
  );
}

function ReviewCard({ accountId, item, onChanged }: { accountId: AccountId; item: ReviewItem; onChanged: () => void }) {
  const { backend } = useServices();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<ReviewAction | null>(null);
  const [err, setErr] = useState<string>();
  const who = item.user.displayName;
  const decide = async (action: ReviewAction) => {
    if (action !== 'approve' && !reason.trim()) return setErr(m.errReasonRequired);
    setBusy(action);
    setErr(undefined);
    try {
      await backend.timeDecide(accountId, item.submission.id, action, item.period.version, action === 'approve' ? null : reason.trim(), uuid());
      onChanged();
    } catch (e) {
      setErr(timeError(e));
      if (e instanceof OcsError && e.kind === 'conflict') onChanged();
    } finally {
      setBusy(null);
    }
  };
  const pending = item.submission.status === 'pending';
  return (
    <View style={card} accessibilityLabel={`${who}, ${formatDate(item.period.localStartDate)} – ${formatDate(item.period.localEndDate)}, ${hm(item.submission.totalSec)}`}>
      <Text style={{ fontWeight: '700', color: colors.text }}>{who}</Text>
      <Text style={{ color: colors.muted }}>
        {formatDate(item.period.localStartDate)} – {formatDate(item.period.localEndDate)} · #{item.submission.revision} · {SUBMISSION_STATUS[item.submission.status] ?? item.submission.status}
      </Text>
      <Text style={{ color: colors.text, marginVertical: space(1) }}>
        {m.reviewTotals(hm(item.submission.totalSec), hm(item.submission.billableSec), item.entries.length)}
      </Text>
      {item.entries.slice(0, 20).map((e) => (
        <Text key={e.entryId} style={{ color: colors.muted, fontSize: font.small }}>
          {formatDate(e.localDate)} · {hm(e.durationSec)} · {e.card?.title ?? (e.description || '—')}
        </Text>
      ))}
      {item.canReview ? (
        <>
          <TextInput accessibilityLabel={m.reasonLabel(who)} placeholder={pending ? m.reasonPlaceholderChanges : m.reasonPlaceholderReopen} placeholderTextColor={colors.muted} value={reason} onChangeText={setReason} multiline style={[ui.input, { marginTop: space(2), minHeight: 60, paddingTop: 10 }]} />
          {err ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{err}</Text> : null}
          <View style={{ flexDirection: 'row', gap: space(2), flexWrap: 'wrap' }}>
            {pending ? <Button title={m.approve} accessibilityLabel={m.approveLabel(who)} busy={busy === 'approve'} disabled={!!busy} onPress={() => void decide('approve')} /> : null}
            {pending ? <Button title={m.requestChanges} accessibilityLabel={m.requestChangesLabel(who)} kind="secondary" busy={busy === 'request_changes'} disabled={!!busy} onPress={() => void decide('request_changes')} /> : null}
            {!pending ? <Button title={m.reopen} accessibilityLabel={m.reopenLabel(who)} kind="danger" busy={busy === 'reopen'} disabled={!!busy} onPress={() => void decide('reopen')} /> : null}
          </View>
        </>
      ) : null}
    </View>
  );
}

const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));

/** Table cell: compact `h:mm` on screen, full duration for screen readers. */
function Num({ sec, bold }: { sec: number; bold?: boolean }) {
  return (
    <Text role="cell" accessibilityLabel={hm(sec)} style={{ flex: 1, paddingVertical: space(2), paddingHorizontal: space(1), textAlign: 'right', color: colors.text, fontWeight: bold ? '700' : '400' }}>
      {hmShort(sec)}
    </Text>
  );
}

function TeamReportView({ accountId }: { accountId: AccountId }) {
  const { backend, platform } = useServices();
  const today = new Date().toISOString().slice(0, 10);
  const [range, setRange] = useState({ from: addDays(today, -6), to: today });
  const [draft, setDraft] = useState(range);
  const [formErr, setFormErr] = useState<string>();
  const report = useAsync(() => backend.timeTeam(accountId, range.from, range.to), [accountId, range.from, range.to]);
  const apply = () => {
    if (!isDay(draft.from) || !isDay(draft.to)) return setFormErr(m.errDatesFormat);
    if (draft.from > draft.to) return setFormErr(m.errStartAfterEnd);
    if (addDays(draft.from, 92) < draft.to) return setFormErr(m.errRangeTooLong);
    setFormErr(undefined);
    setRange(draft);
  };
  const r = report.data;
  const cell = { flex: 1, paddingVertical: space(2), paddingHorizontal: space(1) } as const;
  return (
    <>
      <View style={card}>
        <View style={{ flexDirection: 'row', gap: space(2), alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <View style={{ flexGrow: 1, minWidth: 140 }}>
            <Field label={m.fromField} value={draft.from} onChangeText={(v) => setDraft((d) => ({ ...d, from: v.trim() }))} />
          </View>
          <View style={{ flexGrow: 1, minWidth: 140 }}>
            <Field label={m.toField} value={draft.to} onChangeText={(v) => setDraft((d) => ({ ...d, to: v.trim() }))} />
          </View>
          <Button title={m.show} onPress={apply} />
        </View>
        {formErr ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{formErr}</Text> : null}
      </View>
      <TimeError error={report.error} onRetry={report.reload} />
      {report.loading && !r ? <Loading /> : null}
      {r ? (
        <View style={card}>
          <View role="table" aria-label={m.teamReportLabel(`${formatDate(r.from)} – ${formatDate(r.to)}`)}>
            <View role="row" style={{ flexDirection: 'row', borderBottomWidth: 2, borderColor: colors.border }}>
              {[m.colPerson, m.colTotal, m.colBillable, m.colApproved, m.colPending].map((h, i) => (
                <Text key={h} role="columnheader" style={[cell, { fontWeight: '700', color: colors.text, textAlign: i ? 'right' : 'left' }]}>{h}</Text>
              ))}
            </View>
            {r.users.map((u) => (
              <View key={u.uid} role="row" style={{ flexDirection: 'row', borderBottomWidth: 1, borderColor: colors.border }}>
                <Text role="rowheader" style={[cell, { color: colors.text }]}>{u.displayName}</Text>
                <Num sec={u.totalSec} />
                <Num sec={u.billableSec} />
                <Num sec={u.byState.approved ?? 0} />
                <Num sec={u.byState.submitted ?? 0} />
              </View>
            ))}
            <View role="row" style={{ flexDirection: 'row' }}>
              <Text role="rowheader" style={[cell, { fontWeight: '700', color: colors.text }]}>{m.colTotal}</Text>
              <Num sec={r.totals.totalSec} bold />
              <Num sec={r.totals.billableSec} bold />
              <Text role="cell" style={cell} />
              <Text role="cell" style={cell} />
            </View>
          </View>
          {r.users.length === 0 ? <Text style={{ color: colors.muted }}>{m.noUsersInReport}</Text> : null}
        </View>
      ) : null}
      {platform.saveFile ? <CsvExport accountId={accountId} scope="team" defaultFrom={range.from} defaultTo={range.to} /> : null}
    </>
  );
}

/** CSV export: text comes from Backend (credentials stay in main/native); the shell saves or shares it. */
function CsvExport({ accountId, scope, defaultFrom, defaultTo }: { accountId: AccountId; scope: CsvScope; defaultFrom: string; defaultTo: string }) {
  const { backend, platform } = useServices();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const label = scope === 'team' ? m.csvDownloadTeam : m.csvDownload;
  const run = async () => {
    setBusy(true);
    setMsg(undefined);
    try {
      const { filename, csv } = await backend.timeCsv(accountId, scope, defaultFrom, defaultTo);
      const r = await platform.saveFile!(filename, csv, 'text/csv');
      setMsg(r === 'saved' ? { ok: true, text: platform.kind === 'desktop' ? m.savedFile(filename) : m.shareSheetOpened } : { ok: false, text: t.errAborted });
    } catch (e) {
      setMsg({ ok: false, text: timeError(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={card}>
      <Text style={{ color: colors.muted, fontSize: font.small }}>
        {formatDate(defaultFrom)} – {formatDate(defaultTo)} · {platform.kind === 'desktop' ? m.csvHintDesktop : m.csvHintMobile}
      </Text>
      <Button title={label} kind="secondary" busy={busy} onPress={() => void run()} />
      {msg ? <Text accessibilityRole="alert" style={{ color: msg.ok ? colors.ok : colors.danger }}>{msg.text}</Text> : null}
    </View>
  );
}
