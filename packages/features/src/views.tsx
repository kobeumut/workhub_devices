import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import {
  ACTIVITY_TYPES, deviceDay, ganttBar, ganttSchedule, mergeActivity, workloadLoad, workloadWeek, addDays,
  type AccountId, type ActivityEvent, type ActivityFilter, type ActivityType, type DependencyType, type GanttRow, type WorkloadDay, type WorkloadMatrix, type WorkloadMember,
} from '@workhub-devices/core';
import { useAsync, useServices } from './services';
import { Button, Empty, ErrorBanner, Loading, card, styles as ui } from './ui';
import { colors, font, space } from './theme';
import { formatDate } from './i18n';

// ---- shared bits ---------------------------------------------------------------------------

const WEEKDAY = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
const WEEKDAY_LONG = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];
const weekdayOf = (day: string) => ((Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000) + 3) % 7 + 7) % 7;
/** "2 Kas" for a local day string (no time-zone shift: the day is formatted as UTC). */
export const shortDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const longDay = (day: string) => `${WEEKDAY_LONG[weekdayOf(day)]} ${new Date(`${day}T00:00:00Z`).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', timeZone: 'UTC' })}`;
/** Hours with one decimal, Turkish comma ("3,5"). */
export const hours = (sec: number) => {
  const h = Math.round((sec / 3600) * 10) / 10;
  return sec > 0 && h === 0 ? '<0,1' : h.toLocaleString('tr-TR', { maximumFractionDigits: 1 });
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

const DEP_TYPE: Record<DependencyType, string> = { finish_to_start: 'bitiş → başlangıç', start_to_start: 'başlangıç → başlangıç', finish_to_finish: 'bitiş → bitiş' };
const lagText = (lag: number) => (lag ? `, ${lag > 0 ? '+' : ''}${lag} gün` : '');

function rowDates(r: GanttRow): string {
  if (!r.start || !r.end) return 'Tarih yok';
  return r.milestone ? `Kilometre taşı ${shortDay(r.end)}` : `${shortDay(r.start)} – ${shortDay(r.end)} (${r.days} gün)`;
}

/** Full spoken description of a Gantt row; the drawn bar itself is hidden from screen readers. */
export function ganttRowLabel(r: GanttRow): string {
  const parts = [r.task.title, rowDates(r)];
  if (r.done) parts.push('tamamlandı');
  else if (r.overdue) parts.push('gecikmiş');
  if (r.task.assignees.length) parts.push(`atanan: ${r.task.assignees.map((a) => a.displayName).join(', ')}`);
  if (r.task.subtasks.total) parts.push(`alt işler ${r.task.subtasks.done}/${r.task.subtasks.total}`);
  for (const l of r.waitsFor) parts.push(`bekliyor: ${l.other.title} (${DEP_TYPE[l.dependency.type]}${lagText(l.dependency.lagDays)})${l.other.done ? ', tamamlandı' : ''}${l.violated ? ', tarih çakışması' : ''}`);
  for (const l of r.blocks) parts.push(`engelliyor: ${l.other.title}${l.violated ? ', tarih çakışması' : ''}`);
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
      <Pressable key={r.task.id} accessibilityRole="button" accessibilityLabel={ganttRowLabel(r)} accessibilityHint="Görevi açar" onPress={() => onOpenTask(r.task.id)} style={{ paddingHorizontal: space(4), paddingVertical: space(2), borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.bg }}>
        <Text numberOfLines={1} style={{ fontWeight: '600', color: colors.text }}>
          {r.done ? '✓ ' : r.overdue ? '⚠ ' : ''}
          {r.task.title}
        </Text>
        <Text style={{ color: r.overdue ? colors.danger : colors.muted, fontSize: font.small }}>
          {rowDates(r)}
          {r.overdue ? ' · gecikmiş' : ''}
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
            ↳ Bekliyor: {l.other.title} ({DEP_TYPE[l.dependency.type]}{lagText(l.dependency.lagDays)}){l.other.done ? ' ✓' : ''}{l.violated ? ' · tarih çakışması' : ''}
          </Text>
        ))}
        {r.blocks.length ? <Text style={{ fontSize: font.small, color: colors.muted }}>→ Engelliyor: {r.blocks.map((l) => l.other.title).join(', ')}</Text> : null}
      </Pressable>
    );
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.surface }}>
      <ErrorBanner error={s.error} onRetry={s.reload} />
      <View style={{ padding: space(3), flexDirection: 'row', alignItems: 'center', gap: space(2), flexWrap: 'wrap' }}>
        <Text accessibilityRole="header" style={{ fontWeight: '700', color: colors.text }}>
          {range ? `Zaman çizelgesi: ${shortDay(range.start)} – ${shortDay(range.end)}` : 'Zaman çizelgesi'}
        </Text>
        <Text style={{ color: sched.violations ? colors.danger : colors.muted }}>
          {sched.rows.length} planlı · {sched.unscheduled.length} tarihsiz{sched.violations ? ` · ${sched.violations} bağımlılık çakışması` : ''}
        </Text>
        <Pressable accessibilityRole="button" onPress={s.reload}>
          <Text style={{ color: colors.primary, fontWeight: '600' }}>Yenile</Text>
        </Pressable>
      </View>
      {sched.rows.length === 0 ? <Empty text="Bitiş tarihi olan görev yok. Görevlere tarih verince burada görünür." /> : sched.rows.map(renderRow)}
      {sched.unscheduled.length ? (
        <>
          <Text accessibilityRole="header" style={{ padding: space(3), fontWeight: '700', color: colors.muted }}>
            Tarihsiz açık görevler ({sched.unscheduled.length})
          </Text>
          {sched.unscheduled.map(renderRow)}
        </>
      ) : null}
    </ScrollView>
  );
}

// ---- Activity --------------------------------------------------------------------------------

const TYPE_LABEL: Record<ActivityType, string> = { all: 'Tümü', status: 'Durum', comments: 'Yorumlar', subtasks: 'Alt işler', time: 'Zaman', goal: 'Hedefler' };
const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const clip = (v: string, n = 120) => (v.length > n ? `${v.slice(0, n)}…` : v);
const pct = (bp: unknown) => (typeof bp === 'number' ? `%${Math.round(bp / 100)}` : '—');
const dateOf = (v: unknown) => (typeof v === 'string' && v ? formatDate(v) : '—');

/** Turkish one-line summary of an event (plain text; server strings are never rendered as HTML). */
export function activityText(e: ActivityEvent): string {
  const d = e.data;
  const name = (o: unknown) => str((o as { displayName?: string } | null)?.displayName);
  switch (e.kind) {
    case 'card_create': return 'görevi oluşturdu';
    case 'card_delete': return 'görevi sildi';
    case 'card_restore': return 'görevi geri yükledi';
    case 'card_update_stackId': return `taşıdı: ${str(d.from) || '—'} → ${str(d.to) || '—'}`;
    case 'card_update_done': return 'tamamlandı olarak işaretledi';
    case 'card_update_undone': return 'yeniden açtı';
    case 'card_update_archive': return 'arşivledi';
    case 'card_update_unarchive': return 'arşivden çıkardı';
    case 'card_comment_create': return d.comment ? `yorum yaptı: “${clip(str(d.comment))}”` : 'yorum yaptı';
    case 'card_update_title': return `başlığı değiştirdi: “${clip(str(d.before), 60)}” → “${clip(str(d.after), 60)}”`;
    case 'card_update_description': return 'açıklamayı düzenledi';
    case 'card_update_duedate': return `bitiş tarihini değiştirdi: ${dateOf(d.before)} → ${dateOf(d.after)}`;
    case 'card_user_assign': return `${name(d.assignee)} kişisini atadı`;
    case 'card_user_unassign': return `${name(d.assignee)} atamasını kaldırdı`;
    case 'label_assign': return `etiket ekledi: ${str((d.label as { title?: string } | null)?.title)}`;
    case 'label_unassign': return `etiketi kaldırdı: ${str((d.label as { title?: string } | null)?.title)}`;
    case 'attachment_create': return `ek ekledi: ${clip(str(d.attachment), 60)}`;
    case 'attachment_delete': return `eki sildi: ${clip(str(d.attachment), 60)}`;
    case 'time_logged': return `${hours(Number(d.durationSec) || 0)} sa kaydetti (görev toplamı ${hours(Number(d.cardTotalSec) || 0)} sa)${d.description ? `: ${clip(str(d.description), 80)}` : ''}`;
    case 'goal.create': return `hedefi oluşturdu: ${str((d.goal as { title?: string })?.title)}`;
    case 'goal.progress': return `hedef ilerlemesi ${str((d.goal as { title?: string })?.title)}: ${pct(d.fromBp)} → ${pct(d.toBp)}`;
    case 'target.cards': return `hedef görevlerini değiştirdi (${str((d.goal as { title?: string })?.title)}): +${Number(d.added) || 0} / −${Number(d.removed) || 0}`;
    case 'target.create': return `hedef değeri ekledi: ${str(d.title)}`;
    case 'target.delete': return `hedef değerini sildi: ${str(d.title)}`;
    case 'goal.checkin': {
      const v = (x: unknown) => (typeof x === 'boolean' ? (x ? 'evet' : 'hayır') : str(x) || '—');
      return `check-in ${str(d.target)}: ${v(d.from)} → ${v(d.to)}${d.note ? ` (“${clip(str(d.note), 80)}”)` : ''}`;
    }
    case 'task.subtask.add': return `alt iş ekledi: ${clip(str(d.text), 80)} (${Number(d.done) || 0}/${Number(d.total) || 0})`;
    case 'task.subtask.check': return `alt işi tamamladı: ${clip(str(d.text), 80)} (${Number(d.done) || 0}/${Number(d.total) || 0})`;
    case 'task.subtask.uncheck': return `alt işi yeniden açtı: ${clip(str(d.text), 80)}`;
    case 'task.subtask.remove': return `alt işi sildi: ${clip(str(d.text), 80)}`;
    case 'task.subtask.rename': return `alt işi yeniden adlandırdı: ${clip(str(d.previous), 60)} → ${clip(str(d.text), 60)}`;
    default: return e.kind;
  }
}

const eventTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

/** Project activity stream: type filter, search, cursor paging ("Daha eski"). */
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
      <View accessibilityLabel="Etkinlik türü" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), padding: space(3) }}>
        {ACTIVITY_TYPES.map((k) => (
          <Chip key={k} label={TYPE_LABEL[k]} a11y={`Filtre: ${TYPE_LABEL[k]}`} selected={type === k} onPress={() => setType(k)} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: space(2), paddingHorizontal: space(3), paddingBottom: space(2) }}>
        <TextInput accessibilityLabel="Etkinlikte ara" placeholder="Görev, kişi veya metin ara" placeholderTextColor={colors.muted} value={query} onChangeText={setQuery} onSubmitEditing={() => setQ(query.trim())} style={[ui.input, { flex: 1 }]} />
        <Button title="Ara" kind="secondary" onPress={() => setQ(query.trim())} />
      </View>
      {q ? <Text style={{ paddingHorizontal: space(3), color: colors.muted, fontSize: font.small }}>Arama yüklenen sayfalara uygulanır; daha eskisi için “Daha eski”.</Text> : null}
      {sources && !sources.deck ? <Text style={{ paddingHorizontal: space(3), color: colors.muted, fontSize: font.small }}>Sunucuda Activity uygulaması kapalı: kart geçmişi gösterilemiyor.</Text> : null}
      <ErrorBanner error={first.error ?? err} onRetry={first.error ? first.reload : () => void more()} />
      {first.loading && !first.data ? (
        <Loading />
      ) : events.length === 0 ? (
        <Empty text={first.error ? '' : 'Bu filtrede etkinlik yok.'} />
      ) : (
        <View accessibilityRole="list">
          {events.map((e) => {
            const who = e.actor?.displayName ?? 'Sistem';
            const text = activityText(e);
            const target = e.card ? `${e.card.title || `#${e.card.id}`}${e.card.exists ? '' : ' (silinmiş)'}` : '';
            const label = `${who} ${text}${target ? `, görev: ${target}` : ''}, ${eventTime(e.occurredAt)}`;
            const open = e.card?.exists ? () => onOpenTask(e.card!.id) : undefined;
            return (
              <Pressable key={e.id} accessibilityRole={open ? 'button' : 'text'} accessibilityLabel={label} {...(open ? { onPress: open, accessibilityHint: 'Görevi açar' } : {})} style={{ paddingHorizontal: space(4), paddingVertical: space(2), borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.bg }}>
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
      {cursor ? <Button title="Daha eski" kind="secondary" busy={busy} onPress={() => void more()} /> : events.length ? <Text style={{ padding: space(3), color: colors.muted, textAlign: 'center' }}>Etkinliklerin sonu.</Text> : null}
    </ScrollView>
  );
}

// ---- Workload --------------------------------------------------------------------------------

const LOAD_TEXT = { off: 'çalışma günü değil', free: 'boş', ok: 'uygun', full: 'dolu', over: 'aşırı yük' } as const;
const LOAD_BG = { off: colors.surface, free: colors.bg, ok: '#e6f0fa', full: '#fff3d6', over: '#fdecea' } as const;

export function workloadCellLabel(m: Pick<WorkloadMember, 'displayName'>, d: WorkloadDay): string {
  const load = workloadLoad(d);
  const parts = [`${m.displayName}, ${longDay(d.date)}`, `planlanan ${hours(d.plannedSec)} saat`, `kapasite ${hours(d.capacitySec)} saat`];
  if (d.actualSec !== null) parts.push(`gerçekleşen ${hours(d.actualSec)} saat`);
  parts.push(LOAD_TEXT[load]);
  if (d.tasks.length) parts.push(`${d.tasks.length} görev`);
  return parts.join(', ');
}

/**
 * Person × day workload table (role=table with row/column headers). Each cell is a button with
 * the full spoken value and opens that day's tasks; load is shown as text, not only colour.
 */
export function WorkloadScreen({ accountId, onOpenTask }: { accountId: AccountId; onOpenTask?: (cardId: number) => void }) {
  const { backend } = useServices();
  const [span, setSpan] = useState<7 | 14>(7);
  const [from, setFrom] = useState(() => workloadWeek(today()).from);
  const to = addDays(from, span - 1);
  const s = useAsync(() => backend.workload(accountId, { from, to }), [accountId, from, to]);
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
        <Button title="‹" kind="secondary" accessibilityLabel="Önceki dönem" onPress={() => shift(-1)} />
        <Text accessibilityRole="header" style={{ fontWeight: '700', color: colors.text }}>
          {shortDay(from)} – {shortDay(to)}
        </Text>
        <Button title="›" kind="secondary" accessibilityLabel="Sonraki dönem" onPress={() => shift(1)} />
        <Button title="Bu hafta" kind="secondary" onPress={() => { setCell(null); setFrom(workloadWeek(today(), weekStart).from); }} />
        <Chip label="1 hafta" selected={span === 7} onPress={() => setSpan(7)} />
        <Chip label="2 hafta" selected={span === 14} onPress={() => setSpan(14)} />
      </View>
      <ErrorBanner error={s.error} onRetry={s.reload} />
      {s.loading && !m ? <Loading /> : null}
      {m ? (
        <>
          <Text style={{ paddingHorizontal: space(3), color: colors.muted }}>
            Kapasite {hours(m.summary.capacitySec)} sa · planlanan {hours(m.summary.plannedSec)} sa
            {m.summary.utilizationBp !== null ? ` (%${Math.round(m.summary.utilizationBp / 100)})` : ''}
            {m.summary.actualSec !== null ? ` · gerçekleşen ${hours(m.summary.actualSec)} sa` : ''}
            {m.summary.overallocatedMembers ? ` · ${m.summary.overallocatedMembers} kişi aşırı yüklü` : ''}
          </Text>
          <Text style={{ paddingHorizontal: space(3), paddingBottom: space(2), color: colors.muted, fontSize: font.small }}>
            Hücre: planlanan / kapasite (saat). Planlanan yük, atanmış açık görevlerin tahmini sürelerinin başlangıç–bitiş arasındaki iş günlerine dağıtımıdır. Gerçekleşen yalnız görme yetkiniz olan kişilerde gösterilir. Saat dilimi: {m.zone}.
          </Text>
          {m.truncated ? <Text style={{ paddingHorizontal: space(3), color: colors.danger }}>Sonuç sunucu sınırında kesildi; dönemi daraltın.</Text> : null}
          {m.members.length === 0 ? (
            <Empty text="Okuyabildiğiniz projelerde üye yok." />
          ) : (
            <ScrollView horizontal>
              <View role="table" aria-label={`İş yükü ${shortDay(m.from)} – ${shortDay(m.to)}`} style={{ backgroundColor: colors.bg, borderTopWidth: 1, borderColor: colors.border }}>
                <View role="row" style={{ flexDirection: 'row', borderBottomWidth: 2, borderColor: colors.border }}>
                  <Text role="columnheader" style={{ width: headW, padding: space(2), fontWeight: '700', color: colors.text }}>Kişi</Text>
                  {m.days.map((d) => (
                    <Text key={d.date} role="columnheader" aria-label={longDay(d.date)} style={{ width: cellW, padding: space(2), fontWeight: '700', textAlign: 'center', color: d.workday ? colors.text : colors.muted, backgroundColor: d.date === m.today ? '#e6f0fa' : undefined }}>
                      {WEEKDAY[weekdayOf(d.date)]}
                      {'\n'}
                      {shortDay(d.date)}
                    </Text>
                  ))}
                  <Text role="columnheader" style={{ width: cellW + 24, padding: space(2), fontWeight: '700', textAlign: 'right', color: colors.text }}>Toplam</Text>
                </View>
                {m.members.map((mem) => (
                  <View key={mem.uid} role="row" style={{ flexDirection: 'row', borderBottomWidth: 1, borderColor: colors.border }}>
                    <View role="rowheader" style={{ width: headW, padding: space(2) }}>
                      <Text numberOfLines={1} style={{ fontWeight: '600', color: colors.text }}>{mem.displayName}</Text>
                      <Text style={{ fontSize: font.small, color: mem.overdue.length ? colors.danger : colors.muted }}>
                        {mem.taskCount} görev{mem.overdue.length ? ` · ${mem.overdue.length} gecikmiş` : ''}{mem.unscheduled.length ? ` · ${mem.unscheduled.length} tarihsiz` : ''}
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
                          {load === 'over' ? <Text style={{ fontSize: 11, color: colors.danger }}>aşırı</Text> : null}
                          {d.actualSec ? <Text style={{ fontSize: 11, color: colors.muted }}>⏱ {hours(d.actualSec)}</Text> : null}
                        </Pressable>
                        </View>
                      );
                    })}
                    <View role="cell" style={{ width: cellW + 24, padding: space(2), alignItems: 'flex-end' }} aria-label={`${mem.displayName} toplam: planlanan ${hours(mem.plannedSec)} saat, kapasite ${hours(mem.capacitySec)} saat${mem.actualSec !== null ? `, gerçekleşen ${hours(mem.actualSec)} saat` : ''}`}>
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
              {selDay.tasks.length === 0 ? <Text style={{ color: colors.muted }}>Bu gün planlı görev yok.</Text> : null}
              {selDay.tasks.map((x) => {
                const info = m.tasks[String(x.cardId)];
                const title = info?.title ?? `#${x.cardId}`;
                return (
                  <Pressable key={x.cardId} accessibilityRole="button" accessibilityLabel={`${title}, ${info?.boardTitle ?? ''}, bu gün ${hours(x.plannedSec)} saat`} disabled={!onOpenTask} onPress={() => onOpenTask?.(x.cardId)} style={{ paddingVertical: space(2), borderTopWidth: 1, borderColor: colors.border }}>
                    <Text style={{ color: onOpenTask ? colors.primary : colors.text, fontWeight: '600' }}>{title}</Text>
                    <Text style={{ color: colors.muted, fontSize: font.small }}>
                      {info?.boardTitle ?? ''} · bu gün {hours(x.plannedSec)} sa{info?.estimateSec == null ? ' · tahmin yok' : ` · tahmin ${hours(info.estimateSec)} sa`}
                    </Text>
                  </Pressable>
                );
              })}
              {selMember.overdue.length ? <Text style={{ marginTop: space(2), color: colors.danger }}>Gecikmiş: {selMember.overdue.map((id) => m.tasks[String(id)]?.title ?? `#${id}`).join(', ')}</Text> : null}
              {selMember.unscheduled.length ? <Text style={{ marginTop: space(1), color: colors.muted }}>Tarihsiz: {selMember.unscheduled.map((id) => m.tasks[String(id)]?.title ?? `#${id}`).join(', ')}</Text> : null}
            </View>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}
