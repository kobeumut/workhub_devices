import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import {
  OcsError, buildTimeEntry, editableCardEntry, entryEditable, periodActions, timeEntryFormOf, utcToZoned,
  type AccountId, type CsvScope, type ReviewAction, type ReviewItem, type TimeEntry, type TimeEntryForm, type TimeFormError, type TimeWeek, type TaskDetail,
} from '@workhub-devices/core';
import { useAsync, useServices } from './services';
import { Button, Field, Loading, Pill, card, styles as ui } from './ui';
import { TaskPicker, type PickedTask } from './taskPicker';
import { Chip } from './taskEdit';
import { colors, font, radius, space } from './theme';
import { describeError, formatDate, formatDuration, formatTaskDate, t } from './i18n';

/** Hex UUID v4 (Idempotency-Key must pass the IPC key check even without crypto.randomUUID). */
const uuid = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const h = () => Math.floor(Math.random() * 16).toString(16);
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, h);
};
export const hm = formatDuration;
/** Compact `s:dd` for table cells; the spoken label stays the long form. */
const hmShort = (sec: number) => `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export const PERIOD_STATE: Record<string, string> = {
  draft: 'Taslak',
  submitted: 'Onaya gönderildi',
  changes_requested: 'Değişiklik istendi',
  approved: 'Onaylandı',
  reopened: 'Yeniden açıldı',
};
const SUBMISSION_STATUS: Record<string, string> = {
  pending: 'Onay bekliyor',
  approved: 'Onaylandı',
  changes_requested: 'Değişiklik istendi',
  withdrawn: 'Geri çekildi',
  superseded: 'Yeniden açıldı',
};
const REVIEW_ACTION: Record<string, string> = { submit: 'gönderdi', withdraw: 'geri çekti', approve: 'onayladı', request_changes: 'değişiklik istedi', reopen: 'yeniden açtı' };
const FORM_ERROR: Record<TimeFormError, string> = {
  date_invalid: 'Tarihi YYYY-AA-GG biçiminde girin (ör. 2026-11-02).',
  time_invalid: 'Saatleri SS:DD biçiminde girin (ör. 09:30).',
  duration_invalid: 'Süreyi saat olarak girin (ör. 1,5 veya 1:30).',
  too_long: 'Bir kayıt en fazla politika sınırı kadar olabilir.',
  task_required: 'Zaman politikası görevsiz kayda izin vermiyor; bir görev bağlayın.',
  description_required: 'Görev bağlı olmayan kayıt için açıklama gerekli.',
  description_too_long: 'Açıklama en fazla 1000 karakter olabilir.',
};

function timeError(e: unknown): string {
  if (e instanceof OcsError) {
    switch (e.errorCode) {
      case 'PERIOD_LOCKED':
        return 'Bu dönem kilitli (onaya gönderilmiş veya onaylanmış); kayıtlar değiştirilemez.';
      case 'TIME_OVERLAP':
        return 'Bu aralık başka bir kayıt veya çalışan zamanlayıcı ile çakışıyor.';
      case 'TIMER_RUNNING':
        return 'Bu dönemle çakışan bir zamanlayıcı çalışıyor; önce durdurun.';
      case 'VERSION_CONFLICT':
      case 'INVALID_STATE':
        return 'Kayıt bu arada değişti; liste yenilendi, tekrar deneyin.';
      case 'KIND_IMMUTABLE':
        return 'Kayıt türü değiştirilemez; silip yeniden ekleyin.';
      case 'SELF_APPROVAL':
        return 'Kendi çizelgenizi onaylayamaz veya geri gönderemezsiniz.';
      case 'TEAM_REPORT_FORBIDDEN':
        return 'Takım raporu ve inceleme yalnız yöneticiler içindir.';
      case 'REASON_REQUIRED':
      case 'FIELD_REQUIRED':
        return 'Gerekçe yazın.';
      case 'TIME_DISABLED':
        return 'Zaman modülü sizin için kapalı.';
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
          <Text style={{ color: colors.primary, fontWeight: '600' }}>Tekrar dene</Text>
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
 * whose Workhub bootstrap grants `canViewTeamReport` (direct managers and reviewers) — the review queue and the
 * team report. CSV export is offered only when the shell can save/share files.
 */
export function TimeScreen({ accountId, canReview, projectsEnabled = false, startInReview = false, onChanged }: { accountId: AccountId; canReview: boolean; projectsEnabled?: boolean; startInReview?: boolean; onChanged?: () => void }) {
  const [tab, setTab] = useState<Tab>(canReview && startInReview ? 'review' : 'week');
  const tabs: Array<[Tab, string]> = [['week', 'Haftam'], ...(canReview ? ([['review', 'İnceleme'], ['team', 'Takım raporu']] as Array<[Tab, string]>) : [])];
  return (
    <ScrollView contentContainerStyle={{ padding: space(3) }} keyboardShouldPersistTaps="handled">
      {tabs.length > 1 ? <Tabs value={tab} items={tabs} onChange={setTab} /> : null}
      {tab === 'week' ? <WeekView accountId={accountId} projectsEnabled={projectsEnabled} /> : null}
      {tab === 'review' && canReview ? <ReviewQueue accountId={accountId} {...(onChanged ? { onChanged } : {})} /> : null}
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
        Zamanlayıcı
      </Text>
      <TimeError error={err} />
      {timer ? (
        <>
          <Text style={{ fontSize: font.title, color: colors.text }}>⏱ {hm(elapsed)}</Text>
          <Text style={{ color: colors.muted }}>{timer.card?.title ?? timer.description ?? ''}</Text>
          <Button title="Durdur" kind="danger" busy={busy} onPress={() => void act(() => backend.timerStop(accountId))} />
        </>
      ) : (
        <>
          <TextInput accessibilityLabel="Zamanlayıcı açıklaması" placeholder="Ne üzerinde çalışıyorsunuz?" placeholderTextColor={colors.muted} value={desc} onChangeText={setDesc} style={ui.input} />
          <Button title="Başlat" busy={busy} onPress={() => void act(async () => { await backend.timerStart(accountId, null, desc.trim(), uuid()); setDesc(''); })} />
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
      {w && actions ? (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(2), marginBottom: space(2) }}>
            <Text accessibilityRole="header" style={{ fontWeight: '700', color: colors.textStrong }}>
              {formatDate(w.period.localStartDate)} – {formatDate(w.period.localEndDate)}
            </Text>
            <Text style={{ color: colors.muted }}>· {zone} ·</Text>
            <View accessibilityLabel={`Dönem durumu: ${PERIOD_STATE[w.period.state] ?? w.period.state}`}>
              <Pill label={`${PERIOD_STATE[w.period.state] ?? w.period.state}${w.period.open ? '' : ' · kayıtlar salt okunur 🔒'}`} tone={w.period.state === 'approved' ? 'ok' : w.period.state === 'changes_requested' ? 'danger' : w.period.state === 'submitted' ? 'warning' : 'neutral'} />
            </View>
            <View style={{ flex: 1 }} />
            <Button title="‹ Önceki" accessibilityLabel="Önceki hafta" kind="secondary" onPress={() => setDate(w.navigation.prevDate)} />
            <Button title="Bugün" kind={date && date !== w.navigation.today ? 'primary' : 'secondary'} onPress={() => setDate(undefined)} />
            <Button title="Sonraki ›" accessibilityLabel="Sonraki hafta" kind="secondary" onPress={() => setDate(w.navigation.nextDate)} />
          </View>
          <View style={[card, { flexDirection: 'row', flexWrap: 'wrap', gap: space(6), borderLeftWidth: 4, borderLeftColor: colors.primary, backgroundColor: colors.surface }]}>
            {([['Bu hafta kaydedilen süre', hm(w.totals.totalSec)], ['Faturalanabilir', hm(w.totals.billableSec)], ['Kayıtlar', String(w.entries.length)]] as const).map(([label, value]) => (
              <View key={label} style={{ minWidth: 140, gap: 4 }}>
                <Text style={{ color: colors.muted, fontSize: font.small }}>{label}</Text>
                <Text style={{ color: colors.textStrong, fontSize: font.h1, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{value}</Text>
              </View>
            ))}
          </View>
        </>
      ) : null}
      <TimerCard accountId={accountId} week={w} onChanged={week.reload} />
      {w && actions ? (
        <View style={card}>
          <Text accessibilityRole="header" style={{ fontWeight: '700', color: colors.textStrong, fontSize: font.title }}>Günlük toplamlar</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginTop: space(2) }}>
            {w.days.map((d) => {
              const today = d.date === w.navigation.today;
              const day = new Date(`${d.date}T12:00:00Z`);
              return (
                <View key={d.date} accessibilityLabel={`${day.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}: ${hm(d.totalSec)}`} style={{ flexGrow: 1, flexBasis: 96, alignItems: 'center', gap: 2, paddingVertical: space(2), borderRadius: radius.sm, borderWidth: today ? 2 : 1, borderColor: today ? colors.primary : colors.border, backgroundColor: colors.bg }}>
                  <Text style={{ fontWeight: '700', color: colors.textStrong }}>{day.toLocaleDateString('tr-TR', { weekday: 'short', timeZone: 'UTC' })}</Text>
                  <Text style={{ color: colors.muted, fontSize: font.small }}>{day.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', timeZone: 'UTC' })}</Text>
                  <Text style={{ color: d.totalSec ? colors.textStrong : colors.muted, fontSize: font.title, fontVariant: ['tabular-nums'] }}>{hm(d.totalSec)}</Text>
                </View>
              );
            })}
          </View>
        </View>
      ) : null}
      {w ? (
        <View style={card}>
          <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(2) }}>
            Kayıtlar
          </Text>
          {w.entries.length === 0 ? <Text style={{ color: colors.muted }}>Bu hafta kayıt yok.</Text> : null}
          {w.entries.map((e) =>
            editing !== 'new' && editing?.id === e.id ? (
              <EntryForm key={e.id} accountId={accountId} projectsEnabled={projectsEnabled} week={w} entry={e} onDone={() => { setEditing(null); week.reload(); }} />
            ) : (
              <EntryRow key={e.id} entry={e} zone={zone} editable={entryEditable(w, e)} busy={busy === `del:${e.id}`}
                onEdit={() => setEditing(e)}
                onDelete={() => void act(`del:${e.id}`, () => backend.timeEntryDelete(accountId, e.id, e.version), 'Kayıt silindi.')} />
            ),
          )}
          {editing === 'new' ? <EntryForm accountId={accountId} projectsEnabled={projectsEnabled} week={w} entry={null} onDone={() => { setEditing(null); week.reload(); }} /> : null}
          {actions?.canEdit && editing === null ? <Button title="Kayıt ekle" kind="secondary" onPress={() => setEditing('new')} /> : null}
        </View>
      ) : null}
      {w && actions ? (
        <View style={card}>
          <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(2) }}>
            Dönem onayı
          </Text>
          <TimeError error={err} />
          {note ? <Text accessibilityRole="alert" style={{ color: colors.ok }}>{note}</Text> : null}
          {actions.canSubmit ? (
            <>
              {!w.reviewerConfigured ? <Text style={{ color: colors.muted }}>Yöneticiniz tanımlı değil; gönderilen dönemi inceleyecek kimse yok.</Text> : null}
              <Button title="Dönemi onaya gönder" busy={busy === 'submit'} disabled={!!busy} onPress={() => void act('submit', () => backend.timeSubmit(accountId, w.period.id, w.period.version, uuid()), 'Dönem onaya gönderildi.')} />
            </>
          ) : null}
          {actions.withdrawable ? (
            <Button title="Gönderimi geri çek" kind="secondary" busy={busy === 'withdraw'} disabled={!!busy} onPress={() => void act('withdraw', () => backend.timeWithdraw(accountId, actions.withdrawable!.id, w.period.version, uuid()), 'Gönderim geri çekildi.')} />
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
                      {r.actorUid} {REVIEW_ACTION[r.action] ?? r.action}: {r.reason}
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
  const when = e.kind === 'range' && e.startUtc && e.endUtc ? `${utcToZoned(e.startUtc, zone).time}–${utcToZoned(e.endUtc, zone).time}` : 'süre';
  const title = e.card?.title ?? (e.description || '—');
  return (
    <View style={{ paddingVertical: space(2), borderBottomWidth: 1, borderColor: colors.border }}>
      <Text style={{ color: colors.text }}>
        {formatDate(e.localDate)} · {when} · {hm(e.durationSec)}
        {e.billable ? ' · faturalı' : ''}
        {editable ? '' : ' 🔒'}
      </Text>
      <Text style={{ color: colors.muted }}>{title}</Text>
      {editable ? (
        <View style={{ flexDirection: 'row', gap: space(2) }}>
          <Button title="Düzenle" accessibilityLabel={`Kaydı düzenle: ${title}`} kind="secondary" onPress={onEdit} />
          <Button title="Sil" accessibilityLabel={`Kaydı sil: ${title}`} kind="danger" busy={busy} onPress={onDelete} />
        </View>
      ) : null}
    </View>
  );
}

function EntryForm({ accountId, projectsEnabled, week, entry, fixedTask, onDone, onSavedWarning }: { accountId: AccountId; projectsEnabled: boolean; week: TimeWeek; entry: TimeEntry | null; fixedTask?: Pick<TaskDetail, 'id' | 'title'>; onDone: () => void; onSavedWarning?: (warning: string) => void }) {
  const { backend } = useServices();
  const zone = entry?.zone ?? week.period.zone;
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
    if (busy || warn) return;
    const cardId = fixedTask?.id ?? (task === undefined ? undefined : (task[0]?.id ?? null));
    const r = buildTimeEntry(form, zone, { maxEntrySeconds: week.policy.maxEntrySeconds, allowTaskless: week.policy.allowTaskless, ...(cardId !== undefined ? { cardId } : {}) }, entry ?? undefined);
    if ('error' in r) return setErr(FORM_ERROR[r.error]);
    setErr(undefined);
    if ('patch' in r && Object.keys(r.patch).length === 1) return onDone();
    setBusy(true);
    try {
      const res = 'create' in r ? await backend.timeEntryCreate(accountId, r.create, uuid()) : await backend.timeEntryUpdate(accountId, entry!.id, r.patch);
      const overlap = res?.warnings.find((x) => x.code === 'TIME_OVERLAP');
      if (overlap) {
        if (onSavedWarning) {
          onSavedWarning(t.timeOverlapSaved);
          onDone();
        } else {
          setWarn(t.timeOverlapSaved);
          setTimeout(onDone, 1500);
        }
      } else onDone();
    } catch (e) {
      setErr(timeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View accessibilityLabel={entry ? t.editTimeEntry : t.addTimeEntry} style={{ paddingVertical: space(2), borderTopWidth: 1, borderColor: colors.border }}>
      <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(2) }}>
        {entry ? t.editTimeEntry : t.addTimeEntry}
      </Text>
      {!entry ? (
        <View style={{ flexDirection: 'row', gap: space(2), marginBottom: space(2) }}>
          <Chip label={t.timeEntryKindRange} selected={form.kind === 'range'} onPress={() => set({ kind: 'range' })} />
          <Chip label={t.timeEntryKindDuration} selected={form.kind === 'duration'} onPress={() => set({ kind: 'duration' })} />
        </View>
      ) : null}
      <Field label={t.timeEntryDate} value={form.date} onChangeText={(v) => set({ date: v.trim() })} autoCapitalize="none" />
      {form.kind === 'range' ? (
        <View style={{ flexDirection: 'row', gap: space(2) }}>
          <View style={{ flex: 1 }}>
            <Field label={t.timeEntryStart} value={form.start} onChangeText={(v) => set({ start: v.trim() })} />
          </View>
          <View style={{ flex: 1 }}>
            <Field label={t.timeEntryEnd} value={form.end} onChangeText={(v) => set({ end: v.trim() })} />
          </View>
        </View>
      ) : (
        <Field label={t.timeEntryHours} value={form.hours} onChangeText={(v) => set({ hours: v })} placeholder={t.timeEntryHoursHint} />
      )}
      <Field label={t.timeEntryDescription} value={form.description} onChangeText={(v) => set({ description: v })} multiline />
      {fixedTask ? <Text style={{ color: colors.muted }}>{fixedTask.title}</Text> : <View accessibilityLabel="Bağlı görev" style={{ marginBottom: space(2) }}>
        <Text style={ui.label}>Görev</Text>
        <Text>{shownTask[0] ? (entry?.card?.restricted && task === undefined ? 'Erişiminiz olmayan bir görev' : shownTask[0].title) : 'Görev bağlı değil'}</Text>
        {projectsEnabled ? (
          <View style={{ flexDirection: 'row', gap: space(2), marginTop: space(1) }}>
            <Button title={picking ? 'Seçimi kapat' : shownTask[0] ? 'Görevi değiştir' : 'Görev bağla'} kind="secondary" onPress={() => setPicking(!picking)} />
            {shownTask[0] ? <Button title="Bağlantıyı kaldır" kind="secondary" onPress={() => { setTask([]); setPicking(false); }} /> : null}
          </View>
        ) : null}
        {picking ? <TaskPicker accountId={accountId} selected={shownTask} onChange={(t) => { setTask(t); if (t.length) setPicking(false); }} /> : null}
      </View>}
      <View style={{ flexDirection: 'row', marginBottom: space(2) }}>
        <Chip label={t.timeEntryBillable} selected={form.billable} onPress={() => set({ billable: !form.billable })} />
      </View>
      <Text style={{ color: colors.muted, fontSize: font.small }}>{t.timeEntryZone}: {zone}</Text>
      {err ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{err}</Text> : null}
      {warn ? <Text accessibilityRole="alert" style={{ color: colors.text }}>{warn}</Text> : null}
      <View style={{ flexDirection: 'row', gap: space(2) }}>
        <Button title={t.save} busy={busy} disabled={!!warn} onPress={() => void save()} />
        <Button title={t.cancel} kind="secondary" disabled={busy} onPress={onDone} />
      </View>
    </View>
  );
}

export function TaskTimeEntries({ accountId, task, week, canTrack, onChanged }: { accountId: AccountId; task: TaskDetail; week: TimeWeek | undefined; canTrack: boolean; onChanged: () => void }) {
  const { backend } = useServices();
  const list = useAsync(() => backend.timeCardEntries(accountId, task.id), [accountId, task.id, task.mySec]);
  const [editing, setEditing] = useState<TimeEntry | 'new' | null>(null);
  const [checking, setChecking] = useState<number>();
  const [err, setErr] = useState<unknown>();
  const [note, setNote] = useState<string>();
  const edit = async (entry: TimeEntry) => {
    if (!canTrack || checking !== undefined) return;
    setChecking(entry.id);
    setErr(undefined);
    setNote(undefined);
    try {
      const period = await backend.timePeriod(accountId, entry.periodId);
      const fresh = editableCardEntry(period, entry.id, task.id);
      if (fresh) setEditing(fresh);
      else setNote(t.timeEntryReadOnly);
    } catch (e) {
      setErr(e);
    } finally {
      setChecking(undefined);
    }
  };
  return (
    <View style={card}>
      <Text accessibilityRole="header" style={{ color: colors.textStrong, fontWeight: '700' }}>{t.taskTimeEntries}</Text>
      <TimeError error={list.error ?? err} onRetry={list.error ? list.reload : undefined} />
      {list.loading && !list.data ? <Loading /> : null}
      {list.data?.length === 0 ? <Text style={{ color: colors.muted }}>{t.noTaskTimeEntries}</Text> : null}
      {(list.data ?? []).map((entry) => (
        <View key={entry.id} style={{ paddingVertical: space(2), borderBottomWidth: 1, borderColor: colors.border }}>
          <Text style={{ color: colors.text }}>{formatTaskDate(entry.localDate, 'start')} · {hm(entry.durationSec)}</Text>
          {entry.description ? <Text selectable style={{ color: colors.muted }}>{entry.description}</Text> : null}
          {canTrack && !editing ? <Button title={t.editTimeEntry} kind="secondary" disabled={checking !== undefined && checking !== entry.id} busy={checking === entry.id} onPress={() => void edit(entry)} /> : null}
        </View>
      ))}
      {note ? <Text accessibilityRole="alert" style={{ color: colors.muted }}>{note}</Text> : null}
      {canTrack && week && !editing ? <Button title={t.addTimeEntry} kind="secondary" disabled={checking !== undefined} onPress={() => { setNote(undefined); setErr(undefined); setEditing('new'); }} /> : null}
      {canTrack && week && editing ? (
        <EntryForm accountId={accountId} projectsEnabled={false} week={week} entry={editing === 'new' ? null : editing} fixedTask={task} onSavedWarning={setNote} onDone={() => { setEditing(null); list.reload(); onChanged(); }} />
      ) : null}
    </View>
  );
}

export function ReviewQueue({ accountId, onChanged }: { accountId: AccountId; onChanged?: () => void }) {
  const [status, setStatus] = useState<'pending' | 'approved'>('pending');
  return <>
    <Tabs value={status} items={[['pending', 'Bekleyenler'], ['approved', 'Onaylananlar']]} onChange={setStatus} />
    <ReviewList key={`${accountId}:${status}`} accountId={accountId} status={status} {...(onChanged ? { onChanged } : {})} />
  </>;
}

function ReviewList({ accountId, status, onChanged }: { accountId: AccountId; status: 'pending' | 'approved'; onChanged?: () => void }) {
  const { backend } = useServices();
  const list = useAsync(() => backend.timeReviews(accountId, status), [backend, accountId, status]);
  return (
    <>
      <TimeError error={list.error} onRetry={list.reload} />
      {list.loading && !list.data ? <Loading /> : null}
      {(list.data ?? []).length === 0 && !list.loading && !list.error ? <Text style={{ color: colors.muted }}>{status === 'pending' ? 'İncelemenizi bekleyen dönem yok.' : 'Onaylanmış dönem yok.'}</Text> : null}
      {!list.error ? (list.data ?? []).map((item) => (
        <ReviewCard key={item.submission.id} accountId={accountId} item={item} loading={list.loading} onChanged={() => { list.reload(); onChanged?.(); }} />
      )) : null}
    </>
  );
}

export function SubmissionDetail({ accountId, id, onChanged }: { accountId: AccountId; id: number; onChanged: () => void }) {
  const { backend } = useServices();
  const detail = useAsync(() => backend.timeSubmission(accountId, id), [backend, accountId, id]);
  if (detail.error) return <TimeError error={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return <Loading />;
  return <ReviewCard accountId={accountId} item={detail.data} loading={detail.loading} onChanged={() => { detail.reload(); onChanged(); }} />;
}

function ReviewCard({ accountId, item, loading, onChanged }: { accountId: AccountId; item: ReviewItem; loading: boolean; onChanged: () => void }) {
  const { backend } = useServices();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<ReviewAction | null>(null);
  const [err, setErr] = useState<string>();
  const who = item.user.displayName;
  const pending = item.submission.status === 'pending';
  const canReview = item.canReview === true && (pending || item.submission.status === 'approved');
  const decide = async (action: ReviewAction) => {
    if (!canReview || loading || busy || (pending === (action === 'reopen'))) return;
    if (action !== 'approve' && !reason.trim()) return setErr('Gerekçe yazın.');
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
  return (
    <View style={card} accessibilityLabel={`${who}, ${formatDate(item.period.localStartDate)} – ${formatDate(item.period.localEndDate)}, ${hm(item.submission.totalSec)}`}>
      <Text style={{ fontWeight: '700', color: colors.text }}>{who}</Text>
      <Text style={{ color: colors.muted }}>
        {formatDate(item.period.localStartDate)} – {formatDate(item.period.localEndDate)} · #{item.submission.revision} · {SUBMISSION_STATUS[item.submission.status] ?? item.submission.status}
      </Text>
      <Text style={{ color: colors.text, marginVertical: space(1) }}>
        Toplam {hm(item.submission.totalSec)} · Faturalı {hm(item.submission.billableSec)} · {item.entries.length} kayıt
      </Text>
      {item.entries.slice(0, 20).map((e) => (
        <Text key={e.entryId} style={{ color: colors.muted, fontSize: font.small }}>
          {formatDate(e.localDate)} · {hm(e.durationSec)} · {e.card?.title ?? (e.description || '—')}
        </Text>
      ))}
      {canReview ? (
        <>
          <TextInput accessibilityLabel={`Gerekçe: ${who}`} placeholder={pending ? 'Değişiklik isteği gerekçesi' : 'Yeniden açma gerekçesi'} placeholderTextColor={colors.muted} value={reason} onChangeText={setReason} multiline style={[ui.input, { marginTop: space(2), minHeight: 60, paddingTop: 10 }]} />
          {err ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{err}</Text> : null}
          <View style={{ flexDirection: 'row', gap: space(2), flexWrap: 'wrap' }}>
            {pending ? <Button title="Onayla" accessibilityLabel={`Onayla: ${who}`} busy={busy === 'approve'} disabled={!!busy || loading} onPress={() => void decide('approve')} /> : null}
            {pending ? <Button title="Değişiklik iste" accessibilityLabel={`Değişiklik iste: ${who}`} kind="secondary" busy={busy === 'request_changes'} disabled={!!busy || loading} onPress={() => void decide('request_changes')} /> : null}
            {!pending ? <Button title="Yeniden aç" accessibilityLabel={`Yeniden aç: ${who}`} kind="danger" busy={busy === 'reopen'} disabled={!!busy || loading} onPress={() => void decide('reopen')} /> : null}
          </View>
        </>
      ) : null}
    </View>
  );
}

const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));

/** Table cell: compact `s:dd` on screen, full duration for screen readers. */
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
    if (!isDay(draft.from) || !isDay(draft.to)) return setFormErr('Tarihleri YYYY-AA-GG biçiminde girin.');
    if (draft.from > draft.to) return setFormErr('Başlangıç bitişten sonra olamaz.');
    if (addDays(draft.from, 92) < draft.to) return setFormErr('Aralık en fazla 93 gün olabilir.');
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
            <Field label="Başlangıç" value={draft.from} onChangeText={(v) => setDraft((d) => ({ ...d, from: v.trim() }))} />
          </View>
          <View style={{ flexGrow: 1, minWidth: 140 }}>
            <Field label="Bitiş" value={draft.to} onChangeText={(v) => setDraft((d) => ({ ...d, to: v.trim() }))} />
          </View>
          <Button title="Göster" onPress={apply} />
        </View>
        {formErr ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{formErr}</Text> : null}
      </View>
      <TimeError error={report.error} onRetry={report.reload} />
      {report.loading && !r ? <Loading /> : null}
      {r ? (
        <View style={card}>
          <View role="table" aria-label={`Takım raporu ${formatDate(r.from)} – ${formatDate(r.to)}`}>
            <View role="row" style={{ flexDirection: 'row', borderBottomWidth: 2, borderColor: colors.border }}>
              {['Kişi', 'Toplam', 'Faturalı', 'Onaylı', 'Bekleyen'].map((h, i) => (
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
              <Text role="rowheader" style={[cell, { fontWeight: '700', color: colors.text }]}>Toplam</Text>
              <Num sec={r.totals.totalSec} bold />
              <Num sec={r.totals.billableSec} bold />
              <Text role="cell" style={cell} />
              <Text role="cell" style={cell} />
            </View>
          </View>
          {r.users.length === 0 ? <Text style={{ color: colors.muted }}>Raporunuzda kişi yok.</Text> : null}
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
  const label = scope === 'team' ? 'Takım CSV indir' : 'CSV indir';
  const run = async () => {
    setBusy(true);
    setMsg(undefined);
    try {
      const { filename, csv } = await backend.timeCsv(accountId, scope, defaultFrom, defaultTo);
      const r = await platform.saveFile!(filename, csv, 'text/csv');
      setMsg(r === 'saved' ? { ok: true, text: platform.kind === 'desktop' ? `Kaydedildi: ${filename}` : 'Paylaşım sayfası açıldı.' } : { ok: false, text: 'İptal edildi.' });
    } catch (e) {
      setMsg({ ok: false, text: timeError(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={card}>
      <Text style={{ color: colors.muted, fontSize: font.small }}>
        {formatDate(defaultFrom)} – {formatDate(defaultTo)} · {platform.kind === 'desktop' ? 'kaydetme penceresi açılır' : 'paylaşım sayfası açılır'}
      </Text>
      <Button title={label} kind="secondary" busy={busy} onPress={() => void run()} />
      {msg ? <Text accessibilityRole="alert" style={{ color: msg.ok ? colors.ok : colors.danger }}>{msg.text}</Text> : null}
    </View>
  );
}
