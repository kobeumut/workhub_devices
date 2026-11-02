import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import {
  OcsError, buildTimeEntry, entryEditable, periodActions, timeEntryFormOf, utcToZoned,
  type AccountId, type CsvScope, type ReviewAction, type ReviewItem, type TimeEntry, type TimeEntryForm, type TimeFormError, type TimeWeek,
} from '@workhub-devices/core';
import { useAsync, useServices } from './services';
import { Button, Field, Loading, card, styles as ui } from './ui';
import { Chip } from './taskEdit';
import { colors, font, space } from './theme';
import { describeError, formatDate } from './i18n';

/** Hex UUID v4 (Idempotency-Key must pass the IPC key check even without crypto.randomUUID). */
const uuid = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const h = () => Math.floor(Math.random() * 16).toString(16);
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, h);
};
export const hm = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h} sa ${String(m).padStart(2, '0')} dk`;
};
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
 * whose Workhub bootstrap grants `canViewTeamReport` (direct manager) — the review queue and the
 * team report. CSV export is offered only when the shell can save/share files.
 */
export function TimeScreen({ accountId, canReview }: { accountId: AccountId; canReview: boolean }) {
  const [tab, setTab] = useState<Tab>('week');
  const tabs: Array<[Tab, string]> = [['week', 'Haftam'], ...(canReview ? ([['review', 'İnceleme'], ['team', 'Takım raporu']] as Array<[Tab, string]>) : [])];
  return (
    <ScrollView contentContainerStyle={{ padding: space(3) }} keyboardShouldPersistTaps="handled">
      {tabs.length > 1 ? <Tabs value={tab} items={tabs} onChange={setTab} /> : null}
      {tab === 'week' ? <WeekView accountId={accountId} /> : null}
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

function WeekView({ accountId }: { accountId: AccountId }) {
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
            <Button title="‹" accessibilityLabel="Önceki hafta" kind="secondary" onPress={() => setDate(w.navigation.prevDate)} />
            <Text accessibilityRole="header" style={{ fontWeight: '700', color: colors.text, flex: 1 }}>
              {formatDate(w.period.localStartDate)} – {formatDate(w.period.localEndDate)}
            </Text>
            {date && date !== w.navigation.today ? <Button title="Bugün" kind="secondary" onPress={() => setDate(undefined)} /> : null}
            <Button title="›" accessibilityLabel="Sonraki hafta" kind="secondary" onPress={() => setDate(w.navigation.nextDate)} />
          </View>
          <Text accessibilityLabel={`Dönem durumu: ${PERIOD_STATE[w.period.state] ?? w.period.state}`} style={{ color: w.period.open ? colors.muted : colors.danger, marginTop: space(1) }}>
            {PERIOD_STATE[w.period.state] ?? w.period.state}
            {w.period.open ? '' : ' · kayıtlar salt okunur 🔒'} · Toplam {hm(w.totals.totalSec)} · Faturalı {hm(w.totals.billableSec)}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginTop: space(2) }}>
            {w.days.map((d) => (
              <Text key={d.date} style={{ color: d.totalSec ? colors.text : colors.muted, fontSize: font.small }}>
                {new Date(`${d.date}T12:00:00Z`).toLocaleDateString('tr-TR', { weekday: 'short', day: '2-digit' })}: {hm(d.totalSec)}
              </Text>
            ))}
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
              <EntryForm key={e.id} accountId={accountId} week={w} entry={e} onDone={() => { setEditing(null); week.reload(); }} />
            ) : (
              <EntryRow key={e.id} entry={e} zone={zone} editable={entryEditable(w, e)} busy={busy === `del:${e.id}`}
                onEdit={() => setEditing(e)}
                onDelete={() => void act(`del:${e.id}`, () => backend.timeEntryDelete(accountId, e.id, e.version), 'Kayıt silindi.')} />
            ),
          )}
          {editing === 'new' ? <EntryForm accountId={accountId} week={w} entry={null} onDone={() => { setEditing(null); week.reload(); }} /> : null}
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

function EntryForm({ accountId, week, entry, onDone }: { accountId: AccountId; week: TimeWeek; entry: TimeEntry | null; onDone: () => void }) {
  const { backend } = useServices();
  const zone = week.period.zone;
  const today = week.navigation.today >= week.period.localStartDate && week.navigation.today <= week.period.localEndDate ? week.navigation.today : week.period.localStartDate;
  const [form, setForm] = useState<TimeEntryForm>(() => timeEntryFormOf(entry, zone, today));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [warn, setWarn] = useState<string>();
  const set = (p: Partial<TimeEntryForm>) => setForm((f) => ({ ...f, ...p }));
  const save = async () => {
    const r = buildTimeEntry(form, zone, { maxEntrySeconds: week.policy.maxEntrySeconds, allowTaskless: week.policy.allowTaskless }, entry ?? undefined);
    if ('error' in r) return setErr(FORM_ERROR[r.error]);
    setErr(undefined);
    if ('patch' in r && Object.keys(r.patch).length === 1) return onDone();
    setBusy(true);
    try {
      const res = 'create' in r ? await backend.timeEntryCreate(accountId, r.create, uuid()) : await backend.timeEntryUpdate(accountId, entry!.id, r.patch);
      const overlap = res?.warnings.find((x) => x.code === 'TIME_OVERLAP');
      if (overlap) {
        setWarn('Kaydedildi; ancak başka bir kayıtla çakışıyor.');
        setTimeout(onDone, 1500);
      } else onDone();
    } catch (e) {
      setErr(timeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View accessibilityLabel={entry ? 'Kaydı düzenle' : 'Yeni kayıt'} style={{ paddingVertical: space(2), borderTopWidth: 1, borderColor: colors.border }}>
      <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(2) }}>
        {entry ? 'Kaydı düzenle' : 'Yeni kayıt'}
      </Text>
      {!entry ? (
        <View style={{ flexDirection: 'row', gap: space(2), marginBottom: space(2) }}>
          <Chip label="Saat aralığı" selected={form.kind === 'range'} onPress={() => set({ kind: 'range' })} />
          <Chip label="Süre" selected={form.kind === 'duration'} onPress={() => set({ kind: 'duration' })} />
        </View>
      ) : null}
      <Field label="Tarih (YYYY-AA-GG)" value={form.date} onChangeText={(v) => set({ date: v.trim() })} autoCapitalize="none" />
      {form.kind === 'range' ? (
        <View style={{ flexDirection: 'row', gap: space(2) }}>
          <View style={{ flex: 1 }}>
            <Field label="Başlangıç (SS:DD)" value={form.start} onChangeText={(v) => set({ start: v.trim() })} />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Bitiş (SS:DD)" value={form.end} onChangeText={(v) => set({ end: v.trim() })} />
          </View>
        </View>
      ) : (
        <Field label="Süre (saat)" value={form.hours} onChangeText={(v) => set({ hours: v })} placeholder="ör. 1,5 veya 1:30" />
      )}
      <Field label="Açıklama" value={form.description} onChangeText={(v) => set({ description: v })} multiline />
      <View style={{ flexDirection: 'row', marginBottom: space(2) }}>
        <Chip label="Faturalanabilir" selected={form.billable} onPress={() => set({ billable: !form.billable })} />
      </View>
      <Text style={{ color: colors.muted, fontSize: font.small }}>Saat dilimi: {zone}</Text>
      {err ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{err}</Text> : null}
      {warn ? <Text accessibilityRole="alert" style={{ color: colors.text }}>{warn}</Text> : null}
      <View style={{ flexDirection: 'row', gap: space(2) }}>
        <Button title="Kaydet" accessibilityLabel={entry ? 'Kaydı kaydet' : 'Kaydı ekle'} busy={busy} onPress={() => void save()} />
        <Button title="İptal" kind="secondary" onPress={onDone} />
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
      <Tabs value={status} items={[['pending', 'Bekleyenler'], ['approved', 'Onaylananlar']]} onChange={setStatus} />
      <TimeError error={list.error} onRetry={list.reload} />
      {list.loading && !list.data ? <Loading /> : null}
      {(list.data ?? []).length === 0 && !list.loading && !list.error ? <Text style={{ color: colors.muted }}>{status === 'pending' ? 'İncelemenizi bekleyen dönem yok.' : 'Onaylanmış dönem yok.'}</Text> : null}
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
  const pending = item.submission.status === 'pending';
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
      {item.canReview ? (
        <>
          <TextInput accessibilityLabel={`Gerekçe: ${who}`} placeholder={pending ? 'Değişiklik isteği gerekçesi' : 'Yeniden açma gerekçesi'} placeholderTextColor={colors.muted} value={reason} onChangeText={setReason} multiline style={[ui.input, { marginTop: space(2), minHeight: 60, paddingTop: 10 }]} />
          {err ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{err}</Text> : null}
          <View style={{ flexDirection: 'row', gap: space(2), flexWrap: 'wrap' }}>
            {pending ? <Button title="Onayla" accessibilityLabel={`Onayla: ${who}`} busy={busy === 'approve'} disabled={!!busy} onPress={() => void decide('approve')} /> : null}
            {pending ? <Button title="Değişiklik iste" accessibilityLabel={`Değişiklik iste: ${who}`} kind="secondary" busy={busy === 'request_changes'} disabled={!!busy} onPress={() => void decide('request_changes')} /> : null}
            {!pending ? <Button title="Yeniden aç" accessibilityLabel={`Yeniden aç: ${who}`} kind="danger" busy={busy === 'reopen'} disabled={!!busy} onPress={() => void decide('reopen')} /> : null}
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
