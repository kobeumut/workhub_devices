import { useEffect, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import {
  OcsError, REPORT_STATES, requestActions,
  type AccountId, type ReportScope, type RequestContext, type ReportState, type ReportType, type RequestDecision, type RequestReportFilters, type WorkRequest,
} from '@workhub-devices/core';
import { useAsync, useServices, type AsyncState } from './services';
import { Button, Field, Loading, card, styles as ui } from './ui';
import { Chip } from './taskEdit';
import { Tabs, hm } from './time';
import { colors, font, space } from './theme';
import { describeError, formatDate } from './i18n';

/** Hex UUID v4 (Idempotency-Key must pass the IPC key check even without crypto.randomUUID). */
const uuid = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const h = () => Math.floor(Math.random() * 16).toString(16);
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, h);
};
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const dateTime = (iso: string | null) => (iso ? `${formatDate(iso)} ${iso.slice(11, 16)}` : '—');

export const REQUEST_STATE: Record<string, string> = {
  pending: 'Onay bekliyor',
  open: 'Açık',
  rejected: 'Reddedildi',
  converted: 'Göreve dönüştü',
  resolved: 'Çözüldü',
  // Timesheet rows in the report.
  approved: 'Onaylandı',
  changes_requested: 'Değişiklik istendi',
  withdrawn: 'Geri çekildi',
  superseded: 'Yeniden açıldı',
};

/** Where a request stands (same wording rules as the Workhub web UI). */
export function requestStatus(r: Pick<WorkRequest, 'state' | 'taskState' | 'managerName'>): string {
  switch (r.state) {
    case 'pending':
      return 'Alıcının onayı bekleniyor';
    case 'rejected':
      return 'Alıcı reddetti';
    case 'resolved':
      return 'Görevsiz çözüldü';
    case 'open':
      return r.managerName === null ? 'Nextcloud\'da yönetici ataması bekleniyor' : 'Yöneticinin işlemi bekleniyor';
  }
  if (r.taskState === 'closed') return 'Görev tamamlandı';
  if (r.taskState === 'missing') return 'Bağlı görev silinmiş veya erişilemiyor';
  return 'Göreve dönüştü · sürüyor';
}

const EVENT: Record<string, string> = {
  'request.created': 'Talep açıldı',
  'request.approved': 'Alıcı onayladı',
  'request.rejected': 'Alıcı reddetti',
  'request.converted': 'Göreve dönüştürüldü',
  'request.resolved': 'Görevsiz çözüldü',
  'request.task_closed': 'Görev tamamlandı olarak görüldü',
  'request.task_reopened': 'Görev yeniden açık görüldü',
  'request.task_missing': 'Bağlı görev erişilemez',
};

function requestError(e: unknown): string {
  if (e instanceof OcsError) {
    switch (e.errorCode) {
      case 'VERSION_CONFLICT':
        return 'Talep bu arada değişti veya başkası işledi; güncel hali yüklendi.';
      case 'REASON_REQUIRED':
      case 'FIELD_REQUIRED':
        return 'Gerekçe yazın.';
      case 'DECK_EDIT_REQUIRED':
        return 'Görevin oluşturulacağı projede düzenleme yetkiniz olmalı.';
      case 'INVALID_STACK':
        return 'Sütun seçilen projeye ait değil.';
      case 'INVALID_RECIPIENT':
        return 'Kendiniz dışında etkin bir alıcı seçin.';
      case 'REQUEST_MANAGER_REQUIRED':
        return 'Bu işlem yalnız yöneticiler içindir.';
      case 'REQUESTS_DISABLED':
        return 'Talepler modülü sizin için kapalı.';
      case 'RANGE_TOO_LARGE':
        return 'Aralık en fazla 366 gün olabilir.';
      case 'REPORT_TOO_LARGE':
        return 'Rapor 5000 satırı aşıyor; aralığı veya filtreleri daraltın.';
    }
    if (e.kind === 'not_found') return 'Talep bulunamadı ya da artık bu işlem için yetkiniz yok.';
    if (e.kind === 'client' && e.ocsMessage) return e.ocsMessage;
  }
  return describeError(e);
}

function Alert({ text, ok }: { text?: string | undefined; ok?: boolean }) {
  return text ? <Text accessibilityRole="alert" style={{ color: ok ? colors.ok : colors.danger, marginVertical: space(1) }}>{text}</Text> : null;
}

type Scope = 'mine' | 'received' | 'team' | 'report';

/**
 * Native Requests: list (mine / received / team), create, detail with history, recipient
 * approve/reject, manager resolve/convert (project + column picker), and the report. Actions are
 * shown only when the server's flags allow them; a 409 reloads the request.
 */
export function RequestsScreen({ accountId, timeEnabled = false }: { accountId: AccountId; timeEnabled?: boolean }) {
  const { backend } = useServices();
  const ctx = useAsync(() => backend.requestContext(accountId), [accountId]);
  const [scope, setScope] = useState<Scope>('mine');
  const [open, setOpen] = useState<number | null>(null);
  const isManager = ctx.data?.isManager === true;
  const tabs: Array<[Scope, string]> = [['mine', 'Gönderdiklerim'], ['received', 'Bana gelenler'], ...(isManager ? [['team', 'Ekibim'] as [Scope, string]] : []), ['report', 'Rapor']];
  return (
    <ScrollView contentContainerStyle={{ padding: space(3) }}>
      <Tabs value={scope} items={tabs} onChange={(s) => { setScope(s); setOpen(null); }} />
      {scope === 'report' ? (
        <RequestReportView accountId={accountId} isManager={isManager} timeEnabled={timeEnabled} />
      ) : (
        <RequestList accountId={accountId} scope={scope} open={open} onOpen={setOpen} ctx={ctx} />
      )}
    </ScrollView>
  );
}

function RequestList({ accountId, scope, open, onOpen, ctx }: {
  accountId: AccountId;
  scope: 'mine' | 'received' | 'team';
  open: number | null;
  onOpen: (id: number | null) => void;
  ctx: AsyncState<RequestContext>;
}) {
  const { backend } = useServices();
  const list = useAsync(() => backend.requests(accountId, scope), [accountId, scope]);
  const items = list.data ?? [];
  const empty = scope === 'mine' ? 'Gönderdiğiniz talep yok.' : scope === 'received' ? 'Size gelen talep yok.' : 'Ekibinizde işlem bekleyen talep yok.';
  return (
    <>
      {list.error ? <Alert text={requestError(list.error)} /> : null}
      {list.loading && !list.data ? <Loading /> : null}
      {items.length === 0 && !list.loading && !list.error ? <Text style={{ color: colors.muted, marginBottom: space(3) }}>{empty}</Text> : null}
      {items.map((r) => {
        const a = requestActions(r);
        const pending = a.respond || a.resolve;
        return (
          <View key={r.id} style={card}>
            <Text style={{ fontWeight: '700', color: colors.text }}>{r.title}</Text>
            <Text style={{ color: colors.muted }}>
              {REQUEST_STATE[r.state] ?? r.state} · {scope === 'mine' ? `→ ${r.recipientName}` : `← ${r.requesterName}`} · {formatDate(r.createdAt)}
            </Text>
            <Text style={{ color: pending ? colors.primary : colors.muted, fontSize: font.small }}>{pending ? 'İşleminizi bekliyor' : requestStatus(r)}</Text>
            {open === r.id ? (
              <RequestDetail accountId={accountId} id={r.id} onChanged={list.reload} onClose={() => onOpen(null)} />
            ) : (
              <Button title={pending ? 'Aç ve işle' : 'Ayrıntı'} accessibilityLabel={`Ayrıntı: ${r.title}`} kind="secondary" onPress={() => onOpen(r.id)} />
            )}
          </View>
        );
      })}
      {scope === 'mine' ? <CreateRequest accountId={accountId} ctx={ctx} onCreated={list.reload} /> : null}
    </>
  );
}

function CreateRequest({ accountId, ctx, onCreated }: { accountId: AccountId; ctx: { data?: { manager: { displayName: string } | null } | undefined }; onCreated: () => void }) {
  const { backend } = useServices();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const create = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await backend.createRequest(accountId, title.trim(), description.trim(), null, uuid());
      setTitle('');
      setDescription('');
      onCreated();
    } catch (e) {
      setErr(requestError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={card}>
      <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(2) }}>
        Yeni talep
      </Text>
      {ctx.data && !ctx.data.manager ? (
        <Text style={{ color: colors.muted }}>Yöneticiniz tanımlı değil; talep gönderebilmek için yöneticinizin tanımlanması gerekir.</Text>
      ) : (
        <>
          <Text style={{ color: colors.muted, marginBottom: space(2) }}>Alıcı: {ctx.data?.manager?.displayName ?? '…'}</Text>
          <TextInput accessibilityLabel="Başlık" placeholder="Başlık" placeholderTextColor={colors.muted} value={title} onChangeText={setTitle} style={[ui.input, { marginBottom: space(2) }]} />
          <TextInput accessibilityLabel="Açıklama" placeholder="Açıklama" placeholderTextColor={colors.muted} value={description} onChangeText={setDescription} multiline style={[ui.input, { minHeight: 80, paddingTop: 10 }]} />
          <Alert text={err} />
          <Button title="Gönder" busy={busy} disabled={!title.trim()} onPress={() => void create()} />
        </>
      )}
    </View>
  );
}

/** Detail: fresh server state (version, flags, linked task), allowed actions, and history. */
export function RequestDetail({ accountId, id, onChanged, onClose }: { accountId: AccountId; id: number; onChanged: () => void; onClose: () => void }) {
  const { backend } = useServices();
  const detail = useAsync(() => backend.requestDetail(accountId, id), [accountId, id]);
  const history = useAsync(() => backend.requestHistory(accountId, id, null), [accountId, id]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const r = detail.data;
  const refresh = () => {
    detail.reload();
    history.reload();
    onChanged();
  };
  /** Runs one write; on 409 the request is reloaded so the user acts on the current version. */
  const write = async (fn: (r: WorkRequest) => Promise<WorkRequest | null>, done: string) => {
    if (!r) return false;
    setMsg(undefined);
    try {
      const out = await fn(r);
      if (out) detail.setData(() => out);
      history.reload();
      onChanged();
      setMsg({ ok: true, text: done });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: requestError(e) });
      if (e instanceof OcsError && (e.kind === 'conflict' || e.kind === 'not_found')) refresh();
      return false;
    }
  };
  if (detail.loading && !r) return <Loading />;
  if (!r) return <><Alert text={requestError(detail.error)} /><Button title="Kapat" kind="secondary" onPress={onClose} /></>;
  const a = requestActions(r);
  return (
    <View style={{ marginTop: space(2), borderTopWidth: 1, borderColor: colors.border, paddingTop: space(2) }}>
      <Text style={{ color: colors.text }}>{requestStatus(r)}</Text>
      {r.description ? <Text style={{ color: colors.text, marginTop: space(1) }}>{r.description}</Text> : null}
      <Text style={{ color: colors.muted, fontSize: font.small, marginTop: space(1) }}>
        {r.requesterName} → {r.recipientName}{r.managerName ? ` · Yönetici: ${r.managerName}` : ''} · {dateTime(r.createdAt)}
      </Text>
      {r.rejectionReason ? <Text style={{ color: colors.danger, marginTop: space(1) }}>Ret gerekçesi: {r.rejectionReason}</Text> : null}
      {r.card ? (
        <Text style={{ color: colors.text, marginTop: space(1) }} accessibilityLabel={`Bağlı görev: ${r.card.title}, ${r.card.boardTitle}, ${r.card.stackTitle}`}>
          Görev: {r.card.title} · {r.card.boardTitle} / {r.card.stackTitle}{r.card.done ? ' · tamamlandı' : ''}
        </Text>
      ) : null}
      {r.cardRestricted ? <Text style={{ color: colors.muted, marginTop: space(1) }}>Bağlı görev, erişiminiz olmayan bir projede.</Text> : null}
      <Alert text={msg?.text} ok={msg?.ok} />
      {a.respond ? <RespondForm title={r.title} onSubmit={(decision, reason) => write((x) => backend.requestRespond(accountId, x.id, x.version, decision, reason, uuid()), decision === 'approve' ? 'Talep onaylandı; yöneticiye iletildi.' : 'Talep reddedildi.')} /> : null}
      {a.resolve ? <ResolveForm title={r.title} onSubmit={(reason) => write((x) => backend.requestResolve(accountId, x.id, x.version, reason, uuid()), 'Talep görevsiz çözüldü.')} /> : null}
      {a.convert ? <ConvertForm accountId={accountId} title={r.title} onSubmit={(boardId, stackId) => write((x) => backend.requestConvert(accountId, x.id, x.version, boardId, stackId, uuid()), 'Görev oluşturuldu.')} /> : null}
      <Text accessibilityRole="header" style={{ fontWeight: '700', color: colors.text, marginTop: space(3) }}>Geçmiş</Text>
      {history.error ? <Alert text={requestError(history.error)} /> : null}
      {(history.data?.items ?? []).map((e) => (
        <Text key={e.id} style={{ color: colors.muted, fontSize: font.small }}>
          {dateTime(e.occurredAt)} · {EVENT[e.action] ?? e.action}{e.actorUid ? ` · ${e.actorUid}` : ''}{e.reason ? ` · “${e.reason}”` : ''}
        </Text>
      ))}
      <Button title="Kapat" kind="secondary" onPress={onClose} />
    </View>
  );
}

function RespondForm({ title, onSubmit }: { title: string; onSubmit: (d: RequestDecision, reason: string | null) => Promise<boolean> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<RequestDecision | null>(null);
  const [err, setErr] = useState<string>();
  const go = async (d: RequestDecision) => {
    if (d === 'reject' && !reason.trim()) return setErr('Reddetmek için gerekçe yazın.');
    setErr(undefined);
    setBusy(d);
    if (await onSubmit(d, reason.trim() || null)) setReason('');
    setBusy(null);
  };
  return (
    <View style={{ marginTop: space(2) }}>
      <Text style={{ fontWeight: '700', color: colors.text }}>Yanıtla</Text>
      <TextInput accessibilityLabel={`Gerekçe: ${title}`} placeholder="Gerekçe (reddetmede zorunlu)" placeholderTextColor={colors.muted} value={reason} onChangeText={setReason} multiline style={[ui.input, { minHeight: 60, paddingTop: 10 }]} />
      <Alert text={err} />
      <View style={{ flexDirection: 'row', gap: space(2), flexWrap: 'wrap' }}>
        <Button title="Onayla" accessibilityLabel={`Onayla: ${title}`} busy={busy === 'approve'} disabled={!!busy} onPress={() => void go('approve')} />
        <Button title="Reddet" accessibilityLabel={`Reddet: ${title}`} kind="danger" busy={busy === 'reject'} disabled={!!busy} onPress={() => void go('reject')} />
      </View>
    </View>
  );
}

function ResolveForm({ title, onSubmit }: { title: string; onSubmit: (reason: string) => Promise<boolean> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const go = async () => {
    if (!reason.trim()) return setErr('Çözüm gerekçesi yazın.');
    setErr(undefined);
    setBusy(true);
    if (await onSubmit(reason.trim())) setReason('');
    setBusy(false);
  };
  return (
    <View style={{ marginTop: space(2) }}>
      <Text style={{ fontWeight: '700', color: colors.text }}>Görevsiz çöz</Text>
      <TextInput accessibilityLabel={`Çözüm gerekçesi: ${title}`} placeholder="Neden görev gerekmiyor?" placeholderTextColor={colors.muted} value={reason} onChangeText={setReason} multiline style={[ui.input, { minHeight: 60, paddingTop: 10 }]} />
      <Alert text={err} />
      <Button title="Çöz" accessibilityLabel={`Çöz: ${title}`} kind="secondary" busy={busy} onPress={() => void go()} />
    </View>
  );
}

/** Destination picker: only projects the user can edit (not archived), then a column of that project. */
function ConvertForm({ accountId, title, onSubmit }: { accountId: AccountId; title: string; onSubmit: (boardId: number, stackId: number) => Promise<boolean> }) {
  const { backend } = useServices();
  const projects = useAsync(async () => (await backend.projects(accountId)).filter((p) => p.edit && !p.archived), [accountId]);
  const [boardId, setBoardId] = useState<number | null>(null);
  const board = useAsync(async () => (boardId ? backend.board(accountId, boardId) : null), [accountId, boardId]);
  const stacks = board.data?.project.stacks ?? [];
  const [stackId, setStackId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const all = projects.data ?? [];
  const needle = q.trim().toLocaleLowerCase('tr');
  // Long project lists: filter by name, show at most 12 chips (the selected one always stays).
  const shown = all.filter((p) => p.id === boardId || !needle || p.title.toLocaleLowerCase('tr').includes(needle)).slice(0, 12);
  useEffect(() => {
    // Default to the first non-done column of the chosen project.
    setStackId(stacks.find((s) => !s.isDone)?.id ?? stacks[0]?.id ?? null);
  }, [board.data]);
  const go = async () => {
    if (!boardId || !stackId) return;
    setBusy(true);
    await onSubmit(boardId, stackId);
    setBusy(false);
  };
  return (
    <View style={{ marginTop: space(2) }}>
      <Text style={{ fontWeight: '700', color: colors.text }}>Göreve dönüştür</Text>
      {projects.error ? <Alert text={requestError(projects.error)} /> : null}
      {projects.loading && !projects.data ? <Loading /> : null}
      {projects.data && projects.data.length === 0 ? <Text style={{ color: colors.muted }}>Düzenleme yetkiniz olan proje yok.</Text> : null}
      {projects.data && projects.data.length > 0 ? (
        <>
          <Text style={{ color: colors.muted, fontSize: font.small }}>Proje</Text>
          {all.length > 6 ? <TextInput accessibilityLabel={`Proje ara: ${title}`} placeholder="Proje ara" placeholderTextColor={colors.muted} value={q} onChangeText={setQ} style={[ui.input, { marginBottom: space(1) }]} /> : null}
          <View accessibilityRole="radiogroup" accessibilityLabel="Proje" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(1), marginBottom: space(2) }}>
            {shown.map((p) => <Chip key={p.id} label={p.title} selected={boardId === p.id} onPress={() => { setBoardId(p.id); setStackId(null); }} />)}
          </View>
          {shown.length === 0 ? <Text style={{ color: colors.muted }}>Eşleşen proje yok.</Text> : null}
        </>
      ) : null}
      {boardId && board.loading && !board.data ? <Loading /> : null}
      {board.error ? <Alert text={requestError(board.error)} /> : null}
      {boardId && stacks.length > 0 ? (
        <>
          <Text style={{ color: colors.muted, fontSize: font.small }}>Sütun</Text>
          <View accessibilityRole="radiogroup" accessibilityLabel="Sütun" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(1), marginBottom: space(2) }}>
            {stacks.map((s) => <Chip key={s.id} label={s.title} selected={stackId === s.id} onPress={() => setStackId(s.id)} />)}
          </View>
        </>
      ) : null}
      <Button title="Görev oluştur" accessibilityLabel={`Göreve dönüştür: ${title}`} busy={busy} disabled={!boardId || !stackId} onPress={() => void go()} />
    </View>
  );
}

const STATE_FILTERS: Array<[ReportState, string]> = REPORT_STATES.map((s) => [s, s === 'any' ? 'Tümü' : (REQUEST_STATE[s] ?? s)]);

/** Read-only report over requests (and, when Time is on, timesheet submissions). Accessible table. */
function RequestReportView({ accountId, isManager, timeEnabled }: { accountId: AccountId; isManager: boolean; timeEnabled: boolean }) {
  const { backend } = useServices();
  const today = new Date().toISOString().slice(0, 10);
  const [filters, setFilters] = useState<RequestReportFilters>({ scope: 'all', type: 'request', state: 'any', from: addDays(today, -29), to: today });
  const [draft, setDraft] = useState({ from: filters.from, to: filters.to });
  const [formErr, setFormErr] = useState<string>();
  const report = useAsync(() => backend.requestReport(accountId, filters), [accountId, filters.scope, filters.type, filters.state, filters.from, filters.to]);
  const apply = () => {
    if (!isDay(draft.from) || !isDay(draft.to)) return setFormErr('Tarihleri YYYY-AA-GG biçiminde girin.');
    if (draft.from > draft.to) return setFormErr('Başlangıç bitişten sonra olamaz.');
    if (addDays(draft.from, 365) < draft.to) return setFormErr('Aralık en fazla 366 gün olabilir.');
    setFormErr(undefined);
    setFilters((f) => ({ ...f, ...draft }));
  };
  const scopes: Array<[ReportScope, string]> = [['all', 'Tümü'], ['mine', 'Gönderilen'], ['received', 'Gelen'], ...(isManager ? [['team', 'Ekip'] as [ReportScope, string]] : [])];
  const types: Array<[ReportType, string]> = [['request', 'Talepler'], ...(timeEnabled ? [['timesheet', 'Zaman çizelgeleri'] as [ReportType, string], ['all', 'Hepsi'] as [ReportType, string]] : [])];
  const r = report.data;
  const cell = { flex: 1, paddingVertical: space(2), paddingHorizontal: space(1) } as const;
  return (
    <>
      <View style={card}>
        <Tabs value={filters.scope} items={scopes} onChange={(scope) => setFilters((f) => ({ ...f, scope }))} />
        {types.length > 1 ? <Tabs value={filters.type} items={types} onChange={(type) => setFilters((f) => ({ ...f, type }))} /> : null}
        <Text style={{ color: colors.muted, fontSize: font.small }}>Durum</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel="Durum" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(1), marginBottom: space(2) }}>
          {STATE_FILTERS.map(([s, label]) => <Chip key={s} label={label} selected={filters.state === s} onPress={() => setFilters((f) => ({ ...f, state: s }))} />)}
        </View>
        <View style={{ flexDirection: 'row', gap: space(2), alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <View style={{ flexGrow: 1, minWidth: 140 }}>
            <Field label="Başlangıç" value={draft.from} onChangeText={(v) => setDraft((d) => ({ ...d, from: v.trim() }))} />
          </View>
          <View style={{ flexGrow: 1, minWidth: 140 }}>
            <Field label="Bitiş" value={draft.to} onChangeText={(v) => setDraft((d) => ({ ...d, to: v.trim() }))} />
          </View>
          <Button title="Göster" onPress={apply} />
        </View>
        <Alert text={formErr} />
      </View>
      {report.error ? <Alert text={requestError(report.error)} /> : null}
      {report.loading && !r ? <Loading /> : null}
      {r ? (
        <View style={card}>
          <Text style={{ color: colors.text, marginBottom: space(2) }}>
            {formatDate(r.from)} – {formatDate(r.to)} · {r.total} kayıt
            {Object.entries(r.byState).map(([s, n]) => ` · ${REQUEST_STATE[s] ?? s}: ${n}`).join('')}
          </Text>
          <View role="table" aria-label={`Talep raporu ${formatDate(r.from)} – ${formatDate(r.to)}`}>
            <View role="row" style={{ flexDirection: 'row', borderBottomWidth: 2, borderColor: colors.border }}>
              {['Tarih', 'Başlık', 'Talep eden', 'Alıcı', 'Durum'].map((h) => (
                <Text key={h} role="columnheader" style={[cell, { fontWeight: '700', color: colors.text }]}>{h}</Text>
              ))}
            </View>
            {r.items.map((row) => (
              <View key={`${row.type}:${row.id}`} role="row" style={{ flexDirection: 'row', borderBottomWidth: 1, borderColor: colors.border }}>
                <Text role="cell" style={[cell, { color: colors.text }]}>{formatDate(row.createdAt)}</Text>
                <Text role="rowheader" style={[cell, { color: colors.text }]}>
                  {row.type === 'timesheet' ? `Zaman çizelgesi ${formatDate(row.periodStart ?? '')}–${formatDate(row.periodEnd ?? '')}${row.totalSec !== null ? ` · ${hm(row.totalSec)}` : ''}` : row.title}
                </Text>
                <Text role="cell" style={[cell, { color: colors.text }]}>{row.requesterName}</Text>
                <Text role="cell" style={[cell, { color: colors.text }]}>{row.recipientName ?? '—'}</Text>
                <Text role="cell" style={[cell, { color: colors.text }]}>{REQUEST_STATE[row.state] ?? row.state}</Text>
              </View>
            ))}
          </View>
          {r.items.length === 0 ? <Text style={{ color: colors.muted }}>Bu filtrelerle kayıt yok.</Text> : null}
        </View>
      ) : null}
    </>
  );
}
