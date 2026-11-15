import { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import {
  OcsError, aiInputError, aiResultCardId, isAiActive, proposalActions, AI_DRAFT_ACTIONS, AI_LIMITS,
  type AccountId, type AiAction, type AiInputError, type AiProposal, type AiRequestDetail, type AiRequestInput, type AiRequestState, type AiStatus, type BoardPayload,
} from '@workhub-devices/core';
import { useAsync, useServices } from './services';
import { Button, Field, Loading, card, styles as ui } from './ui';
import { Chip } from './taskEdit';
import { Tabs } from './time';
import { ProjectChips, TaskPicker, type PickedTask } from './taskPicker';
import { colors, font, space } from './theme';
import { describeError, formatDate, messages, t } from './i18n';

const m = messages.ai;

/** Hex UUID v4: the server requires a UUID Idempotency-Key for AI create/accept. */
const uuid = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const h = () => Math.floor(Math.random() * 16).toString(16);
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, h);
};
const dateTime = (iso: string | null) => (iso ? `${formatDate(iso)} ${iso.slice(11, 16)}` : '');

/** Label per action. Accessors keep the exported shape while resolving the active language when read. */
export const AI_ACTION_LABEL: Record<AiAction, string> = {
  get card_summary() { return m.actionCardSummary; },
  get board_summary() { return m.actionBoardSummary; },
  get question() { return m.actionQuestion; },
  get create_card_draft() { return m.actionCreateCardDraft; },
  get update_card_draft() { return m.actionUpdateCardDraft; },
  get suggest_checklist() { return m.actionSuggestChecklist; },
};
const stateLabel = (): Record<AiRequestState, string> => ({
  accepted: m.stateQueued,
  queued: m.stateQueued,
  running: m.stateRunning,
  cancel_requested: m.stateCancelRequested,
  succeeded: m.stateSucceeded,
  failed: m.stateFailed,
  cancelled: m.stateCancelled,
});
const inputError = (): Record<AiInputError, string> => ({
  message_required: m.inputMessageRequired,
  message_too_long: m.inputMessageTooLong(AI_LIMITS.message),
  card_required: m.inputCardRequired,
  one_card: m.inputOneCard,
  too_many_cards: m.inputTooManyCards(AI_LIMITS.cardIds),
  one_board: m.inputOneBoard,
  too_many_boards: m.inputTooManyBoards(AI_LIMITS.boardIds),
  no_board_allowed: m.inputNoBoardAllowed,
  scope_required: m.inputScopeRequired,
  stack_required: m.inputStackRequired,
  stack_not_allowed: m.inputStackNotAllowed,
});

/** Server/Backend error codes that have a better explanation than the generic text. */
function aiError(e: unknown): string {
  if (e instanceof OcsError) {
    switch (e.errorCode) {
      case 'AI_DISABLED':
        return e.kind === 'forbidden' ? m.errDisabledForUser : m.errDisabledByAdmin;
      case 'AI_NOT_CONFIGURED':
        return m.errNotConfigured;
      case 'QUOTA_EXCEEDED':
        return m.errQuota;
      case 'RATE_LIMITED':
        return m.errConcurrency;
      case 'SOURCE_CHANGED':
        return m.errSourceChanged;
      case 'PROPOSAL_EXPIRED':
        return m.errProposalExpired;
      case 'PROPOSAL_NOT_READY':
        return m.errProposalNotReady;
      case 'ACTION_FORBIDDEN':
        return m.errActionForbidden;
      case 'AI_REQUEST_FINISHED':
        return m.errRequestFinished;
      case 'INVALID_STACK':
        return m.errInvalidStack;
      case 'AI_INVALID_SCOPE':
      case 'INVALID_SCOPE':
        return m.errInvalidScope;
    }
    if (e.kind === 'not_found') return m.errNotFound;
  }
  return describeError(e);
}

type Tab = 'new' | 'history';

/**
 * Native AI (gate: `modules.ai`; the tab is not rendered at all when it is off). Requests are
 * personal; answers are model output shown as plain text only (never HTML). Drafts are shown as
 * a proposed-vs-current preview and applied only by an explicit accept (server re-checks EDIT and
 * that the task did not change).
 */
export function AiScreen({ accountId, projectsEnabled, onOpenTask }: { accountId: AccountId; projectsEnabled: boolean; onOpenTask?: (cardId: number) => void }) {
  const { backend } = useServices();
  const status = useAsync(() => backend.aiStatus(accountId), [accountId]);
  const [tab, setTab] = useState<Tab>('new');
  const [open, setOpen] = useState<string | null>(null);
  if (open) {
    return <AiRequestView accountId={accountId} requestId={open} onBack={() => { setOpen(null); status.reload(); }} {...(onOpenTask ? { onOpenTask } : {})} />;
  }
  return (
    <ScrollView contentContainerStyle={{ padding: space(4) }}>
      {status.loading && !status.data ? <Loading /> : null}
      {status.error ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{aiError(status.error)}</Text> : null}
      {status.data ? <StatusCard s={status.data} /> : null}
      <Tabs value={tab} items={[['new', m.tabNew], ['history', m.tabHistory]]} onChange={setTab} />
      {tab === 'new' && status.data ? (
        status.data.enabled && status.data.configured ? (
          projectsEnabled ? (
            <NewRequest accountId={accountId} status={status.data} onCreated={(id) => { status.reload(); setOpen(id); }} />
          ) : (
            <Text style={{ color: colors.muted }}>{m.projectsOff}</Text>
          )
        ) : (
          <Text style={{ color: colors.muted }}>{status.data.enabled ? m.unavailableNotConfigured : m.unavailableDisabled}</Text>
        )
      ) : null}
      {tab === 'history' ? <History accountId={accountId} onOpen={setOpen} /> : null}
    </ScrollView>
  );
}

function StatusCard({ s }: { s: AiStatus }) {
  const q = s.quota;
  return (
    <View style={card} accessibilityLabel={m.statusLabel(s.providerName, q.remainingToday)}>
      <Text style={{ fontWeight: '700' }}>{s.providerName || m.providerFallback}</Text>
      <Text style={{ color: colors.muted, fontSize: font.small }}>
        {m.quotaLine(q.remainingToday, q.dailyLimit, q.inFlight, q.maxConcurrent)}
      </Text>
      <Text style={{ color: colors.muted, fontSize: font.small }}>{m.disclaimer}</Text>
    </View>
  );
}

const SCOPE_OF: Record<AiAction, 'cards' | 'card' | 'board' | 'question' | 'stack'> = {
  card_summary: 'cards',
  board_summary: 'board',
  question: 'question',
  create_card_draft: 'stack',
  update_card_draft: 'card',
  suggest_checklist: 'card',
};

function NewRequest({ accountId, status, onCreated }: { accountId: AccountId; status: AiStatus; onCreated: (requestId: string) => void }) {
  const { backend } = useServices();
  const [action, setAction] = useState<AiAction>('card_summary');
  const [boardId, setBoardId] = useState<number | null>(null);
  const [cards, setCards] = useState<PickedTask[]>([]);
  const [stackId, setStackId] = useState<number | null>(null);
  const [board, setBoard] = useState<BoardPayload | null>(null);
  const [questionOn, setQuestionOn] = useState<'board' | 'cards'>('board');
  const [message, setMessage] = useState('');
  const [comments, setComments] = useState(status.includeCommentsDefault);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const key = useRef(uuid());
  const kind = SCOPE_OF[action];
  const pickAction = (a: AiAction) => {
    setAction(a);
    setCards([]);
    setStackId(null);
    setErr(undefined);
  };
  const build = (): AiRequestInput => {
    const useBoard = kind === 'board' || kind === 'stack' || (kind === 'question' && questionOn === 'board');
    const scope: AiRequestInput['scope'] = {
      cardIds: useBoard ? [] : cards.map((c) => c.id),
      boardIds: useBoard && boardId ? [boardId] : [],
      ...(kind === 'stack' && stackId ? { stackId } : {}),
      ...(comments !== status.includeCommentsDefault ? { includeComments: comments } : {}),
    };
    return { action, scope, ...(message.trim() ? { message: message.trim() } : {}) };
  };
  const send = async () => {
    const input = build();
    const e = aiInputError(input);
    if (e) return setErr(inputError()[e]);
    setErr(undefined);
    setBusy(true);
    try {
      const r = await backend.aiCreate(accountId, input, key.current);
      key.current = uuid();
      if (r) onCreated(r.requestId);
    } catch (x) {
      // Same key only for a retry of an unknown outcome (network/timeout); otherwise the next
      // (possibly edited) request gets a new key so the server does not see a key/body mismatch.
      if (!(x instanceof OcsError && (x.kind === 'network' || x.kind === 'timeout'))) key.current = uuid();
      setErr(aiError(x));
    } finally {
      setBusy(false);
    }
  };
  const needsMessage = action === 'question' || action === 'create_card_draft' || action === 'update_card_draft';
  return (
    <View accessibilityLabel={m.newRequestLabel}>
      <Text style={ui.label}>{m.labelAction}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginBottom: space(3) }}>
        {(Object.keys(AI_ACTION_LABEL) as AiAction[]).map((a) => (
          <Chip key={a} label={AI_ACTION_LABEL[a]} selected={action === a} onPress={() => pickAction(a)} />
        ))}
      </View>
      {AI_DRAFT_ACTIONS.includes(action) ? (
        <Text style={{ color: colors.muted, fontSize: font.small, marginBottom: space(2) }}>{m.draftNotice}</Text>
      ) : null}
      {kind === 'question' ? (
        <View style={{ flexDirection: 'row', gap: space(2), marginBottom: space(2) }}>
          <Chip label={m.scopeWholeProject} selected={questionOn === 'board'} onPress={() => { setQuestionOn('board'); setCards([]); }} />
          <Chip label={m.scopeSelectedTasks} selected={questionOn === 'cards'} onPress={() => setQuestionOn('cards')} />
        </View>
      ) : null}
      <Text style={ui.label}>{kind === 'cards' || (kind === 'question' && questionOn === 'cards') ? m.labelTasksMax(AI_LIMITS.cardIds) : kind === 'card' ? m.labelTask : m.labelProject}</Text>
      {kind === 'board' || kind === 'stack' || (kind === 'question' && questionOn === 'board') ? (
        <>
          <ProjectChips accountId={accountId} value={boardId} onChange={(p) => { setBoardId(p.id); setStackId(null); setBoard(null); }} filter={kind === 'stack' ? (p) => p.edit : undefined} />
          {kind === 'stack' && boardId ? <StackChips accountId={accountId} boardId={boardId} board={board} onBoard={setBoard} value={stackId} onChange={setStackId} /> : null}
        </>
      ) : (
        <TaskPicker accountId={accountId} selected={cards} onChange={setCards} max={kind === 'card' ? 1 : AI_LIMITS.cardIds} />
      )}
      {needsMessage ? (
        <Field
          label={action === 'question' ? m.labelQuestion : m.labelInstruction}
          value={message}
          onChangeText={setMessage}
          multiline
          maxLength={AI_LIMITS.message}
          placeholder={action === 'create_card_draft' ? m.placeholderCreateDraft : action === 'update_card_draft' ? m.placeholderUpdateDraft : m.placeholderQuestion}
        />
      ) : null}
      <View style={{ flexDirection: 'row', marginVertical: space(2) }}>
        <Chip label={m.includeComments} selected={comments} onPress={() => setComments(!comments)} />
      </View>
      {err ? <Text accessibilityRole="alert" style={{ color: colors.danger, marginBottom: space(2) }}>{err}</Text> : null}
      <Button title={t.send} accessibilityLabel={m.sendRequestLabel(AI_ACTION_LABEL[action])} busy={busy} disabled={status.quota.remainingToday === 0} onPress={() => void send()} />
      {status.quota.remainingToday === 0 ? <Text style={{ color: colors.muted, marginTop: space(2) }}>{m.quotaFull}</Text> : null}
    </View>
  );
}

function StackChips({ accountId, boardId, board, onBoard, value, onChange }: { accountId: AccountId; boardId: number; board: BoardPayload | null; onBoard: (b: BoardPayload) => void; value: number | null; onChange: (id: number) => void }) {
  const { backend } = useServices();
  const loaded = useAsync(async () => {
    if (board && board.project.board.id === boardId) return board;
    const b = await backend.board(accountId, boardId);
    onBoard(b);
    return b;
  }, [accountId, boardId]);
  if (loaded.loading && !loaded.data) return <Loading />;
  if (loaded.error) return <Text accessibilityRole="alert" style={{ color: colors.danger }}>{describeError(loaded.error)}</Text>;
  return (
    <>
      <Text style={ui.label}>{m.labelColumn}</Text>
      <View accessibilityLabel={m.labelColumn} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginBottom: space(2) }}>
        {(loaded.data?.project.stacks ?? []).map((s) => (
          <Chip key={s.id} label={s.title} selected={value === s.id} onPress={() => onChange(s.id)} />
        ))}
      </View>
    </>
  );
}

function History({ accountId, onOpen }: { accountId: AccountId; onOpen: (id: string) => void }) {
  const { backend } = useServices();
  const list = useAsync(() => backend.aiRequests(accountId), [accountId]);
  if (list.loading && !list.data) return <Loading />;
  return (
    <View>
      {list.error ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{aiError(list.error)}</Text> : null}
      {list.data && !list.data.length ? <Text style={{ color: colors.muted }}>{m.noRequests}</Text> : null}
      {(list.data ?? []).map((r) => {
        const scope = [r.boardCount ? m.scopeBoards(r.boardCount) : '', r.cardCount ? m.scopeCards(r.cardCount) : ''].filter(Boolean).join(', ');
        return (
          <View key={r.requestId} style={card}>
            <Text style={{ fontWeight: '700' }}>{AI_ACTION_LABEL[r.action] ?? r.action}</Text>
            <Text style={{ color: colors.muted, fontSize: font.small }}>
              {stateLabel()[r.state] ?? r.state} · {dateTime(r.createdAt)}{scope ? ` · ${scope}` : ''}
            </Text>
            <Button title={m.open} kind="secondary" accessibilityLabel={m.openRequestLabel(AI_ACTION_LABEL[r.action] ?? r.action, stateLabel()[r.state] ?? r.state)} onPress={() => onOpen(r.requestId)} />
          </View>
        );
      })}
      <Button title={m.refresh} kind="secondary" onPress={list.reload} />
    </View>
  );
}

function AiRequestView({ accountId, requestId, onBack, onOpenTask }: { accountId: AccountId; requestId: string; onBack: () => void; onOpenTask?: (cardId: number) => void }) {
  const { backend } = useServices();
  const [d, setD] = useState<AiRequestDetail | null>(null);
  const [err, setErr] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = async () => {
    try {
      const next = await backend.aiRequest(accountId, requestId);
      if (!alive.current) return;
      setD(next);
      setErr(undefined);
      // Poll only while this screen is open and the server says the request is active.
      if (isAiActive(next.state)) timer.current = setTimeout(() => void load(), Math.max(1000, next.pollAfterMs ?? 1000));
    } catch (e) {
      if (alive.current) setErr(e);
    }
  };
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, requestId]);
  const cancel = async () => {
    setBusy(true);
    try {
      await backend.aiCancel(accountId, requestId);
      if (timer.current) clearTimeout(timer.current);
      await load();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScrollView contentContainerStyle={{ padding: space(4) }}>
      <Button title={m.backButton} kind="secondary" accessibilityLabel={m.backLabel} onPress={onBack} />
      {err ? <Text accessibilityRole="alert" style={{ color: colors.danger, marginVertical: space(2) }}>{aiError(err)}</Text> : null}
      {!d && !err ? <Loading /> : null}
      {d ? (
        <View style={{ marginTop: space(3) }}>
          <Text accessibilityRole="header" style={{ fontSize: font.title, fontWeight: '700' }}>{AI_ACTION_LABEL[d.action] ?? d.action}</Text>
          <Text accessibilityLiveRegion="polite" style={{ color: colors.muted, marginBottom: space(2) }}>
            {stateLabel()[d.state] ?? d.state} · {dateTime(d.createdAt)}
          </Text>
          {isAiActive(d.state) && d.state !== 'cancel_requested' ? <Button title={m.cancelRequest} kind="danger" busy={busy} onPress={() => void cancel()} /> : null}
          {d.errorCode && d.state !== 'succeeded' ? <Text accessibilityRole="alert" style={{ color: d.state === 'cancelled' ? colors.muted : colors.danger, marginVertical: space(2) }}>{d.errorMessage ?? d.errorCode}</Text> : null}
          {d.restricted ? (
            <Text style={{ color: colors.muted, marginVertical: space(2) }}>{m.restrictedNotice}</Text>
          ) : (
            <>
              {d.message ? (
                <View style={card}>
                  <Text style={ui.label}>{m.yourMessage}</Text>
                  <Text selectable>{d.message}</Text>
                </View>
              ) : null}
              {d.result !== null ? (
                <View style={card} accessibilityLabel={m.answerLabel}>
                  <Text style={ui.label}>{m.answerTitle}</Text>
                  {/* Plain text only: the model output is never interpreted as HTML/markup. */}
                  <Text selectable>{d.result}</Text>
                </View>
              ) : null}
              {d.truncated ? <Text style={{ color: colors.muted, fontSize: font.small }}>{m.contextTruncated(d.omitted)}</Text> : null}
              {d.boards.length || d.sources.length ? (
                <View style={{ marginVertical: space(2) }}>
                  <Text style={ui.label}>{m.sources}</Text>
                  {d.boards.map((b) => <Text key={`b${b.boardId}`}>{m.sourceBoard(b.title)}</Text>)}
                  {d.sources.slice(0, 10).map((s) => (
                    <View key={`c${s.cardId}`} style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), marginBottom: space(1) }}>
                      <Text style={{ flex: 1 }}>{m.sourceTitle(s.title, s.truncated)}</Text>
                      {onOpenTask ? <Button title={m.openTask} kind="secondary" accessibilityLabel={m.openTaskLabel(s.title)} onPress={() => onOpenTask(s.cardId)} /> : null}
                    </View>
                  ))}
                  {d.sources.length > 10 ? <Text style={{ color: colors.muted, fontSize: font.small }}>{m.moreTasks(d.sources.length - 10)}</Text> : null}
                </View>
              ) : null}
              {d.proposal ? <ProposalView accountId={accountId} proposalId={d.proposal.id} {...(onOpenTask ? { onOpenTask } : {})} /> : null}
            </>
          )}
        </View>
      ) : null}
    </ScrollView>
  );
}

const proposalState = (): Record<AiProposal['state'], string> => ({
  ready: m.proposalStateReady,
  accepted: m.proposalStateAccepted,
  dismissed: m.proposalStateDismissed,
  stale: m.proposalStateStale,
  expired: m.proposalStateExpired,
});

function Diff({ label, proposed, current }: { label: string; proposed: string; current?: string | null }) {
  return (
    <View style={{ marginBottom: space(2) }} accessibilityLabel={m.diffLabel(label, proposed, current)}>
      <Text style={ui.label}>{label}</Text>
      {current !== undefined ? <Text style={{ color: colors.muted }}>{m.currentValue(current || '—')}</Text> : null}
      <Text selectable>{m.proposedValue(proposed || '—')}</Text>
    </View>
  );
}

function ProposalView({ accountId, proposalId, onOpenTask }: { accountId: AccountId; proposalId: number; onOpenTask?: (cardId: number) => void }) {
  const { backend } = useServices();
  const p = useAsync(() => backend.aiProposal(accountId, proposalId), [accountId, proposalId]);
  const [busy, setBusy] = useState<'accept' | 'dismiss' | null>(null);
  const [err, setErr] = useState<string>();
  const [applied, setApplied] = useState<number | null>(null);
  const key = useRef(uuid());
  if (p.loading && !p.data) return <Loading />;
  if (p.error) return <Text accessibilityRole="alert" style={{ color: colors.danger }}>{aiError(p.error)}</Text>;
  const x = p.data!;
  const can = proposalActions(x);
  const act = async (what: 'accept' | 'dismiss') => {
    setBusy(what);
    setErr(undefined);
    try {
      if (what === 'accept') {
        const r = await backend.aiAccept(accountId, x.id, x.version, key.current);
        setApplied(r?.cardId ?? aiResultCardId(r?.resultRef));
      } else {
        await backend.aiDismiss(accountId, x.id, x.version);
      }
      p.reload();
    } catch (e) {
      setErr(aiError(e));
      p.reload();
    } finally {
      setBusy(null);
    }
  };
  const f = x.proposed;
  const cardId = applied ?? aiResultCardId(x.resultRef);
  return (
    <View style={card} accessibilityLabel={m.draftLabel}>
      <Text accessibilityRole="header" style={{ fontWeight: '700' }}>{m.proposalHeading(proposalState()[x.state] ?? x.state)}</Text>
      {x.expiresAt && x.state === 'ready' ? <Text style={{ color: colors.muted, fontSize: font.small }}>{m.validUntil(dateTime(x.expiresAt))}</Text> : null}
      {x.restricted ? <Text style={{ color: colors.muted }}>{m.proposalRestricted}</Text> : null}
      {x.target ? (
        <Text style={{ color: colors.muted, marginBottom: space(2) }}>
          {x.target.type === 'stack' ? m.targetColumn(x.target.boardTitle, x.target.stackTitle, x.target.canEdit) : m.targetTask(x.current?.title ?? '', x.target.boardTitle, x.target.canEdit)}
        </Text>
      ) : null}
      {x.stale ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{m.staleNotice}</Text> : null}
      {f ? (
        <>
          {f.title !== undefined ? <Diff label={m.fieldTitle} proposed={f.title} {...(x.current ? { current: x.current.title } : {})} /> : null}
          {f.items?.length ? (
            <View style={{ marginBottom: space(2) }}>
              <Text style={ui.label}>{m.proposedSubtasks}</Text>
              {f.items.map((it, i) => <Text key={i}>☐ {it}</Text>)}
            </View>
          ) : f.description !== undefined ? (
            <Diff label={m.fieldDescription} proposed={f.description} {...(x.current ? { current: x.current.description } : {})} />
          ) : null}
          {f.due !== undefined ? <Diff label={t.due} proposed={f.due ? formatDate(f.due) : ''} {...(x.current ? { current: x.current.due ? formatDate(x.current.due) : '' } : {})} /> : null}
          {f.assignees?.length ? <Text>{m.assigneesList(f.assignees.map((a) => a.displayName).join(', '))}</Text> : null}
          {f.labels?.length ? <Text>{m.labelsList(f.labels.map((l) => l.title).join(', '))}</Text> : null}
        </>
      ) : null}
      {err ? <Text accessibilityRole="alert" style={{ color: colors.danger, marginVertical: space(2) }}>{err}</Text> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginTop: space(2) }}>
        {can.accept ? <Button title={x.action === 'create_card_draft' ? m.createTask : m.applyToTask} busy={busy === 'accept'} disabled={!!busy} onPress={() => void act('accept')} /> : null}
        {can.dismiss ? <Button title={m.reject} kind="secondary" busy={busy === 'dismiss'} disabled={!!busy} onPress={() => void act('dismiss')} /> : null}
        {x.state === 'accepted' && cardId && onOpenTask ? <Button title={m.openTask} kind="secondary" onPress={() => onOpenTask(cardId)} /> : null}
      </View>
    </View>
  );
}
