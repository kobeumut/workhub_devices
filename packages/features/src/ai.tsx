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
import { describeError, formatDate } from './i18n';

/** Hex UUID v4: the server requires a UUID Idempotency-Key for AI create/accept. */
const uuid = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const h = () => Math.floor(Math.random() * 16).toString(16);
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, h);
};
const dateTime = (iso: string | null) => (iso ? `${formatDate(iso)} ${iso.slice(11, 16)}` : '');

export const AI_ACTION_LABEL: Record<AiAction, string> = {
  card_summary: 'Görev özeti',
  board_summary: 'Proje özeti',
  question: 'Soru sor',
  create_card_draft: 'Görev taslağı',
  update_card_draft: 'Görev düzenleme önerisi',
  suggest_checklist: 'Alt iş önerisi',
};
const STATE_LABEL: Record<AiRequestState, string> = {
  accepted: 'Sırada',
  queued: 'Sırada',
  running: 'Çalışıyor',
  cancel_requested: 'İptal ediliyor',
  succeeded: 'Tamamlandı',
  failed: 'Başarısız',
  cancelled: 'İptal edildi',
};
const INPUT_ERROR: Record<AiInputError, string> = {
  message_required: 'Soru veya talimat yazın.',
  message_too_long: `Metin en fazla ${AI_LIMITS.message} karakter olabilir.`,
  card_required: 'En az bir görev seçin.',
  one_card: 'Tam olarak bir görev seçin.',
  too_many_cards: `En çok ${AI_LIMITS.cardIds} görev seçilebilir.`,
  one_board: 'Bir proje seçin.',
  too_many_boards: `En çok ${AI_LIMITS.boardIds} proje seçilebilir.`,
  no_board_allowed: 'Bu işlem yalnız görev kapsamıyla çalışır.',
  scope_required: 'Bir proje veya görev seçin.',
  stack_required: 'Taslağın ekleneceği sütunu seçin.',
  stack_not_allowed: 'Sütun yalnız görev taslağında seçilir.',
};

/** Server/Backend error codes that have a better explanation than the generic text. */
function aiError(e: unknown): string {
  if (e instanceof OcsError) {
    switch (e.errorCode) {
      case 'AI_DISABLED':
        return e.kind === 'forbidden' ? 'AI modülü sizin için kapalı.' : 'AI yönetici tarafından kapatılmış.';
      case 'AI_NOT_CONFIGURED':
        return 'AI sağlayıcısı yapılandırılmamış; yöneticinize başvurun.';
      case 'QUOTA_EXCEEDED':
        return 'Günlük AI kotası doldu; yarın (UTC) yenilenir.';
      case 'RATE_LIMITED':
        return 'Aynı anda çalışabilecek AI isteği sınırına ulaştınız; mevcut isteklerin bitmesini bekleyin.';
      case 'SOURCE_CHANGED':
        return 'Görev, öneri hazırlandıktan sonra değişti; yeni bir öneri isteyin.';
      case 'PROPOSAL_EXPIRED':
        return 'Taslağın süresi doldu; yeni bir öneri isteyin.';
      case 'PROPOSAL_NOT_READY':
        return 'Taslak artık uygulanamaz (kabul edilmiş, reddedilmiş veya süresi dolmuş).';
      case 'ACTION_FORBIDDEN':
        return 'Bu görev/proje üzerinde düzenleme yetkiniz yok.';
      case 'AI_REQUEST_FINISHED':
        return 'İstek zaten bitmiş.';
      case 'INVALID_STACK':
        return 'Sütun seçilen projeye ait değil.';
      case 'AI_INVALID_SCOPE':
      case 'INVALID_SCOPE':
        return 'Seçim bu işlem için uygun değil.';
    }
    if (e.kind === 'not_found') return 'Kayıt bulunamadı ya da kaynaklardan birine artık erişiminiz yok.';
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
      <Tabs value={tab} items={[['new', 'Yeni istek'], ['history', 'Geçmiş']]} onChange={setTab} />
      {tab === 'new' && status.data ? (
        status.data.enabled && status.data.configured ? (
          projectsEnabled ? (
            <NewRequest accountId={accountId} status={status.data} onCreated={(id) => { status.reload(); setOpen(id); }} />
          ) : (
            <Text style={{ color: colors.muted }}>AI istekleri proje ve görev seçimi gerektirir; Projeler modülü sizin için kapalı.</Text>
          )
        ) : (
          <Text style={{ color: colors.muted }}>{status.data.enabled ? 'AI sağlayıcısı yapılandırılmamış; yöneticinize başvurun.' : 'AI yönetici tarafından kapatılmış.'} Eski isteklerinizi Geçmiş'te görebilirsiniz.</Text>
        )
      ) : null}
      {tab === 'history' ? <History accountId={accountId} onOpen={setOpen} /> : null}
    </ScrollView>
  );
}

function StatusCard({ s }: { s: AiStatus }) {
  const q = s.quota;
  return (
    <View style={card} accessibilityLabel={`AI sağlayıcı ${s.providerName || 'yok'}; bugün ${q.remainingToday} istek hakkı kaldı`}>
      <Text style={{ fontWeight: '700' }}>{s.providerName || 'AI'}</Text>
      <Text style={{ color: colors.muted, fontSize: font.small }}>
        Bugün kalan: {q.remainingToday}/{q.dailyLimit} · Çalışan: {q.inFlight}/{q.maxConcurrent}
      </Text>
      <Text style={{ color: colors.muted, fontSize: font.small }}>Yanıtlar yapay zekâ çıktısıdır; doğruluğunu kontrol edin. Seçtiğiniz görevlerin içeriği yöneticinin yapılandırdığı sağlayıcıya gönderilir.</Text>
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
    if (e) return setErr(INPUT_ERROR[e]);
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
    <View accessibilityLabel="Yeni AI isteği">
      <Text style={ui.label}>İşlem</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginBottom: space(3) }}>
        {(Object.keys(AI_ACTION_LABEL) as AiAction[]).map((a) => (
          <Chip key={a} label={AI_ACTION_LABEL[a]} selected={action === a} onPress={() => pickAction(a)} />
        ))}
      </View>
      {AI_DRAFT_ACTIONS.includes(action) ? (
        <Text style={{ color: colors.muted, fontSize: font.small, marginBottom: space(2) }}>Sonuç bir taslaktır; siz onaylamadan görev değişmez.</Text>
      ) : null}
      {kind === 'question' ? (
        <View style={{ flexDirection: 'row', gap: space(2), marginBottom: space(2) }}>
          <Chip label="Projenin tamamı" selected={questionOn === 'board'} onPress={() => { setQuestionOn('board'); setCards([]); }} />
          <Chip label="Seçili görevler" selected={questionOn === 'cards'} onPress={() => setQuestionOn('cards')} />
        </View>
      ) : null}
      <Text style={ui.label}>{kind === 'cards' || (kind === 'question' && questionOn === 'cards') ? `Görevler (en çok ${AI_LIMITS.cardIds})` : kind === 'card' ? 'Görev' : 'Proje'}</Text>
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
          label={action === 'question' ? 'Soru' : 'Talimat'}
          value={message}
          onChangeText={setMessage}
          multiline
          maxLength={AI_LIMITS.message}
          placeholder={action === 'create_card_draft' ? 'ör. Müşteri sunumu için hazırlık görevi' : action === 'update_card_draft' ? 'ör. Açıklamayı netleştir' : 'ör. Gecikme riski olan işler hangileri?'}
        />
      ) : null}
      <View style={{ flexDirection: 'row', marginVertical: space(2) }}>
        <Chip label="Yorumları da gönder" selected={comments} onPress={() => setComments(!comments)} />
      </View>
      {err ? <Text accessibilityRole="alert" style={{ color: colors.danger, marginBottom: space(2) }}>{err}</Text> : null}
      <Button title="Gönder" accessibilityLabel={`${AI_ACTION_LABEL[action]} isteğini gönder`} busy={busy} disabled={status.quota.remainingToday === 0} onPress={() => void send()} />
      {status.quota.remainingToday === 0 ? <Text style={{ color: colors.muted, marginTop: space(2) }}>Günlük kota doldu.</Text> : null}
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
      <Text style={ui.label}>Sütun</Text>
      <View accessibilityLabel="Sütun" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginBottom: space(2) }}>
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
      {list.data && !list.data.length ? <Text style={{ color: colors.muted }}>Henüz AI isteğiniz yok.</Text> : null}
      {(list.data ?? []).map((r) => {
        const scope = [r.boardCount ? `${r.boardCount} proje` : '', r.cardCount ? `${r.cardCount} görev` : ''].filter(Boolean).join(', ');
        return (
          <View key={r.requestId} style={card}>
            <Text style={{ fontWeight: '700' }}>{AI_ACTION_LABEL[r.action] ?? r.action}</Text>
            <Text style={{ color: colors.muted, fontSize: font.small }}>
              {STATE_LABEL[r.state] ?? r.state} · {dateTime(r.createdAt)}{scope ? ` · ${scope}` : ''}
            </Text>
            <Button title="Aç" kind="secondary" accessibilityLabel={`${AI_ACTION_LABEL[r.action] ?? r.action}, ${STATE_LABEL[r.state] ?? r.state}: aç`} onPress={() => onOpen(r.requestId)} />
          </View>
        );
      })}
      <Button title="Yenile" kind="secondary" onPress={list.reload} />
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
      <Button title="‹ AI" kind="secondary" accessibilityLabel="AI listesine dön" onPress={onBack} />
      {err ? <Text accessibilityRole="alert" style={{ color: colors.danger, marginVertical: space(2) }}>{aiError(err)}</Text> : null}
      {!d && !err ? <Loading /> : null}
      {d ? (
        <View style={{ marginTop: space(3) }}>
          <Text accessibilityRole="header" style={{ fontSize: font.title, fontWeight: '700' }}>{AI_ACTION_LABEL[d.action] ?? d.action}</Text>
          <Text accessibilityLiveRegion="polite" style={{ color: colors.muted, marginBottom: space(2) }}>
            {STATE_LABEL[d.state] ?? d.state} · {dateTime(d.createdAt)}
          </Text>
          {isAiActive(d.state) && d.state !== 'cancel_requested' ? <Button title="İsteği iptal et" kind="danger" busy={busy} onPress={() => void cancel()} /> : null}
          {d.errorCode && d.state !== 'succeeded' ? <Text accessibilityRole="alert" style={{ color: d.state === 'cancelled' ? colors.muted : colors.danger, marginVertical: space(2) }}>{d.errorMessage ?? d.errorCode}</Text> : null}
          {d.restricted ? (
            <Text style={{ color: colors.muted, marginVertical: space(2) }}>Kaynaklardan birine artık erişiminiz yok; yanıt ve kaynaklar gizlendi.</Text>
          ) : (
            <>
              {d.message ? (
                <View style={card}>
                  <Text style={ui.label}>Sorunuz / talimatınız</Text>
                  <Text selectable>{d.message}</Text>
                </View>
              ) : null}
              {d.result !== null ? (
                <View style={card} accessibilityLabel="AI yanıtı">
                  <Text style={ui.label}>Yanıt (yapay zekâ çıktısı)</Text>
                  {/* Plain text only: the model output is never interpreted as HTML/markup. */}
                  <Text selectable>{d.result}</Text>
                </View>
              ) : null}
              {d.truncated ? <Text style={{ color: colors.muted, fontSize: font.small }}>Bağlam sağlayıcı sınırına göre kısaltıldı{d.omitted ? ` (${d.omitted} kaynak dışarıda kaldı)` : ''}.</Text> : null}
              {d.boards.length || d.sources.length ? (
                <View style={{ marginVertical: space(2) }}>
                  <Text style={ui.label}>Kaynaklar</Text>
                  {d.boards.map((b) => <Text key={`b${b.boardId}`}>Proje: {b.title}</Text>)}
                  {d.sources.slice(0, 10).map((s) => (
                    <View key={`c${s.cardId}`} style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), marginBottom: space(1) }}>
                      <Text style={{ flex: 1 }}>{s.title}{s.truncated ? ' (kısaltıldı)' : ''}</Text>
                      {onOpenTask ? <Button title="Görevi aç" kind="secondary" accessibilityLabel={`Görevi aç: ${s.title}`} onPress={() => onOpenTask(s.cardId)} /> : null}
                    </View>
                  ))}
                  {d.sources.length > 10 ? <Text style={{ color: colors.muted, fontSize: font.small }}>… ve {d.sources.length - 10} görev daha</Text> : null}
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

const PROPOSAL_STATE: Record<AiProposal['state'], string> = {
  ready: 'Onayınızı bekliyor',
  accepted: 'Uygulandı',
  dismissed: 'Reddedildi',
  stale: 'Eskidi (görev değişti)',
  expired: 'Süresi doldu',
};

function Diff({ label, proposed, current }: { label: string; proposed: string; current?: string | null }) {
  return (
    <View style={{ marginBottom: space(2) }} accessibilityLabel={`${label}: önerilen ${proposed || 'boş'}${current !== undefined ? `, şu anki ${current || 'boş'}` : ''}`}>
      <Text style={ui.label}>{label}</Text>
      {current !== undefined ? <Text style={{ color: colors.muted }}>Şu an: {current || '—'}</Text> : null}
      <Text selectable>Önerilen: {proposed || '—'}</Text>
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
    <View style={card} accessibilityLabel="AI taslağı">
      <Text accessibilityRole="header" style={{ fontWeight: '700' }}>Taslak — {PROPOSAL_STATE[x.state] ?? x.state}</Text>
      {x.expiresAt && x.state === 'ready' ? <Text style={{ color: colors.muted, fontSize: font.small }}>Son geçerlilik: {dateTime(x.expiresAt)}</Text> : null}
      {x.restricted ? <Text style={{ color: colors.muted }}>Hedefe veya kaynaklara artık erişiminiz yok; taslak gösterilemiyor.</Text> : null}
      {x.target ? (
        <Text style={{ color: colors.muted, marginBottom: space(2) }}>
          {x.target.type === 'stack' ? `Hedef: ${x.target.boardTitle} → ${x.target.stackTitle ?? 'silinmiş sütun'}` : `Hedef görev: ${x.current?.title ?? ''} (${x.target.boardTitle})`}
          {x.target.canEdit ? '' : ' — düzenleme yetkiniz yok'}
        </Text>
      ) : null}
      {x.stale ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>Görev, öneri hazırlandıktan sonra değişti; bu taslak uygulanamaz.</Text> : null}
      {f ? (
        <>
          {f.title !== undefined ? <Diff label="Başlık" proposed={f.title} {...(x.current ? { current: x.current.title } : {})} /> : null}
          {f.items?.length ? (
            <View style={{ marginBottom: space(2) }}>
              <Text style={ui.label}>Önerilen alt işler</Text>
              {f.items.map((it, i) => <Text key={i}>☐ {it}</Text>)}
            </View>
          ) : f.description !== undefined ? (
            <Diff label="Açıklama" proposed={f.description} {...(x.current ? { current: x.current.description } : {})} />
          ) : null}
          {f.due !== undefined ? <Diff label="Bitiş" proposed={f.due ? formatDate(f.due) : ''} {...(x.current ? { current: x.current.due ? formatDate(x.current.due) : '' } : {})} /> : null}
          {f.assignees?.length ? <Text>Atananlar: {f.assignees.map((a) => a.displayName).join(', ')}</Text> : null}
          {f.labels?.length ? <Text>Etiketler: {f.labels.map((l) => l.title).join(', ')}</Text> : null}
        </>
      ) : null}
      {err ? <Text accessibilityRole="alert" style={{ color: colors.danger, marginVertical: space(2) }}>{err}</Text> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginTop: space(2) }}>
        {can.accept ? <Button title={x.action === 'create_card_draft' ? 'Görevi oluştur' : 'Göreve uygula'} busy={busy === 'accept'} disabled={!!busy} onPress={() => void act('accept')} /> : null}
        {can.dismiss ? <Button title="Reddet" kind="secondary" busy={busy === 'dismiss'} disabled={!!busy} onPress={() => void act('dismiss')} /> : null}
        {x.state === 'accepted' && cardId && onOpenTask ? <Button title="Görevi aç" kind="secondary" onPress={() => onOpenTask(cardId)} /> : null}
      </View>
    </View>
  );
}
