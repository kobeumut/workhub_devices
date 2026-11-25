import { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import {
  OcsError, REPORT_APPROVALS, REPORT_STATES, REQUEST_STATES, loadPendingRequestApprovals, requestActions, requestReportStatus,
  type AccountId, type PendingRequestCursor, type ReportScope, type ReportType, type RequestContext, type RequestDecision,
  type RequestListState, type RequestPage, type RequestReportFilters, type RequestScope, type WorkRequest,
} from '@workhub-devices/core';
import { useAsync, useServices, type AsyncState } from './services';
import { Button, Field, Loading, card, styles as ui, Pill, PressCard } from './ui';
import { Chip } from './taskEdit';
import { ReviewQueue, SubmissionDetail, Tabs, hm } from './time';
import { PrincipalPicker } from './projectAdmin';
import { colors, font, space } from './theme';
import { describeError, formatDate, requestText as rt, t } from './i18n';

/** Hex UUID v4 (Idempotency-Key must pass the IPC key check even without crypto.randomUUID). */
const uuid = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const h = () => Math.floor(Math.random() * 16).toString(16);
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, h);
};
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const dateTime = (iso: string | null) => (iso ? `${formatDate(iso)} ${iso.slice(11, 16)}` : '—');

export const REQUEST_STATE = rt.state;

export function requestStatus(r: Pick<WorkRequest, 'state' | 'taskState' | 'managerName' | 'managerApproval'>): string {
  if (r.state === 'pending') return r.managerApproval?.state === 'approved' ? rt.preApproved : rt.pending;
  if (r.state === 'rejected') return rt.recipientRejected;
  if (r.state === 'withdrawn') return rt.state.withdrawn!;
  if (r.state === 'cancelled') return r.managerApproval?.state === 'rejected' ? rt.cancelledByManager : rt.state.cancelled!;
  if (r.state === 'resolved') return rt.resolved;
  if (r.state === 'open') {
    if (r.managerApproval?.state === 'approved') return rt.approvedOpen;
    return r.managerName === null ? rt.managerMissing : rt.managerPending;
  }
  if (r.taskState === 'closed') return rt.taskClosed;
  if (r.taskState === 'missing') return rt.taskMissing;
  return r.managerApproval?.state === 'waiting' ? `${rt.taskOpen} · ${rt.managerPending}` : rt.taskOpen;
}

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

type Scope = RequestScope | 'inbox' | 'approvals' | 'report' | 'timesheets';

type RequestsProps = { accountId: AccountId; timeEnabled?: boolean; startInApprovals?: boolean; onOpenTask?: (cardId: number) => void; onChanged?: () => void };

export function RequestsScreen(props: RequestsProps) {
  return <RequestCenter key={props.accountId} {...props} />;
}

function RequestCenter({ accountId, timeEnabled = false, startInApprovals = false, onOpenTask, onChanged }: RequestsProps) {
  const { backend } = useServices();
  const ctx = useAsync(() => backend.requestContext(accountId), [backend, accountId]);
  const review = useAsync(async () => timeEnabled && (await backend.session(accountId)).workhub?.permissions.canViewTeamReport === true, [backend, accountId, timeEnabled]);
  const [scope, setScope] = useState<Scope>(startInApprovals ? 'approvals' : 'inbox');
  const [state, setState] = useState<RequestListState>('any');
  const [open, setOpen] = useState<number | null>(null);
  const [submission, setSubmission] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const reviewer = ctx.data?.isReviewer === true;
  const team = reviewer || ctx.data?.isManager === true;
  const teamLabel = reviewer ? rt.everyone : rt.team;
  const refresh = () => { setRevision((n) => n + 1); onChanged?.(); };
  const tabs: Array<[Scope, string]> = [['inbox', rt.inbox], ['approvals', rt.approvals], ['mine', rt.mine], ['received', rt.received]];
  if (team) tabs.push(['team', teamLabel]);
  tabs.push(['report', rt.report]);
  if (timeEnabled && review.data === true) tabs.push(['timesheets', rt.timesheetApprovals]);
  return (
    <ScrollView contentContainerStyle={{ padding: space(3) }}>
      <Tabs value={scope} items={tabs} onChange={(s) => { setScope(s); setState('any'); setOpen(null); setSubmission(null); }} />
      {open !== null ? (
        <View style={card}>
          <RequestDetail key={open} accountId={accountId} id={open} onChanged={refresh} onClose={() => setOpen(null)} onOpenTask={onOpenTask} />
        </View>
      ) : null}
      {submission !== null ? <>
        <Button kind="secondary" title={t.back} onPress={() => setSubmission(null)} />
        <SubmissionDetail key={submission} accountId={accountId} id={submission} onChanged={refresh} />
      </> : null}
      <View style={open !== null || submission !== null ? { display: 'none' } : undefined}>
      {scope === 'inbox' ? (
        <RequestInboxView key={revision} accountId={accountId} onOpen={setOpen} />
      ) : scope === 'report' ? (
        <RequestReportView revision={revision} accountId={accountId} teamLabel={team ? teamLabel : undefined} timeEnabled={timeEnabled} onOpen={setOpen} onOpenSubmission={setSubmission} />
      ) : scope === 'timesheets' ? (
        timeEnabled && review.data === true ? <ReviewQueue accountId={accountId} {...(onChanged ? { onChanged } : {})} /> : null
      ) : scope === 'approvals' ? (
        <RequestFeed<PendingRequestCursor> key={revision} load={(before) => loadPendingRequestApprovals((s, f, cursor) => backend.requestPage(accountId, s, f, cursor), before)} empty={rt.noApprovals} onOpen={setOpen} />
      ) : scope !== 'team' || team ? (
        <>
          <Tabs<RequestListState> value={state} items={['any', ...REQUEST_STATES].map((s) => [s as RequestListState, s === 'any' ? rt.all : (REQUEST_STATE[s] ?? s)])} onChange={setState} />
          <RequestFeed key={`${scope}:${state}:${revision}`} load={(before: number | null) => backend.requestPage(accountId, scope, state, before)} empty={scope === 'mine' ? rt.noMine : scope === 'received' ? rt.noReceived : rt.noTeam} onOpen={setOpen} />
          {scope === 'mine' ? <CreateRequest accountId={accountId} ctx={ctx} onCreated={setOpen} /> : null}
        </>
      ) : null}
      {scope === 'approvals' || scope === 'report' ? <CreateRequest accountId={accountId} ctx={ctx} onCreated={setOpen} /> : null}
      </View>
    </ScrollView>
  );
}

function RequestInboxView({ accountId, onOpen }: { accountId: AccountId; onOpen: (id: number) => void }) {
  const { backend } = useServices();
  const inbox = useAsync(() => backend.requestInbox(accountId, 10), [backend, accountId]);
  if (inbox.error) return <Alert text={requestError(inbox.error)} />;
  if (!inbox.data) return <Loading />;
  const { items, total } = inbox.data;
  return <>
    {!items.length ? <Text style={{ color: colors.muted }}>{rt.noInbox}</Text> : null}
    {items.map((row) => <PressCard key={row.id} accessibilityLabel={`${rt.details}: ${row.title}`} onPress={() => onOpen(row.id)}>
      <Text style={{ fontWeight: '700', color: colors.text }}>{row.title}</Text>
      <Text style={{ color: colors.muted }}>{row.subtitle} · {dateTime(row.at)}</Text>
    </PressCard>)}
    {total > items.length ? <Text style={{ color: colors.muted }}>{rt.inboxMore(items.length, total)}</Text> : null}
  </>;
}

/** A keyed feed keeps cursors scoped to the account, server filter and refresh. */
function RequestFeed<Cursor>({ load, empty, onOpen }: {
  load: (before: Cursor | null) => Promise<RequestPage<WorkRequest, Cursor>>;
  empty: string;
  onOpen: (id: number) => void;
}) {
  const feed = useAsync(() => load(null), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const cursor = feed.data?.nextCursor ?? null;
  async function more() {
    if (cursor === null || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await load(cursor);
      feed.setData((old) => {
        const items = new Map((old?.items ?? []).map((row) => [row.id, row]));
        for (const row of next.items) items.set(row.id, row);
        return { ...next, items: [...items.values()] };
      });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  if (feed.error) return <Alert text={requestError(feed.error)} />;
  if (!feed.data) return <Loading />;
  return <>
    {!feed.data.items.length && cursor === null ? <Text style={{ color: colors.muted }}>{empty}</Text> : null}
    {feed.data.items.map((row) => <PressCard key={row.id} accessibilityLabel={`${rt.details}: ${row.title}`} onPress={() => onOpen(row.id)}>
      <Text style={{ fontWeight: '700', color: colors.text }}>{row.title}</Text>
      <Text style={{ color: colors.muted }}>{row.requesterName} → {row.recipientName} · {formatDate(row.createdAt)}</Text>
      <Pill label={row.awaitingYou === true ? rt.awaiting : requestStatus(row)} tone={row.awaitingYou === true ? 'warning' : row.state === 'rejected' || row.state === 'cancelled' ? 'danger' : row.state === 'resolved' || row.taskState === 'closed' ? 'ok' : 'neutral'} />
    </PressCard>)}
    {error ? <Alert text={requestError(error)} /> : null}
    {cursor !== null ? <Button title={rt.more} kind="secondary" busy={busy} onPress={() => void more()} /> : null}
  </>;
}

function CreateRequest({ accountId, ctx, onCreated }: { accountId: AccountId; ctx: AsyncState<RequestContext>; onCreated: (id: number) => void }) {
  const { backend } = useServices();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [picked, setPicked] = useState<{ uid: string; displayName: string }>();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const recipient = picked ?? ctx.data?.manager;
  const create = async () => {
    if (!recipient || !title.trim() || !description.trim() || busy) return;
    setBusy(true);
    setErr(undefined);
    try {
      const created = await backend.createRequest(accountId, title.trim(), description.trim(), recipient.uid, uuid());
      if (!created) return;
      setTitle('');
      setDescription('');
      setPicked(undefined);
      onCreated(created.id);
    } catch (e) {
      setErr(requestError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={card}>
      <Text accessibilityRole="header" style={{ color: colors.text, fontWeight: '700', marginBottom: space(2) }}>{rt.newRequest}</Text>
      {ctx.error ? <Alert text={requestError(ctx.error)} /> : null}
      <Text style={{ color: colors.muted }}>{recipient ? rt.recipient(recipient.displayName) : rt.noRecipient}</Text>
      {picking ? <PrincipalPicker accountId={accountId} label={rt.recipientSearch} usersOnly exclude={ctx.data ? [`user:${ctx.data.uid}`] : []} onPick={(p) => {
        setPicked({ uid: p.principalId, displayName: p.displayName });
        setPicking(false);
      }} /> : <Button title={rt.changeRecipient} kind="secondary" onPress={() => setPicking(true)} />}
      <TextInput accessibilityLabel={rt.title} placeholder={rt.title} placeholderTextColor={colors.muted} value={title} onChangeText={setTitle} maxLength={255} style={[ui.input, { marginBottom: space(2) }]} />
      <TextInput accessibilityLabel={rt.description} placeholder={rt.description} placeholderTextColor={colors.muted} value={description} onChangeText={setDescription} maxLength={10000} multiline style={[ui.input, { minHeight: 80, paddingTop: 10 }]} />
      <Alert text={err} />
      <Button title={t.send} busy={busy} disabled={!title.trim() || !description.trim() || !recipient || picking} onPress={() => void create()} />
    </View>
  );
}

/** Detail: fresh server state (version, flags, linked task), allowed actions, and history. */
export function RequestDetail({ accountId, id, onChanged, onClose, onOpenTask }: {
  accountId: AccountId; id: number; onChanged: () => void; onClose: () => void; onOpenTask?: ((cardId: number) => void) | undefined;
}) {
  const { backend } = useServices();
  const detail = useAsync(() => backend.requestDetail(accountId, id), [backend, accountId, id]);
  const history = useAsync(() => backend.requestHistory(accountId, id, null), [backend, accountId, id]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const r = detail.data?.id === id ? detail.data : undefined;
  const [, setClock] = useState(0);
  // Re-enable a reminder when its server-provided cooldown elapses while detail stays open.
  useEffect(() => {
    if (!r?.talkAvailable) return;
    const now = Date.now();
    const handles = [r.remindAvailableAt, r.remindManagersAvailableAt].flatMap((at) => {
      const delay = typeof at === 'string' ? Date.parse(at) - now : 0;
      return delay > 0 ? [setTimeout(() => setClock((n) => n + 1), delay)] : [];
    });
    return () => { handles.forEach(clearTimeout); };
  }, [r]);
  /** Writes use the currently displayed version and the explicit flag from fresh detail. */
  const write = async (action: keyof ReturnType<typeof requestActions>, fn: (r: WorkRequest) => Promise<WorkRequest | null>, done: string) => {
    if (!r || detail.loading || detail.error || writing.current || !requestActions(r)[action]) return false;
    writing.current = true;
    setBusy(true);
    setMsg(undefined);
    try {
      const out = await fn(r);
      if (out) detail.setData(() => out);
      else {
        detail.setData(() => undefined);
        detail.reload();
      }
      history.reload();
      onChanged();
      setMsg({ ok: true, text: done });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: requestError(e) });
      if (e instanceof OcsError && ['conflict', 'not_found', 'forbidden'].includes(e.kind)) {
        detail.setData(() => undefined);
        detail.reload();
        history.setData(() => undefined);
        history.reload();
        onChanged();
      }
      return false;
    } finally {
      writing.current = false;
      setBusy(false);
    }
  };
  if (detail.error) return <><Alert text={requestError(detail.error)} /><Button title={t.close} kind="secondary" onPress={onClose} /></>;
  if (!r) return <><Alert text={msg?.text} /><Loading /></>;
  const a = requestActions(r);
  const blocked = busy || detail.loading;
  const reminderButton = (label: string, allowed: boolean, ready: boolean, at: string | null | undefined, onPress: () => void) =>
    allowed && r.talkAvailable === true ? <Button title={at && !ready ? rt.remindAfter(label, dateTime(at)) : label} kind="secondary" disabled={!ready || blocked} onPress={onPress} /> : null;
  return (
    <View style={{ marginTop: space(2), borderTopWidth: 1, borderColor: colors.border, paddingTop: space(2) }}>
      <Text accessibilityRole="header" style={{ fontWeight: '700', color: colors.text }}>{r.title}</Text>
      <Text style={{ color: colors.text }}>{requestStatus(r)}</Text>
      {r.description ? <Text style={{ color: colors.text, marginTop: space(1) }}>{r.description}</Text> : null}
      <Text style={{ color: colors.muted, fontSize: font.small, marginTop: space(1) }}>
        {r.requesterName} → {r.recipientName}{r.managerName ? ` · Yönetici: ${r.managerName}` : ''} · {dateTime(r.createdAt)}
      </Text>
      {r.rejectionReason ? <Text style={{ color: colors.danger, marginTop: space(1) }}>Ret gerekçesi: {r.rejectionReason}</Text> : null}
      {r.cancelReason ? <Text style={{ color: colors.danger, marginTop: space(1) }}>{rt.cancelReason(r.cancelReason)}</Text> : null}
      {r.card ? (
        <>
          <Text style={{ color: colors.text, marginTop: space(1) }} accessibilityLabel={`Bağlı görev: ${r.card.title}, ${r.card.boardTitle}, ${r.card.stackTitle}`}>
            Görev: {r.card.title} · {r.card.boardTitle} / {r.card.stackTitle}{r.card.done ? ' · tamamlandı' : ''}
          </Text>
          {onOpenTask && !r.cardRestricted ? <Button title={rt.openTask} kind="secondary" onPress={() => { if (r.card) onOpenTask(r.card.id); }} /> : null}
        </>
      ) : null}
      {r.cardRestricted ? <Text style={{ color: colors.muted, marginTop: space(1) }}>Bağlı görev, erişiminiz olmayan bir projede.</Text> : null}
      <Alert text={msg?.text} ok={msg?.ok} />
      {a.respond ? <RespondForm labels={rt.respondent} blocked={blocked} onSubmit={(decision, reason) => write('respond', (x) => backend.requestRespond(accountId, x.id, x.version, decision, reason, uuid()), decision === 'approve' ? rt.accepted : rt.rejected)} /> : null}
      {a.decide ? <RespondForm labels={rt.manager} blocked={blocked} onSubmit={(decision, reason) => write('decide', (x) => backend.requestDecide(accountId, x.id, x.version, decision, reason, uuid()), decision === 'approve' ? rt.managerApproved : rt.managerRejected)} /> : null}
      {a.resolve ? <ResolveForm title={r.title} blocked={blocked} onSubmit={(reason) => write('resolve', (x) => backend.requestResolve(accountId, x.id, x.version, reason, uuid()), rt.resolved)} /> : null}
      {a.convert ? <ConvertForm accountId={accountId} title={r.title} blocked={blocked} onSubmit={(boardId, stackId) => write('convert', (x) => backend.requestConvert(accountId, x.id, x.version, boardId, stackId, uuid()), rt.converted)} /> : null}
      {a.cancel ? <CancelForm title={r.state === 'pending' ? rt.withdraw : rt.cancel} blocked={blocked} onSubmit={(reason) => write('cancel', (x) => backend.requestCancel(accountId, x.id, x.version, reason, uuid()), r.state === 'pending' ? rt.withdrawn : rt.cancelled)} /> : null}
      {reminderButton(rt.remind, r.canRemind === true, a.remind, r.remindAvailableAt, () => void write('remind', (x) => backend.requestRemind(accountId, x.id, x.version, uuid()), rt.reminded))}
      {reminderButton(rt.remindManagers, r.canRemindManagers === true, a.remindManagers, r.remindManagersAvailableAt, () => void write('remindManagers', (x) => backend.requestRemindManagers(accountId, x.id, x.version, uuid()), rt.managersReminded))}
      {(r.canRemind === true || r.canRemindManagers === true) && r.talkAvailable === false ? <Text style={{ color: colors.muted }}>{rt.talkUnavailable}</Text> : null}
      <Text accessibilityRole="header" style={{ fontWeight: '700', color: colors.text, marginTop: space(3) }}>Geçmiş</Text>
      {history.error ? <Alert text={requestError(history.error)} /> : null}
      {(history.data?.items ?? []).map((e) => (
        <Text key={e.id} style={{ color: colors.muted, fontSize: font.small }}>
          {dateTime(e.occurredAt)} · {rt.event[e.action] ?? e.action}{(e.actorName ?? e.actorUid) ? ` · ${e.actorName ?? e.actorUid}` : ''}{e.reason ? ` · “${e.reason}”` : ''}
        </Text>
      ))}
      <Button title={t.close} kind="secondary" onPress={onClose} />
    </View>
  );
}

function RespondForm({ labels, blocked, onSubmit }: { labels: typeof rt.respondent | typeof rt.manager; blocked: boolean; onSubmit: (d: RequestDecision, reason: string | null) => Promise<boolean> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<RequestDecision | null>(null);
  const [err, setErr] = useState<string>();
  const go = async (d: RequestDecision) => {
    if (d === 'reject' && !reason.trim()) return setErr(rt.rejectReason);
    setErr(undefined);
    setBusy(d);
    if (await onSubmit(d, d === 'reject' ? reason.trim() : null)) setReason('');
    setBusy(null);
  };
  return (
    <View style={{ marginTop: space(2) }}>
      <Text style={{ fontWeight: '700', color: colors.text }}>{labels.title}</Text>
      <TextInput accessibilityLabel={`${labels.title}: ${rt.reason}`} placeholder={rt.rejectPlaceholder} placeholderTextColor={colors.muted} value={reason} onChangeText={setReason} maxLength={2000} multiline style={[ui.input, { minHeight: 60, paddingTop: 10 }]} />
      <Alert text={err} />
      <View style={{ flexDirection: 'row', gap: space(2), flexWrap: 'wrap' }}>
        <Button title={labels.approve} busy={busy === 'approve'} disabled={blocked} onPress={() => void go('approve')} />
        <Button title={labels.reject} kind="danger" busy={busy === 'reject'} disabled={blocked} onPress={() => void go('reject')} />
      </View>
    </View>
  );
}

function CancelForm({ title, blocked, onSubmit }: { title: string; blocked: boolean; onSubmit: (reason: string | null) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) return <Button title={title} kind="secondary" disabled={blocked} onPress={() => setOpen(true)} />;
  return <View style={{ marginTop: space(2) }}>
    <TextInput accessibilityLabel={rt.optionalReason} placeholder={rt.optionalReason} placeholderTextColor={colors.muted} value={reason} onChangeText={setReason} maxLength={2000} multiline style={ui.input} />
    <Button title={title} kind="danger" disabled={blocked} onPress={() => {
      void onSubmit(reason.trim() || null).then((ok) => { if (ok) setOpen(false); });
    }} />
    <Button title={t.close} kind="secondary" disabled={blocked} onPress={() => setOpen(false)} />
  </View>;
}

function ResolveForm({ title, blocked, onSubmit }: { title: string; blocked: boolean; onSubmit: (reason: string) => Promise<boolean> }) {
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
      <TextInput accessibilityLabel={`Çözüm gerekçesi: ${title}`} placeholder="Neden görev gerekmiyor?" placeholderTextColor={colors.muted} value={reason} onChangeText={setReason} maxLength={2000} multiline style={[ui.input, { minHeight: 60, paddingTop: 10 }]} />
      <Alert text={err} />
      <Button title="Çöz" accessibilityLabel={`Çöz: ${title}`} kind="secondary" busy={busy} disabled={blocked} onPress={() => void go()} />
    </View>
  );
}

/** Destination picker: only projects the user can edit (not archived), then a column of that project. */
function ConvertForm({ accountId, title, blocked, onSubmit }: { accountId: AccountId; title: string; blocked: boolean; onSubmit: (boardId: number, stackId: number) => Promise<boolean> }) {
  const { backend } = useServices();
  const projects = useAsync(async () => (await backend.projects(accountId)).filter((p) => p.edit && !p.archived), [accountId]);
  const [boardId, setBoardId] = useState<number | null>(null);
  const board = useAsync(async () => (boardId ? backend.board(accountId, boardId) : null), [accountId, boardId]);
  const stacks = board.data?.project.board.id === boardId ? board.data?.project.stacks ?? [] : [];
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
    if (!boardId || !stackId || !stacks.some((s) => s.id === stackId) || blocked) return;
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
      <Button title="Görev oluştur" accessibilityLabel={`Göreve dönüştür: ${title}`} busy={busy} disabled={blocked || board.loading || !stacks.some((s) => s.id === stackId)} onPress={() => void go()} />
    </View>
  );
}

const STATE_FILTERS = REPORT_STATES.map((s) => [s, s === 'any' ? rt.all : (REQUEST_STATE[s] ?? s)] as const);

/** The server owns visibility, filtering and counts; the people search only narrows the picker. */
function RequestReportView({ accountId, teamLabel, timeEnabled, revision, onOpen, onOpenSubmission }: {
  onOpenSubmission: (id: number) => void;
  accountId: AccountId; teamLabel: string | undefined; timeEnabled: boolean; revision: number; onOpen: (id: number) => void;
}) {
  const { backend } = useServices();
  const today = new Date().toISOString().slice(0, 10);
  const [filters, setFilters] = useState<RequestReportFilters>({ scope: 'all', type: timeEnabled ? 'all' : 'request', state: 'any', from: addDays(today, -29), to: today, person: '', approval: 'any' });
  const [draft, setDraft] = useState({ from: filters.from, to: filters.to });
  const [formErr, setFormErr] = useState<string>();
  const [q, setQ] = useState('');
  const [peopleLimit, setPeopleLimit] = useState(12);
  const peopleKey = JSON.stringify([filters.scope, filters.type, filters.state, filters.from, filters.to]);
  const queryKey = JSON.stringify([peopleKey, filters.person, filters.approval, revision]);
  const report = useAsync(async () => {
    const result = await backend.requestReport(accountId, filters);
    if ((filters.person && filters.person !== result.person) || (filters.approval !== 'any' && filters.approval !== result.approval)) {
      return { queryKey, peopleKey, result: undefined };
    }
    return { queryKey, peopleKey, result };
  }, [backend, accountId, queryKey]);
  const apply = () => {
    if (!isDay(draft.from) || !isDay(draft.to)) return setFormErr('Tarihleri YYYY-AA-GG biçiminde girin.');
    if (draft.from > draft.to) return setFormErr('Başlangıç bitişten sonra olamaz.');
    if (addDays(draft.from, 365) < draft.to) return setFormErr('Aralık en fazla 366 gün olabilir.');
    setFormErr(undefined);
    setFilters((f) => ({ ...f, ...draft }));
  };
  const scopes: Array<[ReportScope, string]> = [['all', rt.all], ['mine', rt.mine], ['received', rt.received]];
  if (teamLabel) scopes.push(['team', teamLabel]);
  const types: Array<[ReportType, string]> = [['request', rt.requests]];
  if (timeEnabled) types.push(['timesheet', rt.timesheets], ['all', rt.all]);
  const current = report.data?.queryKey === queryKey ? report.data : undefined;
  const r = current?.result;
  const counts = new Map<string, number>();
  for (const row of r?.items ?? []) {
    const state = requestReportStatus(row);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const people = report.data?.peopleKey === peopleKey ? report.data.result?.people ?? [] : [];
  const selected = people.find((p) => p.uid === filters.person);
  const needle = q.trim().toLocaleLowerCase('tr');
  const matches = people.filter((p) => p.uid !== filters.person && (!needle || `${p.displayName} ${p.uid}`.toLocaleLowerCase('tr').includes(needle)));
  const cell = { flex: 1, paddingVertical: space(2), paddingHorizontal: space(1) } as const;
  return (
    <>
      <View style={card}>
        <Tabs value={filters.scope} items={scopes} onChange={(scope) => setFilters((f) => ({ ...f, scope }))} />
        {types.length > 1 ? <Tabs value={filters.type} items={types} onChange={(type) => setFilters((f) => ({ ...f, type }))} /> : null}
        <Text style={{ color: colors.muted, fontSize: font.small }}>{rt.status}</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel={rt.status} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(1), marginBottom: space(2) }}>
          {STATE_FILTERS.map(([s, label]) => <Chip key={s} label={label} selected={filters.state === s} onPress={() => setFilters((f) => ({ ...f, state: s }))} />)}
        </View>
        <Text style={{ color: colors.muted, fontSize: font.small }}>{rt.approval}</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel={rt.approval} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(1), marginBottom: space(2) }}>
          {REPORT_APPROVALS.map((approval) => <Chip key={approval} label={rt.approvalStatus[approval]} selected={filters.approval === approval} onPress={() => setFilters((f) => ({ ...f, approval }))} />)}
        </View>
        <Text style={{ color: colors.muted, fontSize: font.small }}>{rt.person}</Text>
        {people.length > 12 ? <Field label={rt.searchReportPeople} value={q} onChangeText={(v) => { setQ(v); setPeopleLimit(12); }} /> : null}
        <View accessibilityRole="radiogroup" accessibilityLabel={rt.person} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(1), marginBottom: space(2) }}>
          <Chip label={rt.everyone} selected={!filters.person} onPress={() => setFilters((f) => ({ ...f, person: '' }))} />
          {filters.person ? <Chip label={selected?.displayName ?? filters.person} selected onPress={() => setFilters((f) => ({ ...f, person: '' }))} /> : null}
          {matches.slice(0, peopleLimit).map((p) => <Chip key={p.uid} label={p.displayName} selected={false} onPress={() => setFilters((f) => ({ ...f, person: p.uid }))} />)}
        </View>
        {matches.length > peopleLimit ? <Button title={rt.morePeople} kind="secondary" onPress={() => setPeopleLimit((n) => n + 12)} /> : null}
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
      {!report.error && !current ? <Loading /> : null}
      {current && !r ? <Alert text={rt.unsupportedFilters} /> : null}
      {r && !report.error ? (
        <View style={card}>
          <Text style={{ color: colors.text, marginBottom: space(2) }}>
            {formatDate(r.from)} – {formatDate(r.to)} · {r.total} kayıt
            {[...counts].map(([s, n]) => ` · ${REQUEST_STATE[s] ?? s}: ${n}`).join('')}
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
                  <Text accessibilityRole="link" onPress={() => (row.type === 'timesheet' ? onOpenSubmission : onOpen)(row.id)} style={{ color: colors.primary }}>
                    {row.type === 'timesheet' ? rt.timesheetPeriod(formatDate(row.periodStart ?? ''), formatDate(row.periodEnd ?? ''), row.totalSec !== null ? hm(row.totalSec) : '') : row.title}
                  </Text>
                </Text>
                <Text role="cell" style={[cell, { color: colors.text }]}>{row.requesterName}</Text>
                <Text role="cell" style={[cell, { color: colors.text }]}>{row.recipientName ?? '—'}</Text>
                <Text role="cell" style={[cell, { color: colors.text }]}>{REQUEST_STATE[requestReportStatus(row)] ?? row.state}</Text>
              </View>
            ))}
          </View>
          {r.items.length === 0 ? <Text style={{ color: colors.muted }}>Bu filtrelerle kayıt yok.</Text> : null}
        </View>
      ) : null}
    </>
  );
}
