import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import {
  OcsError, addNode, buildHandoffInput, buildWorkflowPatch, connect, disconnect, graphIssues, handoffCandidates, hasBlockingIssue, removeNode, runProgress,
  sameGraph, setEdgeMode, stepActions, updateNode, workflowActions, WORKFLOW_CATEGORIES, WORKFLOW_LIMITS, WORKFLOW_PLACEHOLDERS,
  type AccountId, type GraphIssue, type WorkflowBoard, type WorkflowCategory, type WorkflowDetail, type WorkflowGraph, type WorkflowHandoff,
  type WorkflowNode, type WorkflowPerson, type WorkflowRun, type WorkflowRunState, type WorkflowStep, type WorkflowStepState,
} from '@workhub-devices/core';
import { useAsync, useServices } from './services';
import { Button, Field, Loading, card, styles as ui } from './ui';
import { Chip } from './taskEdit';
import { Tabs } from './time';
import { SharesEditor } from './projectAdmin';
import { colors, font, space } from './theme';
import { describeError, formatDate } from './i18n';

/** Hex UUID v4 (Idempotency-Key must pass the IPC key check even without crypto.randomUUID). */
const uuid = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const h = () => Math.floor(Math.random() * 16).toString(16);
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, h);
};
const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
const dateTime = (iso: string) => `${formatDate(iso)} ${iso.slice(11, 16)}`;

export const CATEGORY_LABEL: Record<WorkflowCategory, string> = { production: 'Üretim', marketing: 'Pazarlama', custom: 'Özel' };
const ROLE_LABEL = { view: 'görüntüleme', edit: 'düzenleme', manage: 'yönetme' } as const;
export const STEP_STATE: Record<WorkflowStepState, string> = {
  pending_handoff: 'Devir bekliyor',
  open: 'Açık',
  done: 'Tamamlandı',
  failed: 'Başarısız',
  skipped: 'Atlandı',
};
export const RUN_STATE: Record<WorkflowRunState, string> = { running: 'Çalışıyor', completed: 'Tamamlandı', cancelled: 'İptal edildi' };
const STEP_ERROR: Record<string, string> = {
  ACTION_FORBIDDEN: 'adımı tamamlayan kişinin hedef projede düzenleme yetkisi yok',
  NO_SESSION: 'tamamlama oturum dışında yapıldı',
  WORKFLOW_STEP_NO_LIST: 'adımın hedef listesi yok',
  RESOURCE_NOT_FOUND: 'hedef liste bulunamadı',
};

export function workflowError(e: unknown): string {
  if (e instanceof OcsError) {
    switch (e.errorCode) {
      case 'VERSION_CONFLICT':
        return 'İş akışı bu arada değişti; güncel hali yüklendi. Tekrar deneyin.';
      case 'WORKFLOW_EDIT_REQUIRED':
        return 'Bu iş akışında düzenleme yetkiniz yok.';
      case 'WORKFLOW_MANAGE_REQUIRED':
        return 'Bu işlem yalnız iş akışı sahibi veya yönetme yetkisi olanlar içindir.';
      case 'WORKFLOW_DISABLED':
        return 'İş akışı devre dışı; çalıştırmadan önce etkinleştirin.';
      case 'WORKFLOW_NO_ENTRY':
        return 'İş akışının ilk adımı yok; Adımlar bölümünde başlangıcı bir adıma bağlayın.';
      case 'WORKFLOW_STEP_NO_LIST':
        return 'Adımın hedef listesi yok; Adımlar bölümünde bir liste seçin.';
      case 'WORKFLOW_STEP_HANDLED':
        return 'Bu adım zaten işlendi; liste yenilendi.';
      case 'WORKFLOW_RUN_FINISHED':
        return 'Çalıştırma zaten bitti.';
      case 'WORKFLOW_CARD_BOUND':
        return 'Bu kart zaten bir iş akışı çalıştırmasına bağlı.';
      case 'WORKFLOW_CARD_DONE':
        return 'Tamamlanmış bir kartla çalıştırma başlatılamaz.';
      case 'WORKFLOW_ASSIGNEE_NOT_ALLOWED':
        return 'Bu adım yalnız iş akışında tanımlı kişilerden birine devredilebilir.';
      case 'WORKFLOW_ASSIGNEE_FIXED':
        return 'Bu adımın sorumluları sabit; kişi seçilemez.';
      case 'INVALID_GRAPH':
        return `Adımlar kaydedilemedi: ${e.ocsMessage ?? 'grafik geçersiz'}`;
      case 'INVALID_ASSIGNEE':
        return `Sorumlu hedef projenin üyesi değil: ${e.ocsMessage ?? ''}`.trim();
      case 'EMPTY_PATCH':
        return 'Değişiklik yok.';
      case 'FIELD_REQUIRED':
        return 'Başlık gerekli.';
      case 'ACTION_FORBIDDEN':
        return 'Bu işlem için yetkiniz yok (önceki adımı bitiren, çalıştırmayı başlatan veya iş akışı düzenleyicisi olmalısınız; kart oluşturmak için hedef projede düzenleme yetkisi gerekir).';
      case 'PROJECTS_DISABLED':
        return 'Projeler modülü sizin için kapalı.';
    }
    if (e.kind === 'not_found') return 'İş akışı bulunamadı ya da artık erişiminiz yok.';
    if (e.kind === 'forbidden') return 'Bu işlem için yetkiniz yok.';
    if (e.kind === 'client' && e.ocsMessage) return e.ocsMessage;
  }
  return describeError(e);
}

function Alert({ text, ok }: { text?: string | undefined; ok?: boolean | undefined }) {
  return text ? <Text accessibilityRole="alert" style={{ color: ok ? colors.ok : colors.danger, marginVertical: space(1) }}>{text}</Text> : null;
}
function H({ children }: { children: string }) {
  return <Text accessibilityRole="header" style={{ fontWeight: '700', color: colors.text, marginBottom: space(2) }}>{children}</Text>;
}
const Muted = ({ children }: { children: string }) => <Text style={{ color: colors.muted, fontSize: font.small }}>{children}</Text>;
const reloadWorthy = (e: unknown) => e instanceof OcsError && (e.kind === 'conflict' || e.kind === 'not_found');

type Tab = 'pending' | 'templates';

/**
 * Native workflows (İşler → İş akışları): steps waiting for the user (hand-off / retry / skip),
 * templates (create from a blank canvas or a sample, header edit, step editor, enable, share,
 * delete) and runs (start, history, step actions, cancel). Every action is offered only when the
 * server's role/step flags allow it; the server re-checks.
 */
export function WorkflowsScreen({ accountId, onOpenTask }: { accountId: AccountId; onOpenTask?: (cardId: number) => void }) {
  const { backend } = useServices();
  const [tab, setTab] = useState<Tab>('pending');
  const [open, setOpen] = useState<number | null>(null);
  const list = useAsync(() => backend.workflows(accountId), [accountId]);
  if (open !== null) {
    return (
      <ScrollView contentContainerStyle={{ padding: space(3) }}>
        <WorkflowDetailView accountId={accountId} id={open} onChanged={list.reload} onClose={() => setOpen(null)} {...(onOpenTask ? { onOpenTask } : {})} />
      </ScrollView>
    );
  }
  const pending = list.data?.pendingHandoffs ?? 0;
  return (
    <ScrollView contentContainerStyle={{ padding: space(3) }}>
      <Tabs value={tab} items={[['pending', `Sizi bekleyenler${pending ? ` (${pending})` : ''}`], ['templates', 'Şablonlar']]} onChange={setTab} />
      {tab === 'pending' ? <HandoffList accountId={accountId} onChanged={list.reload} {...(onOpenTask ? { onOpenTask } : {})} /> : null}
      {tab === 'templates' ? (
        <>
          {list.error ? <Alert text={workflowError(list.error)} /> : null}
          {list.loading && !list.data ? <Loading /> : null}
          {list.data && list.data.workflows.length === 0 ? <Text style={{ color: colors.muted, marginBottom: space(3) }}>İş akışı yok.</Text> : null}
          {(list.data?.workflows ?? []).map((w) => (
            <View key={w.id} style={card}>
              <Text style={{ fontWeight: '700', color: colors.text }}>{w.title}{w.enabled ? '' : ' (devre dışı)'}</Text>
              <Muted>
                {`${CATEGORY_LABEL[w.category] ?? w.category} · ${w.stepCount} adım · ${w.startMode === 'auto' ? 'otomatik başlar' : 'elle başlar'} · ${w.runs.running} çalışıyor, ${w.runs.completed} tamamlandı`}
              </Muted>
              <Muted>{`${w.owner.displayName} · ${ROLE_LABEL[w.role]} yetkisi`}</Muted>
              <Button title="Aç" accessibilityLabel={`İş akışı: ${w.title}`} kind="secondary" onPress={() => setOpen(w.id)} />
            </View>
          ))}
          <CreateWorkflow accountId={accountId} onCreated={(id) => { list.reload(); setOpen(id); }} />
        </>
      ) : null}
    </ScrollView>
  );
}

function CreateWorkflow({ accountId, onCreated }: { accountId: AccountId; onCreated: (id: number) => void }) {
  const { backend } = useServices();
  const samples = useAsync(() => backend.workflowSamples(accountId), [accountId]);
  const [title, setTitle] = useState('');
  const [from, setFrom] = useState<string>('blank');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [key, setKey] = useState(uuid);
  const sample = samples.data?.items.find((s) => s.id === from);
  const create = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const d = await backend.workflowCreate(accountId, { title: title.trim(), category: sample?.category ?? 'custom', ...(sample ? { graph: sample.graph, description: sample.description } : {}) }, key);
      setTitle('');
      setKey(uuid());
      if (d) onCreated(d.id);
    } catch (e) {
      setErr(workflowError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={card}>
      <H>Yeni iş akışı</H>
      <TextInput accessibilityLabel="İş akışı başlığı" placeholder="Başlık" placeholderTextColor={colors.muted} value={title} onChangeText={setTitle} maxLength={WORKFLOW_LIMITS.title} style={[ui.input, { marginBottom: space(2) }]} />
      <Text style={ui.label}>Başlangıç noktası</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginBottom: space(2) }}>
        <Chip label="Boş tuval" selected={from === 'blank'} onPress={() => setFrom('blank')} />
        {(samples.data?.items ?? []).map((s) => (
          <Chip key={s.id} label={`Örnek: ${s.title}`} selected={from === s.id} onPress={() => setFrom(s.id)} />
        ))}
      </View>
      {sample ? <Muted>{`${sample.description} Adımların listesini ve sorumlularını oluşturduktan sonra Adımlar bölümünde seçin.`}</Muted> : null}
      {samples.error ? <Alert text={workflowError(samples.error)} /> : null}
      <Alert text={err} />
      <Button title="İş akışı oluştur" busy={busy} disabled={!title.trim()} onPress={() => void create()} />
    </View>
  );
}

// ---- Steps waiting for the user ---------------------------------------------------------------

function HandoffList({ accountId, onChanged, onOpenTask }: { accountId: AccountId; onChanged: () => void; onOpenTask?: (cardId: number) => void }) {
  const { backend } = useServices();
  const items = useAsync(() => backend.workflowHandoffs(accountId), [accountId]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  return (
    <View>
      <Muted>Tamamladığınız kartlardan doğan devirler, başlattığınız çalıştırmalar ve düzenlediğiniz iş akışlarındaki başarısız adımlar.</Muted>
      {msg ? <Alert text={msg.text} ok={msg.ok} /> : null}
      {items.error ? <Alert text={workflowError(items.error)} /> : null}
      {items.loading && !items.data ? <Loading /> : null}
      {items.data && items.data.length === 0 ? <Text style={{ color: colors.muted, marginVertical: space(3) }}>Sizi bekleyen adım yok.</Text> : null}
      {(items.data ?? []).map((h) => (
        <HandoffItem
          key={h.step.id}
          accountId={accountId}
          item={h}
          {...(onOpenTask ? { onOpenTask } : {})}
          onDone={(text, ok) => {
            setMsg({ ok, text });
            items.reload();
            onChanged();
          }}
        />
      ))}
    </View>
  );
}

function HandoffItem({ accountId, item, onDone, onOpenTask }: { accountId: AccountId; item: WorkflowHandoff; onDone: (text: string, ok: boolean) => void; onOpenTask?: (cardId: number) => void }) {
  const { step, run, sourceCard } = item;
  return (
    <View style={card}>
      <Text style={{ fontWeight: '700', color: colors.text }}>{`${step.label} · ${run.title}`}</Text>
      <Muted>{`${run.workflowTitle} · ${STEP_STATE[step.state]}`}</Muted>
      {sourceCard ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`Önceki kart: ${sourceCard.title}`} onPress={onOpenTask ? () => onOpenTask(sourceCard.id) : undefined}>
          <Text style={{ color: onOpenTask ? colors.primary : colors.muted, marginTop: space(1) }}>{`Önceki kart: ${sourceCard.title}${sourceCard.done ? ' ✓' : ''}`}</Text>
        </Pressable>
      ) : null}
      <StepActions accountId={accountId} runId={run.id} runState="running" step={step} onDone={onDone} />
    </View>
  );
}

/**
 * Hand over (pending) / retry (failed) / skip one step. The form starts from the server preview;
 * only changed fields are sent. One Idempotency-Key per opened form, so a lost response can be retried.
 */
function StepActions({ accountId, runId, runState, step, onDone }: { accountId: AccountId; runId: number; runState: WorkflowRunState; step: WorkflowStep; onDone: (text: string, ok: boolean) => void }) {
  const { backend } = useServices();
  const actions = stepActions({ state: runState }, step);
  const [mode, setMode] = useState<'none' | 'handoff' | 'skip'>('none');
  const [assignee, setAssignee] = useState<string | null>(null);
  const [title, setTitle] = useState(step.preview?.title ?? '');
  const [description, setDescription] = useState(step.preview?.description ?? '');
  const [due, setDue] = useState(step.preview?.dueDate?.slice(0, 10) ?? '');
  const [reason, setReason] = useState('');
  const [key] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const choose = step.node?.assigneeMode === 'choose';
  const boardId = step.node?.boardId ?? null;
  const needMembers = choose && !!step.node && step.node.assignees.length === 0 && boardId !== null && mode === 'handoff';
  const members = useAsync(async () => (needMembers ? (await backend.board(accountId, boardId!)).project.members : []), [accountId, boardId, needMembers]);
  if (!actions.skip) return null;
  const candidates: WorkflowPerson[] = handoffCandidates(step.node, members.data ?? []);
  const submit = async () => {
    if (due.trim() && !isDay(due.trim())) return setErr('Bitiş tarihini YYYY-AA-GG biçiminde girin.');
    setBusy(true);
    setErr(undefined);
    try {
      if (mode === 'skip') {
        await backend.workflowSkip(accountId, runId, step.id, reason.trim());
        onDone(`"${step.label}" atlandı.`, true);
      } else {
        await backend.workflowHandoff(accountId, runId, step.id, buildHandoffInput(step, { assigneeUid: assignee, title, description, dueDate: due }), key);
        onDone(actions.retry ? `"${step.label}" yeniden denendi; kart oluşturuldu.` : `"${step.label}" devredildi; kart oluşturuldu.`, true);
      }
      setMode('none');
    } catch (e) {
      setErr(workflowError(e));
      if (reloadWorthy(e)) onDone(workflowError(e), false);
    } finally {
      setBusy(false);
    }
  };
  if (mode === 'none') {
    return (
      <View style={{ marginTop: space(1) }}>
        {step.state === 'failed' ? <Text style={{ color: colors.danger }}>{`Otomatik kart oluşturulamadı: ${STEP_ERROR[step.error ?? ''] ?? step.error ?? 'bilinmeyen hata'}`}</Text> : null}
        <View style={{ flexDirection: 'row', gap: space(2) }}>
          <View style={{ flex: 1 }}>
            <Button title={actions.retry ? 'Yeniden dene' : 'Devret'} accessibilityLabel={`${step.label}: ${actions.retry ? 'yeniden dene' : 'devret'}`} onPress={() => setMode('handoff')} />
          </View>
          <View style={{ flex: 1 }}>
            <Button title="Atla" accessibilityLabel={`${step.label}: atla`} kind="secondary" onPress={() => setMode('skip')} />
          </View>
        </View>
      </View>
    );
  }
  return (
    <View style={{ marginTop: space(2) }}>
      {mode === 'skip' ? (
        <>
          <Field label="Atlama nedeni (isteğe bağlı)" value={reason} onChangeText={setReason} maxLength={WORKFLOW_LIMITS.skipReason} />
          <Muted>Adım için kart oluşturulmaz; diğer adımlar bittiğinde çalıştırma tamamlanır.</Muted>
        </>
      ) : (
        <>
          {choose ? (
            <>
              <Text style={ui.label}>Sorumlu</Text>
              {members.loading && needMembers ? <Loading /> : null}
              {members.error ? <Alert text={workflowError(members.error)} /> : null}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginBottom: space(2) }}>
                {candidates.map((p) => (
                  <Chip key={p.uid} label={p.displayName} selected={assignee === p.uid} onPress={() => setAssignee(assignee === p.uid ? null : p.uid)} />
                ))}
              </View>
              {!assignee ? <Muted>Kişi seçmezseniz kart atanmadan oluşturulur.</Muted> : null}
            </>
          ) : (
            <Muted>{`Sorumlular sabit: ${step.node?.assignees.map((p) => p.displayName).join(', ') || 'atanmamış'}`}</Muted>
          )}
          <Field label="Kart başlığı" value={title} onChangeText={setTitle} maxLength={WORKFLOW_LIMITS.stepTitle} />
          <Field label="Açıklama" value={description} onChangeText={setDescription} maxLength={WORKFLOW_LIMITS.stepDescription} multiline style={{ minHeight: 60, paddingTop: 10 }} />
          <Field label="Bitiş tarihi (YYYY-AA-GG, boş = yok)" value={due} onChangeText={setDue} maxLength={10} />
        </>
      )}
      <Alert text={err} />
      <View style={{ flexDirection: 'row', gap: space(2) }}>
        <View style={{ flex: 1 }}>
          <Button
            title={mode === 'skip' ? 'Evet, atla' : actions.retry ? 'Yeniden dene ve kartı oluştur' : 'Devret ve kartı oluştur'}
            kind={mode === 'skip' ? 'danger' : 'primary'}
            busy={busy}
            onPress={() => void submit()}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button title="Vazgeç" kind="secondary" disabled={busy} onPress={() => setMode('none')} />
        </View>
      </View>
    </View>
  );
}

// ---- Template detail ---------------------------------------------------------------------------

type Panel = 'none' | 'edit' | 'steps' | 'start' | 'share' | 'delete';

export function WorkflowDetailView({ accountId, id, onChanged, onClose, onOpenTask }: { accountId: AccountId; id: number; onChanged: () => void; onClose: () => void; onOpenTask?: (cardId: number) => void }) {
  const { backend } = useServices();
  const detail = useAsync(() => backend.workflow(accountId, id), [accountId, id]);
  const [panel, setPanel] = useState<Panel>('none');
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [runsTick, setRunsTick] = useState(0);
  const [openRun, setOpenRun] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const w = detail.data;
  const done = (text: string, close = true) => {
    setMsg({ ok: true, text });
    detail.reload();
    onChanged();
    if (close) setPanel('none');
  };
  const failed = (e: unknown) => {
    setMsg({ ok: false, text: workflowError(e) });
    if (reloadWorthy(e)) {
      detail.reload();
      onChanged();
    }
  };
  if (detail.loading && !w) return <Loading />;
  if (!w) {
    return (
      <View style={card}>
        <Alert text={workflowError(detail.error)} />
        <Button title="‹ İş akışları" kind="secondary" onPress={onClose} />
      </View>
    );
  }
  const actions = workflowActions(w);
  const issues = graphIssues(w.graph, w.placeholders);
  const toggleEnabled = async () => {
    setBusy(true);
    try {
      await backend.workflowUpdate(accountId, w.id, { version: w.version, enabled: !w.enabled });
      done(w.enabled ? 'İş akışı devre dışı bırakıldı.' : 'İş akışı etkinleştirildi.');
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await backend.workflowDelete(accountId, w.id, w.version);
      onChanged();
      onClose();
    } catch (e) {
      failed(e);
      setBusy(false);
    }
  };
  const toggle = (p: Panel) => setPanel(panel === p ? 'none' : p);
  return (
    <View>
      <View style={card}>
        <Button title="‹ İş akışları" kind="secondary" onPress={onClose} />
        <Text accessibilityRole="header" style={{ fontSize: font.title, fontWeight: '700', color: colors.text, marginTop: space(2) }}>{w.title}</Text>
        <Muted>{`${CATEGORY_LABEL[w.category] ?? w.category} · ${w.enabled ? 'etkin' : 'devre dışı'} · ${w.startMode === 'auto' ? 'listeye eklenen yeni kartla otomatik başlar' : 'elle başlar'}`}</Muted>
        <Muted>{`Sahip: ${w.owner.displayName} · yetkiniz: ${ROLE_LABEL[w.role]} · ${w.stepCount} adım · ${w.runs.running} çalışıyor, ${w.runs.completed} tamamlandı`}</Muted>
        {w.description ? <Text style={{ color: colors.text, marginTop: space(2) }}>{w.description}</Text> : null}
        <IssueList issues={issues} graph={w.graph} />
        {msg ? <Alert text={msg.text} ok={msg.ok} /> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginTop: space(2) }}>
          {actions.start ? <Button title="Çalıştırmayı başlat" onPress={() => toggle('start')} /> : null}
          <Button title={actions.edit ? 'Adımlar' : 'Adımları göster'} kind="secondary" onPress={() => toggle('steps')} />
          {actions.edit ? <Button title="Düzenle" kind="secondary" onPress={() => toggle('edit')} /> : null}
          {actions.edit ? <Button title={w.enabled ? 'Devre dışı bırak' : 'Etkinleştir'} kind="secondary" busy={busy} onPress={() => void toggleEnabled()} /> : null}
          {actions.share ? <Button title="Paylaş" kind="secondary" onPress={() => toggle('share')} /> : null}
          {actions.remove ? <Button title="Sil" kind="danger" onPress={() => toggle('delete')} /> : null}
        </View>
        {!w.enabled ? <Muted>Devre dışı iş akışı başlatılamaz; çalışanlar devam eder.</Muted> : null}
      </View>
      {panel === 'edit' ? <HeaderEditor accountId={accountId} w={w} onSaved={() => done('İş akışı kaydedildi.')} onFailed={failed} onCancel={() => setPanel('none')} /> : null}
      {panel === 'steps' ? (
        actions.edit ? (
          <GraphEditor key={w.version} accountId={accountId} w={w} onSaved={() => done('Adımlar kaydedildi.', false)} onFailed={failed} onClose={() => setPanel('none')} />
        ) : (
          <GraphView w={w} />
        )
      ) : null}
      {panel === 'start' ? (
        <StartRunForm
          accountId={accountId}
          w={w}
          onCancel={() => setPanel('none')}
          onStarted={(run) => {
            done(`Çalıştırma başlatıldı: ${run.title}`);
            setRunsTick((x) => x + 1);
            setOpenRun(run.id);
          }}
          onFailed={failed}
        />
      ) : null}
      {panel === 'share' ? <SharesEditor accountId={accountId} type="workflow" objectId={w.id} onClose={() => setPanel('none')} /> : null}
      {panel === 'delete' ? (
        <View style={card}>
          <Text style={{ color: colors.text }}>İş akışı silinsin mi? Çalışan çalıştırmalar iptal edilir; oluşturulan kartlar projelerde kalır.</Text>
          <View style={{ flexDirection: 'row', gap: space(2) }}>
            <View style={{ flex: 1 }}>
              <Button title="Evet, sil" kind="danger" busy={busy} onPress={() => void remove()} />
            </View>
            <View style={{ flex: 1 }}>
              <Button title="Vazgeç" kind="secondary" onPress={() => setPanel('none')} />
            </View>
          </View>
        </View>
      ) : null}
      <RunList
        key={runsTick}
        accountId={accountId}
        workflowId={w.id}
        open={openRun}
        onOpen={setOpenRun}
        onChanged={() => {
          detail.reload();
          onChanged();
        }}
        {...(onOpenTask ? { onOpenTask } : {})}
      />
    </View>
  );
}

const ISSUE_TEXT = (i: GraphIssue, label: (id: string) => string, edgeLabel: (id: string) => string): string => {
  switch (i.code) {
    case 'no_entry':
      return 'İlk adım yok: başlangıcı bir adıma bağlayın.';
    case 'no_list':
      return `"${label(i.nodeId)}" adımının hedef listesi yok.`;
    case 'unreachable':
      return `"${label(i.nodeId)}" adımına başlangıçtan ulaşılamıyor.`;
    case 'cycle':
      return 'Adımlar döngü oluşturuyor; bir çalıştırma bitebilmeli.';
    case 'auto_to_choose':
      return `${edgeLabel(i.edgeId)}: sorumlusu seçilen adıma yalnız devirle (✋) gidilebilir.`;
    case 'auto_start_no_list':
      return 'Otomatik başlangıç için yeni kartların ekleneceği listeyi seçin.';
    case 'unknown_placeholder':
      return `"${label(i.nodeId)}": bilinmeyen yer tutucu ${i.names.map((n) => `{{${n}}}`).join(', ')} (kartta olduğu gibi kalır).`;
    case 'too_many_nodes':
      return `En fazla ${WORKFLOW_LIMITS.nodes} adım olabilir.`;
    case 'too_many_edges':
      return `En fazla ${WORKFLOW_LIMITS.edges} bağlantı olabilir.`;
    case 'empty_label':
      return 'Her adımın bir adı olmalı.';
  }
};

function IssueList({ issues, graph }: { issues: GraphIssue[]; graph: WorkflowGraph }) {
  if (!issues.length) return null;
  const label = (id: string) => graph.nodes.find((n) => n.id === id)?.label || id;
  const edgeLabel = (id: string) => {
    const e = graph.edges.find((x) => x.id === id);
    return e ? `${label(e.from)} → ${label(e.to)}` : id;
  };
  return (
    <View accessibilityRole="summary" style={{ marginTop: space(2), padding: space(2), backgroundColor: '#fff8e1', borderRadius: 8 }}>
      <Text style={{ fontWeight: '600', color: colors.text }}>{`Sorunlar (${issues.length})`}</Text>
      {issues.map((i, n) => (
        <Text key={n} style={{ color: colors.text, fontSize: font.small }}>{`• ${ISSUE_TEXT(i, label, edgeLabel)}`}</Text>
      ))}
    </View>
  );
}

function HeaderEditor({ accountId, w, onSaved, onFailed, onCancel }: { accountId: AccountId; w: WorkflowDetail; onSaved: () => void; onFailed: (e: unknown) => void; onCancel: () => void }) {
  const { backend } = useServices();
  const [title, setTitle] = useState(w.title);
  const [description, setDescription] = useState(w.description);
  const [category, setCategory] = useState<WorkflowCategory>(w.category);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const patch = buildWorkflowPatch(w, { title, description, category, enabled: w.enabled });
    if (!patch) return onCancel();
    setBusy(true);
    try {
      await backend.workflowUpdate(accountId, w.id, patch);
      onSaved();
    } catch (e) {
      onFailed(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={card}>
      <H>İş akışını düzenle</H>
      <Field label="Başlık" value={title} onChangeText={setTitle} maxLength={WORKFLOW_LIMITS.title} />
      <Field label="Açıklama" value={description} onChangeText={setDescription} maxLength={WORKFLOW_LIMITS.description} multiline style={{ minHeight: 60, paddingTop: 10 }} />
      <Text style={ui.label}>Kategori</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginBottom: space(2) }}>
        {WORKFLOW_CATEGORIES.map((c) => (
          <Chip key={c} label={CATEGORY_LABEL[c]} selected={category === c} onPress={() => setCategory(c)} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: space(2) }}>
        <View style={{ flex: 1 }}>
          <Button title="Kaydet" busy={busy} disabled={!title.trim()} onPress={() => void save()} />
        </View>
        <View style={{ flex: 1 }}>
          <Button title="Vazgeç" kind="secondary" disabled={busy} onPress={onCancel} />
        </View>
      </View>
    </View>
  );
}

// ---- Step editor -------------------------------------------------------------------------------

interface BoardInfo {
  title: string;
  stacks: { id: number; title: string }[];
  members: WorkflowPerson[];
}
const boardMap = (boards: WorkflowBoard[]) => new Map<number, BoardInfo>(boards.map((b) => [b.id, { title: b.title, stacks: b.stacks, members: b.members }]));
const boardOfStack = (boards: Map<number, BoardInfo>, stackId: number | null) => {
  if (stackId === null) return null;
  for (const [id, b] of boards) if (b.stacks.some((s) => s.id === stackId)) return id;
  return null;
};
const listLabel = (boards: Map<number, BoardInfo>, stackId: number | null) => {
  const id = boardOfStack(boards, stackId);
  if (id === null) return stackId === null ? 'Liste seçilmedi' : `Liste #${stackId} (erişilemiyor)`;
  const b = boards.get(id)!;
  return `${b.title} / ${b.stacks.find((s) => s.id === stackId)!.title}`;
};

/** Read-only steps for `view` users. */
function GraphView({ w }: { w: WorkflowDetail }) {
  const boards = boardMap(w.boards);
  const label = (id: string) => w.graph.nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <View style={card}>
      <H>Adımlar</H>
      <Muted>{`Başlangıç: ${w.graph.start.mode === 'auto' ? `otomatik (${listLabel(boards, w.graph.start.stackId)})` : 'elle'} → ${w.graph.start.nodeId ? label(w.graph.start.nodeId) : 'ilk adım yok'}`}</Muted>
      {w.graph.nodes.map((n) => (
        <View key={n.id} style={{ marginTop: space(2) }}>
          <Text style={{ fontWeight: '600', color: colors.text }}>{n.label}</Text>
          <Muted>{`${listLabel(boards, n.stackId)} · ${n.assigneeMode === 'choose' ? 'sorumluyu önceki kişi seçer' : `sabit: ${n.assignees.join(', ') || 'atanmamış'}`}${n.dueDays !== null ? ` · ${n.dueDays} gün` : ''}`}</Muted>
          {w.graph.edges.filter((e) => e.from === n.id).map((e) => (
            <Muted key={e.id}>{`  → ${label(e.to)} (${e.mode === 'auto' ? '⚡ otomatik' : '✋ devir'})`}</Muted>
          ))}
        </View>
      ))}
    </View>
  );
}

/**
 * Form-based editor of the template graph (the web editor's canvas positions are kept; new steps
 * are placed to the right). Server rules are mirrored live (loops, auto → chosen step, lists,
 * unknown placeholders); saving sends the whole graph with the template version (409 → reload).
 */
function GraphEditor({ accountId, w, onSaved, onFailed, onClose }: { accountId: AccountId; w: WorkflowDetail; onSaved: () => void; onFailed: (e: unknown) => void; onClose: () => void }) {
  const { backend } = useServices();
  const [g, setG] = useState<WorkflowGraph>(w.graph);
  const [boards, setBoards] = useState(() => boardMap(w.boards));
  const [selected, setSelected] = useState<string | null>(w.graph.nodes[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const issues = graphIssues(g, w.placeholders);
  const dirty = !sameGraph(g, w.graph);
  const loadBoard = async (boardId: number) => {
    if (boards.has(boardId)) return;
    const b = await backend.board(accountId, boardId);
    setBoards((m) => new Map(m).set(boardId, { title: b.project.board.title, stacks: b.project.stacks.map((s) => ({ id: s.id, title: s.title })), members: b.project.members }));
  };
  const save = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      await backend.workflowUpdate(accountId, w.id, { version: w.version, graph: g });
      onSaved();
    } catch (e) {
      onFailed(e);
    } finally {
      setBusy(false);
    }
  };
  const node = g.nodes.find((n) => n.id === selected) ?? null;
  return (
    <View style={card}>
      <H>Adımlar</H>
      <IssueList issues={issues} graph={g} />
      <Text style={[ui.label, { marginTop: space(2) }]}>Başlangıç</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
        <Chip label="Elle başlar" selected={g.start.mode === 'manual'} onPress={() => setG({ ...g, start: { ...g.start, mode: 'manual' } })} />
        <Chip label="Listeye eklenen yeni kartla" selected={g.start.mode === 'auto'} onPress={() => setG({ ...g, start: { ...g.start, mode: 'auto' } })} />
      </View>
      {g.start.mode === 'auto' ? (
        <ListPicker accountId={accountId} label="Tetikleyen liste" boards={boards} stackId={g.start.stackId} loadBoard={loadBoard} onChange={(stackId) => setG({ ...g, start: { ...g.start, stackId } })} />
      ) : null}
      <Text style={[ui.label, { marginTop: space(2) }]}>İlk adım</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
        {g.nodes.map((n) => (
          <Chip key={n.id} label={`İlk adım: ${n.label}`} selected={g.start.nodeId === n.id} onPress={() => setG({ ...g, start: { ...g.start, nodeId: n.id } })} />
        ))}
      </View>
      <Text style={[ui.label, { marginTop: space(3) }]}>Adım seç</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
        {g.nodes.map((n) => (
          <Chip key={n.id} label={`Adım: ${n.label || n.id}`} selected={selected === n.id} onPress={() => setSelected(n.id)} />
        ))}
        {g.nodes.length < WORKFLOW_LIMITS.nodes ? (
          <Chip
            label="+ Adım ekle"
            selected={false}
            onPress={() => {
              const r = addNode(g, `Adım ${g.nodes.length + 1}`);
              setG(r.graph);
              setSelected(r.nodeId);
            }}
          />
        ) : null}
      </View>
      {node ? (
        <NodeEditor
          key={node.id}
          accountId={accountId}
          g={g}
          node={node}
          boards={boards}
          loadBoard={loadBoard}
          placeholders={w.placeholders.length ? w.placeholders : [...WORKFLOW_PLACEHOLDERS]}
          onGraph={setG}
          onNote={setNote}
          onRemoved={() => setSelected(null)}
        />
      ) : null}
      <Alert text={note} />
      <View style={{ flexDirection: 'row', gap: space(2), marginTop: space(2) }}>
        <View style={{ flex: 1 }}>
          <Button title="Adımları kaydet" busy={busy} disabled={!dirty || hasBlockingIssue(issues)} onPress={() => void save()} />
        </View>
        <View style={{ flex: 1 }}>
          <Button title={dirty ? 'Değişiklikleri at' : 'Kapat'} kind="secondary" disabled={busy} onPress={dirty ? () => setG(w.graph) : onClose} />
        </View>
      </View>
    </View>
  );
}

function ListPicker({ accountId, label, boards, stackId, loadBoard, onChange }: {
  accountId: AccountId;
  label: string;
  boards: Map<number, BoardInfo>;
  stackId: number | null;
  loadBoard: (boardId: number) => Promise<void>;
  onChange: (stackId: number | null) => void;
}) {
  const { backend } = useServices();
  const [open, setOpen] = useState(false);
  const [boardId, setBoardId] = useState<number | null>(boardOfStack(boards, stackId));
  const [err, setErr] = useState<string>();
  const projects = useAsync(async () => (open ? (await backend.projects(accountId)).filter((p) => !p.archived) : []), [accountId, open]);
  const pickBoard = async (id: number) => {
    setBoardId(id);
    setErr(undefined);
    try {
      await loadBoard(id);
    } catch (e) {
      setErr(workflowError(e));
    }
  };
  const b = boardId !== null ? boards.get(boardId) : undefined;
  return (
    <View style={{ marginTop: space(2) }}>
      <Text style={ui.label}>{label}</Text>
      <Text style={{ color: stackId === null ? colors.danger : colors.text }}>{listLabel(boards, stackId)}</Text>
      <Button title={open ? 'Liste seçimini kapat' : 'Liste seç'} accessibilityLabel={`${label}: liste seç`} kind="secondary" onPress={() => setOpen(!open)} />
      {open ? (
        <View>
          {projects.loading && !projects.data ? <Loading /> : null}
          {projects.error ? <Alert text={workflowError(projects.error)} /> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginBottom: space(2) }}>
            {(projects.data ?? []).map((p) => (
              <Chip key={p.id} label={`Proje: ${p.title}`} selected={boardId === p.id} onPress={() => void pickBoard(p.id)} />
            ))}
          </View>
          <Alert text={err} />
          {b ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
              {b.stacks.map((s) => (
                <Chip key={s.id} label={`Liste: ${s.title}`} selected={stackId === s.id} onPress={() => { onChange(s.id); setOpen(false); }} />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function NodeEditor({ accountId, g, node, boards, loadBoard, placeholders, onGraph, onNote, onRemoved }: {
  accountId: AccountId;
  g: WorkflowGraph;
  node: WorkflowNode;
  boards: Map<number, BoardInfo>;
  loadBoard: (boardId: number) => Promise<void>;
  placeholders: string[];
  onGraph: (g: WorkflowGraph) => void;
  onNote: (t: string | undefined) => void;
  onRemoved: () => void;
}) {
  const set = (patch: Partial<Omit<WorkflowNode, 'id' | 'type'>>) => onGraph(updateNode(g, node.id, patch));
  const boardId = boardOfStack(boards, node.stackId);
  const members = boardId !== null ? boards.get(boardId)!.members : [];
  const label = (id: string) => g.nodes.find((n) => n.id === id)?.label ?? id;
  const outgoing = g.edges.filter((e) => e.from === node.id);
  const targets = g.nodes.filter((n) => n.id !== node.id && !outgoing.some((e) => e.to === n.id));
  const [dueText, setDueText] = useState(node.dueDays === null ? '' : String(node.dueDays));
  const link = (to: string) => {
    const target = g.nodes.find((n) => n.id === to)!;
    const next = connect(g, node.id, to, target.assigneeMode === 'choose' ? 'manual' : 'auto');
    if (!next) return onNote(`"${node.label}" → "${target.label}" bağlanamaz: döngü oluşur ya da bağlantı sınırı doldu.`);
    onNote(undefined);
    onGraph(next);
  };
  return (
    <View style={{ marginTop: space(3), paddingTop: space(2), borderTopWidth: 1, borderColor: colors.border }}>
      <Field label="Adım adı" value={node.label} onChangeText={(v) => set({ label: v })} maxLength={WORKFLOW_LIMITS.label} />
      <ListPicker accountId={accountId} label="Kartın oluşturulacağı liste" boards={boards} stackId={node.stackId} loadBoard={loadBoard} onChange={(stackId) => set({ stackId, assignees: [] })} />
      <Text style={[ui.label, { marginTop: space(2) }]}>Sorumlu</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
        <Chip label="Sabit kişiler" selected={node.assigneeMode === 'fixed'} onPress={() => set({ assigneeMode: 'fixed' })} />
        <Chip label="Önceki kişi seçer" selected={node.assigneeMode === 'choose'} onPress={() => set({ assigneeMode: 'choose' })} />
      </View>
      <Muted>{node.assigneeMode === 'choose' ? 'İşaretlediğiniz kişilerle sınırlanır; hiçbiri işaretli değilse proje üyelerinden biri seçilir.' : 'Kart her zaman işaretli kişilere atanır.'}</Muted>
      {boardId === null ? <Muted>Kişileri seçmek için önce listeyi seçin.</Muted> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginTop: space(1) }}>
        {members.map((m) => (
          <Chip
            key={m.uid}
            label={m.displayName}
            selected={node.assignees.includes(m.uid)}
            disabled={!node.assignees.includes(m.uid) && node.assignees.length >= WORKFLOW_LIMITS.assignees}
            onPress={() => set({ assignees: node.assignees.includes(m.uid) ? node.assignees.filter((u) => u !== m.uid) : [...node.assignees, m.uid] })}
          />
        ))}
        {node.assignees.filter((u) => !members.some((m) => m.uid === u)).map((u) => (
          <Chip key={u} label={`${u} (proje üyesi değil)`} selected onPress={() => set({ assignees: node.assignees.filter((x) => x !== u) })} />
        ))}
      </View>
      <Field
        label={`Kaç gün sonra bitsin (0–${WORKFLOW_LIMITS.dueDays}, boş = bitiş yok)`}
        value={dueText}
        keyboardType="number-pad"
        maxLength={3}
        onChangeText={(v) => {
          setDueText(v);
          const n = Number(v);
          if (v.trim() === '') set({ dueDays: null });
          else if (Number.isInteger(n) && n >= 0 && n <= WORKFLOW_LIMITS.dueDays) set({ dueDays: n });
        }}
      />
      <Field label="Kart başlığı şablonu" value={node.title} onChangeText={(v) => set({ title: v })} maxLength={WORKFLOW_LIMITS.stepTitle} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(1), marginBottom: space(2) }}>
        {placeholders.map((p) => (
          <Chip key={p} label={`{{${p}}}`} selected={false} onPress={() => set({ title: `${node.title}${node.title && !node.title.endsWith(' ') ? ' ' : ''}{{${p}}}`.slice(0, WORKFLOW_LIMITS.stepTitle) })} />
        ))}
      </View>
      <Field label="Kart açıklaması şablonu" value={node.description} onChangeText={(v) => set({ description: v })} maxLength={WORKFLOW_LIMITS.stepDescription} multiline style={{ minHeight: 60, paddingTop: 10 }} />
      <Text style={ui.label}>Sonraki adımlar</Text>
      {outgoing.length === 0 ? <Muted>Bağlantı yok: bu adım bitince çalıştırma (başka açık adım yoksa) tamamlanır.</Muted> : null}
      {outgoing.map((e) => {
        const choose = g.nodes.find((n) => n.id === e.to)?.assigneeMode === 'choose';
        return (
          <View key={e.id} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space(2), marginBottom: space(1) }}>
            <Text style={{ color: colors.text }}>{`→ ${label(e.to)}`}</Text>
            <Chip label="⚡ Otomatik" selected={e.mode === 'auto'} disabled={choose} onPress={() => { const n = setEdgeMode(g, e.id, 'auto'); if (n) onGraph(n); }} />
            <Chip label="✋ Devir" selected={e.mode === 'manual'} onPress={() => { const n = setEdgeMode(g, e.id, 'manual'); if (n) onGraph(n); }} />
            <Pressable accessibilityRole="button" accessibilityLabel={`Bağlantıyı kaldır: ${node.label} → ${label(e.to)}`} onPress={() => onGraph(disconnect(g, e.id))} style={{ padding: space(1) }}>
              <Text style={{ color: colors.danger }}>Kaldır</Text>
            </Pressable>
          </View>
        );
      })}
      {targets.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginTop: space(1) }}>
          {targets.map((n) => (
            <Chip key={n.id} label={`Şuna bağla: ${n.label}`} selected={false} onPress={() => link(n.id)} />
          ))}
        </View>
      ) : null}
      <Muted>⚡ otomatik: önceki kart tamamlanınca kart hemen, tamamlayan kişi adına açılır. ✋ devir: tamamlayan kişi sorumluyu seçer ve kartı açar.</Muted>
      <Button title="Adımı sil" accessibilityLabel={`Adımı sil: ${node.label}`} kind="danger" onPress={() => { onGraph(removeNode(g, node.id)); onRemoved(); }} />
    </View>
  );
}

// ---- Start a run -------------------------------------------------------------------------------

function StartRunForm({ accountId, w, onStarted, onFailed, onCancel }: { accountId: AccountId; w: WorkflowDetail; onStarted: (r: WorkflowRun) => void; onFailed: (e: unknown) => void; onCancel: () => void }) {
  const { backend } = useServices();
  const entry = w.graph.nodes.find((n) => n.id === w.graph.start.nodeId) ?? null;
  const board = entry?.boardId != null ? w.boards.find((b) => b.id === entry.boardId) : undefined;
  const candidates = entry?.assigneeMode === 'choose' ? (entry.assignees.length ? entry.assignees.map((uid) => board?.members.find((m) => m.uid === uid) ?? { uid, displayName: uid }) : board?.members ?? []) : [];
  const [title, setTitle] = useState('');
  const [cardText, setCardText] = useState('');
  const [assignee, setAssignee] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [due, setDue] = useState('');
  const [key] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const start = async () => {
    const cardId = cardText.trim() ? Number(cardText.trim().replace(/^#/, '')) : undefined;
    if (cardId !== undefined && !(Number.isInteger(cardId) && cardId > 0)) return setErr('Kart numarası pozitif bir tam sayı olmalı.');
    if (due.trim() && !isDay(due.trim())) return setErr('Bitiş tarihini YYYY-AA-GG biçiminde girin.');
    setBusy(true);
    setErr(undefined);
    try {
      const r = await backend.workflowStart(
        accountId,
        w.id,
        {
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(cardId !== undefined ? { cardId } : {}),
          ...(cardId === undefined && assignee ? { assigneeUid: assignee } : {}),
          ...(cardId === undefined && description.trim() ? { description: description.trim() } : {}),
          ...(cardId === undefined && due.trim() ? { dueDate: due.trim() } : {}),
        },
        key,
      );
      if (r) onStarted(r);
    } catch (e) {
      setErr(workflowError(e));
      if (reloadWorthy(e)) onFailed(e);
    } finally {
      setBusy(false);
    }
  };
  const binding = cardText.trim() !== '';
  return (
    <View style={card}>
      <H>Çalıştırmayı başlat</H>
      <Muted>{`İlk adım: ${entry?.label ?? '—'}${entry ? ` (${entry.assigneeMode === 'choose' ? 'sorumluyu siz seçin' : `sabit: ${entry.assignees.join(', ') || 'atanmamış'}`})` : ''}`}</Muted>
      <Field label="Çalıştırma başlığı (boş = iş akışı başlığı)" value={title} onChangeText={setTitle} maxLength={WORKFLOW_LIMITS.title} />
      <Field label="Mevcut kartı bağla (kart no, isteğe bağlı)" value={cardText} onChangeText={setCardText} keyboardType="number-pad" maxLength={12} />
      {binding ? <Muted>Yeni kart açılmaz; açık ve başka çalıştırmaya bağlı olmayan kart ilk adım olur.</Muted> : (
        <>
          {candidates.length ? (
            <>
              <Text style={ui.label}>Sorumlu</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginBottom: space(2) }}>
                {candidates.map((p) => (
                  <Chip key={p.uid} label={p.displayName} selected={assignee === p.uid} onPress={() => setAssignee(assignee === p.uid ? null : p.uid)} />
                ))}
              </View>
            </>
          ) : null}
          <Field label="Açıklama (boş = şablon)" value={description} onChangeText={setDescription} maxLength={WORKFLOW_LIMITS.description} multiline style={{ minHeight: 60, paddingTop: 10 }} />
          <Field label="Bitiş tarihi (YYYY-AA-GG, boş = şablon)" value={due} onChangeText={setDue} maxLength={10} />
        </>
      )}
      <Alert text={err} />
      <View style={{ flexDirection: 'row', gap: space(2) }}>
        <View style={{ flex: 1 }}>
          <Button title="Başlat" busy={busy} onPress={() => void start()} />
        </View>
        <View style={{ flex: 1 }}>
          <Button title="Vazgeç" kind="secondary" disabled={busy} onPress={onCancel} />
        </View>
      </View>
    </View>
  );
}

// ---- Runs --------------------------------------------------------------------------------------

function RunList({ accountId, workflowId, open, onOpen, onChanged, onOpenTask }: {
  accountId: AccountId;
  workflowId: number;
  open: number | null;
  onOpen: (id: number | null) => void;
  onChanged: () => void;
  onOpenTask?: (cardId: number) => void;
}) {
  const { backend } = useServices();
  const runs = useAsync(() => backend.workflowRuns(accountId, workflowId), [accountId, workflowId]);
  return (
    <View style={card}>
      <H>Çalıştırmalar</H>
      <Muted>Son 50 çalıştırma, en yenisi üstte.</Muted>
      {runs.error ? <Alert text={workflowError(runs.error)} /> : null}
      {runs.loading && !runs.data ? <Loading /> : null}
      {runs.data && runs.data.length === 0 ? <Text style={{ color: colors.muted, marginTop: space(2) }}>Henüz çalıştırma yok.</Text> : null}
      {(runs.data ?? []).map((r) => {
        const p = runProgress(r);
        return (
          <View key={r.id} style={{ borderTopWidth: 1, borderColor: colors.border, paddingTop: space(2), marginTop: space(2) }}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Çalıştırma: ${r.title}, ${RUN_STATE[r.state]}`} accessibilityState={{ expanded: open === r.id }} onPress={() => onOpen(open === r.id ? null : r.id)}>
              <Text style={{ fontWeight: '600', color: colors.text }}>{`${open === r.id ? '▾' : '▸'} ${r.title}`}</Text>
              <Muted>{`${RUN_STATE[r.state]} · ${r.startedBy.displayName} · ${dateTime(r.createdAt)} · ${p.done}/${p.total} tamamlandı${p.pending_handoff ? ` · ${p.pending_handoff} devir bekliyor` : ''}${p.failed ? ` · ${p.failed} başarısız` : ''}`}</Muted>
            </Pressable>
            {open === r.id ? (
              <RunDetail
                accountId={accountId}
                runId={r.id}
                onChanged={() => {
                  runs.reload();
                  onChanged();
                }}
                {...(onOpenTask ? { onOpenTask } : {})}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function RunDetail({ accountId, runId, onChanged, onOpenTask }: { accountId: AccountId; runId: number; onChanged: () => void; onOpenTask?: (cardId: number) => void }) {
  const { backend } = useServices();
  const r = useAsync(() => backend.workflowRun(accountId, runId), [accountId, runId]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = r.data;
  if (r.loading && !run) return <Loading />;
  if (!run) return <Alert text={workflowError(r.error)} />;
  const changed = (text: string, ok: boolean) => {
    setMsg({ ok, text });
    r.reload();
    onChanged();
  };
  const cancel = async () => {
    setBusy(true);
    try {
      await backend.workflowCancel(accountId, run.id, run.version);
      setConfirm(false);
      changed('Çalıştırma iptal edildi; açık adımlar atlandı, kartlar projelerde kaldı.', true);
    } catch (e) {
      changed(workflowError(e), false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ marginTop: space(2) }}>
      {run.finishedAt ? <Muted>{`Bitiş: ${dateTime(run.finishedAt)}`}</Muted> : null}
      {msg ? <Alert text={msg.text} ok={msg.ok} /> : null}
      {run.steps.map((s) => (
        <View key={s.id} style={{ paddingVertical: space(2), borderBottomWidth: 1, borderColor: colors.border }}>
          <Text style={{ color: colors.text, fontWeight: '600' }}>{`${s.label} — ${STEP_STATE[s.state]}`}</Text>
          <Muted>
            {[
              s.assignee ? `Sorumlu: ${s.assignee.displayName}` : null,
              s.doneBy ? `Tamamlayan: ${s.doneBy.displayName}` : null,
              s.doneAt ? dateTime(s.doneAt) : null,
            ].filter(Boolean).join(' · ') || ' '}
          </Muted>
          {s.cardId !== null ? (
            s.card ? (
              <Pressable accessibilityRole="button" accessibilityLabel={`Kart: ${s.card.title}. Görevi aç`} onPress={onOpenTask ? () => onOpenTask(s.card!.id) : undefined}>
                <Text style={{ color: onOpenTask ? colors.primary : colors.text }}>{`${s.card.title} · ${s.card.boardTitle} / ${s.card.stackTitle}${s.card.done ? ' ✓' : ''}`}</Text>
              </Pressable>
            ) : (
              <Muted>{`Kart #${s.cardId} (erişiminiz yok)`}</Muted>
            )
          ) : null}
          <StepActions accountId={accountId} runId={run.id} runState={run.state} step={s} onDone={changed} />
        </View>
      ))}
      {run.canManage && run.state === 'running' ? (
        confirm ? (
          <View style={{ marginTop: space(2) }}>
            <Text style={{ color: colors.text }}>Çalıştırma iptal edilsin mi? Açık ve bekleyen adımlar atlanır; kartlar projelerde kalır.</Text>
            <View style={{ flexDirection: 'row', gap: space(2) }}>
              <View style={{ flex: 1 }}>
                <Button title="Evet, iptal et" kind="danger" busy={busy} onPress={() => void cancel()} />
              </View>
              <View style={{ flex: 1 }}>
                <Button title="Vazgeç" kind="secondary" disabled={busy} onPress={() => setConfirm(false)} />
              </View>
            </View>
          </View>
        ) : (
          <Button title="Çalıştırmayı iptal et" kind="danger" onPress={() => setConfirm(true)} />
        )
      ) : null}
    </View>
  );
}

/**
 * Task screen section: hand-offs that stem from THIS card (the web shows them right after the
 * card is completed). Hidden when there are none or the Projects module is off.
 */
export function TaskWorkflowSection({ accountId, cardId }: { accountId: AccountId; cardId: number }) {
  const { backend } = useServices();
  const items = useAsync(() => backend.cardWorkflowHandoffs(accountId, cardId), [accountId, cardId]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  if (!items.data?.length && !msg) return null;
  return (
    <View style={card}>
      <H>İş akışı: sizi bekleyen devirler</H>
      {msg ? <Alert text={msg.text} ok={msg.ok} /> : null}
      {(items.data ?? []).map((h) => (
        <View key={h.step.id} style={{ marginBottom: space(2) }}>
          <Text style={{ color: colors.text, fontWeight: '600' }}>{`${h.step.label} · ${h.run.workflowTitle}`}</Text>
          <StepActions
            accountId={accountId}
            runId={h.run.id}
            runState="running"
            step={h.step}
            onDone={(text, ok) => {
              setMsg({ ok, text });
              items.reload();
            }}
          />
        </View>
      ))}
    </View>
  );
}
