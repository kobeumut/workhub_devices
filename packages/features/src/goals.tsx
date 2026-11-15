import { useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import {
  OcsError, cardSetWithout, goalActions, goalPercent, isManualTarget, normalizeGoalDecimal, GOAL_MAX_SCALE,
  type AccountId, type GoalCheckinInput, type GoalDetail, type GoalListFilter, type GoalPatch, type GoalProgressState, type GoalSummary, type GoalTarget, type GoalTargetInput, type GoalTargetPatch,
} from '@workhub-devices/core';
import { useAsync, useServices } from './services';
import { Button, Field, Loading, card, styles as ui } from './ui';
import { Chip } from './taskEdit';
import { Tabs } from './time';
import { PrincipalPicker, SharesEditor } from './projectAdmin';
import { colors, font, space } from './theme';
import { describeError, formatDate, intlTag, messages, t as common } from './i18n';

const m = messages.goals;

/** Hex UUID v4 (Idempotency-Key must pass the IPC key check even without crypto.randomUUID). */
const uuid = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const h = () => Math.floor(Math.random() * 16).toString(16);
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, h);
};
const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
const dateTime = (iso: string) => `${formatDate(iso)} ${iso.slice(11, 16)}`;

const progressState = (): Record<GoalProgressState, string> => ({
  ok: '',
  not_calculable: m.progressNotCalculable,
  restricted: m.progressRestricted,
  stale: m.progressStale,
  source_missing: m.progressSourceMissing,
});
const typeLabel = (): Record<GoalTarget['type'], string> => ({ number: m.typeNumber, currency: m.typeCurrency, boolean: m.typeBoolean, task: m.typeTask });

export function goalError(e: unknown): string {
  if (e instanceof OcsError) {
    switch (e.errorCode) {
      case 'VERSION_CONFLICT':
        return m.errVersionConflict;
      case 'GOAL_ARCHIVED':
        return m.errGoalArchived;
      case 'GOAL_EDIT_REQUIRED':
        return m.errEditRequired;
      case 'GOAL_MANAGE_REQUIRED':
        return m.errManageRequired;
      case 'GOALS_DISABLED':
        return m.errGoalsDisabled;
      case 'INVALID_OWNER':
        return m.errInvalidOwner;
      case 'INVALID_TARGET_RANGE':
        return m.errTargetRange;
      case 'INVALID_DECIMAL':
        return m.errInvalidDecimal;
      case 'INVALID_CURRENCY':
        return m.errCurrency;
      case 'INVALID_DATE':
        return m.errInvalidDate;
      case 'TARGET_NOT_MANUAL':
        return m.errTargetNotManual;
      case 'CARDS_NOT_READABLE':
        return m.errCardsNotReadable;
      case 'CARDS_NOT_READABLE_BY_OWNER':
        return m.errCardsNotReadableByOwner;
      case 'TOO_MANY_TARGETS':
        return m.errTooManyTargets;
      case 'IDEMPOTENCY_KEY_REUSED':
        return m.errCheckinReused;
    }
    if (e.kind === 'not_found') return m.errGoalNotFound;
    if (e.kind === 'forbidden') return m.errNotAllowed;
    if (e.kind === 'client' && e.ocsMessage) return e.ocsMessage;
  }
  return describeError(e);
}

function Alert({ text, ok }: { text?: string | undefined; ok?: boolean | undefined }) {
  return text ? <Text accessibilityRole="alert" style={{ color: ok ? colors.ok : colors.danger, marginVertical: space(1) }}>{text}</Text> : null;
}

export function ProgressBar({ bp, label }: { bp: number | null; label: string }) {
  const pct = goalPercent(bp);
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={m.progressLabel(label, pct)} style={{ marginTop: space(1) }}>
      <View style={{ height: 8, backgroundColor: colors.surface, borderRadius: 4, overflow: 'hidden' }}>
        <View style={{ height: 8, width: `${Math.min(100, Math.max(0, pct ?? 0))}%`, backgroundColor: colors.primary }} />
      </View>
      <Text style={{ color: colors.muted, fontSize: font.small, marginTop: 2 }}>{pct === null ? '—' : m.percent(pct)}</Text>
    </View>
  );
}

type OwnerTab = GoalListFilter['owner'];

/**
 * Native Goals: list (mine / shared / all, active or archived), create, and a detail with
 * header edit, archive, targets (CRUD), manual check-ins + history, card set, shares, ownership
 * transfer and delete. Every action is shown only when the server's role flags allow it.
 */
export function GoalsScreen({ accountId }: { accountId: AccountId }) {
  const { backend } = useServices();
  const [owner, setOwner] = useState<OwnerTab>('all');
  const [archived, setArchived] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const list = useAsync(() => backend.goals(accountId, { owner, state: archived ? 'archived' : 'active' }), [accountId, owner, archived]);
  const items = list.data ?? [];
  if (open !== null) {
    // Master/detail: the detail stays mounted even when the goal leaves the current filter
    // (archived, reactivated, transferred), so its result message is not lost.
    return (
      <ScrollView contentContainerStyle={{ padding: space(3) }}>
        <View style={card}>
          <GoalDetailView accountId={accountId} id={open} onChanged={list.reload} onClose={() => setOpen(null)} />
        </View>
      </ScrollView>
    );
  }
  return (
    <ScrollView contentContainerStyle={{ padding: space(3) }}>
      <Tabs value={owner} items={[['all', m.tabAll], ['me', m.tabMine], ['shared', m.tabShared]]} onChange={setOwner} />
      <View style={{ flexDirection: 'row', gap: space(2), marginBottom: space(2) }}>
        <Chip label={m.filterActive} selected={!archived} onPress={() => setArchived(false)} />
        <Chip label={m.filterArchived} selected={archived} onPress={() => setArchived(true)} />
      </View>
      {list.error ? <Alert text={goalError(list.error)} /> : null}
      {list.loading && !list.data ? <Loading /> : null}
      {items.length === 0 && !list.loading && !list.error ? <Text style={{ color: colors.muted, marginBottom: space(3) }}>{m.noGoals}</Text> : null}
      {items.map((g) => (
        <View key={g.id} style={card}>
          <Text style={{ fontWeight: '700', color: colors.text }}>{g.title}</Text>
          <Text style={{ color: colors.muted }}>
            {m.goalMeta(g.owner.displayName, g.dueDate ? formatDate(g.dueDate) : null, g.targetCount, g.state === 'archived')}
          </Text>
          <ProgressBar bp={g.progressBp} label={g.title} />
          {g.progressState !== 'ok' ? <Text style={{ color: colors.muted, fontSize: font.small }}>{progressState()[g.progressState] ?? g.progressState}</Text> : null}
          <Button title={m.open} accessibilityLabel={m.openGoalLabel(g.title)} kind="secondary" onPress={() => setOpen(g.id)} />
        </View>
      ))}
      {!archived ? <CreateGoal accountId={accountId} onCreated={(id) => { list.reload(); setOpen(id); }} /> : null}
    </ScrollView>
  );
}

function CreateGoal({ accountId, onCreated }: { accountId: AccountId; onCreated: (id: number) => void }) {
  const { backend } = useServices();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const create = async () => {
    if (due.trim() && !isDay(due.trim())) return setErr(m.errDateFormat);
    setBusy(true);
    setErr(undefined);
    try {
      const g = await backend.goalCreate(accountId, { title: title.trim(), ...(description.trim() ? { description: description.trim() } : {}), ...(due.trim() ? { dueDate: due.trim() } : {}) });
      setTitle('');
      setDescription('');
      setDue('');
      if (g) onCreated(g.id);
    } catch (e) {
      setErr(goalError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={card}>
      <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(2) }}>{m.newGoal}</Text>
      <TextInput accessibilityLabel={m.goalTitleLabel} placeholder={m.title} placeholderTextColor={colors.muted} value={title} onChangeText={setTitle} maxLength={200} style={[ui.input, { marginBottom: space(2) }]} />
      <TextInput accessibilityLabel={m.goalDescriptionLabel} placeholder={m.description} placeholderTextColor={colors.muted} value={description} onChangeText={setDescription} maxLength={4000} multiline style={[ui.input, { minHeight: 60, paddingTop: 10, marginBottom: space(2) }]} />
      <Field label={m.dueOptionalLabel} value={due} onChangeText={setDue} maxLength={10} />
      <Alert text={err} />
      <Button title={m.createGoal} busy={busy} disabled={!title.trim()} onPress={() => void create()} />
    </View>
  );
}

/** Detail: always the fresh server state; a 409/404 reloads it so the user acts on the current version. */
export function GoalDetailView({ accountId, id, onChanged, onClose }: { accountId: AccountId; id: number; onChanged: () => void; onClose: () => void }) {
  const { backend } = useServices();
  const detail = useAsync(() => backend.goalDetail(accountId, id), [accountId, id]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [panel, setPanel] = useState<'none' | 'edit' | 'share' | 'transfer' | 'delete'>('none');
  const g = detail.data;
  /** Runs one write; on success reloads detail + list, on 409/404 reloads too and shows why. */
  const write = async (fn: () => Promise<unknown>, done: string, after?: () => void) => {
    setMsg(undefined);
    try {
      await fn();
      setMsg({ ok: true, text: done });
      detail.reload();
      onChanged();
      after?.();
      return true;
    } catch (e) {
      setMsg({ ok: false, text: goalError(e) });
      if (e instanceof OcsError && (e.kind === 'conflict' || e.kind === 'not_found')) {
        detail.reload();
        onChanged();
      }
      return false;
    }
  };
  if (detail.loading && !g) return <Loading />;
  if (!g) return <><Alert text={goalError(detail.error)} /><Button title={common.close} kind="secondary" onPress={onClose} /></>;
  const a = goalActions(g);
  return (
    <View>
      <Text accessibilityRole="header" style={{ fontSize: font.title, fontWeight: '700', color: colors.text }}>{m.goalHeading(g.title, g.state === 'archived')}</Text>
      <ProgressBar bp={g.progressBp} label={g.title} />
      {g.description ? <Text style={{ color: colors.text }} selectable>{g.description}</Text> : null}
      <Text style={{ color: colors.muted, fontSize: font.small, marginTop: space(1) }}>
        {m.goalDetailMeta(g.owner.displayName, g.role === 'manage' ? m.roleManage : g.role === 'edit' ? m.roleEdit : m.roleView, g.dueDate ? formatDate(g.dueDate) : null)}
      </Text>
      {g.progressState !== 'ok' ? <Text style={{ color: colors.muted, fontSize: font.small }}>{progressState()[g.progressState] ?? g.stateNote}</Text> : null}
      <Alert text={msg?.text} ok={msg?.ok} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
        {a.editHeader ? <Button title={common.edit} accessibilityLabel={m.editLabel(g.title)} kind="secondary" onPress={() => setPanel(panel === 'edit' ? 'none' : 'edit')} /> : null}
        {a.archive ? <Button title={m.archive} accessibilityLabel={m.archiveLabel(g.title)} kind="secondary" onPress={() => void write(() => backend.goalUpdate(accountId, g.id, { version: g.version, state: 'archived' }), m.doneArchived)} /> : null}
        {a.reactivate ? <Button title={m.reactivate} accessibilityLabel={m.reactivateLabel(g.title)} kind="secondary" onPress={() => void write(() => backend.goalUpdate(accountId, g.id, { version: g.version, state: 'active' }), m.doneReactivated)} /> : null}
        {a.share ? <Button title={m.share} accessibilityLabel={m.shareLabel(g.title)} kind="secondary" onPress={() => setPanel(panel === 'share' ? 'none' : 'share')} /> : null}
        {a.transfer ? <Button title={m.transferOwnership} accessibilityLabel={m.transferOwnershipLabel(g.title)} kind="secondary" onPress={() => setPanel(panel === 'transfer' ? 'none' : 'transfer')} /> : null}
        {a.remove ? <Button title={m.deleteAction} accessibilityLabel={m.deleteLabel(g.title)} kind="danger" onPress={() => setPanel(panel === 'delete' ? 'none' : 'delete')} /> : null}
      </View>
      {panel === 'edit' ? <GoalHeaderForm goal={g} onCancel={() => setPanel('none')} onSubmit={(patch) => write(() => backend.goalUpdate(accountId, g.id, patch), m.doneSaved, () => setPanel('none'))} /> : null}
      {panel === 'share' ? <SharesEditor accountId={accountId} type="goal" objectId={g.id} onClose={() => { setPanel('none'); onChanged(); }} /> : null}
      {panel === 'transfer' ? <TransferForm accountId={accountId} goal={g} onCancel={() => setPanel('none')} onSubmit={(uid) => write(() => backend.goalTransfer(accountId, g.id, g.version, uid), m.doneTransferred, () => setPanel('none'))} /> : null}
      {panel === 'delete' ? (
        <View style={{ marginTop: space(2) }}>
          <Text style={{ color: colors.danger }}>{m.deleteGoalWarning}</Text>
          <View style={{ flexDirection: 'row', gap: space(2) }}>
            <Button title={m.confirmDelete} accessibilityLabel={m.confirmDeleteLabel(g.title)} kind="danger" onPress={() => void write(() => backend.goalDelete(accountId, g.id, g.version), m.doneDeleted, onClose)} />
            <Button title={m.cancel} kind="secondary" onPress={() => setPanel('none')} />
          </View>
        </View>
      ) : null}
      <Text accessibilityRole="header" style={{ fontWeight: '700', color: colors.text, marginTop: space(3) }}>{m.targetsHeading}</Text>
      {g.targets.length === 0 ? <Text style={{ color: colors.muted }}>{m.noTargets}</Text> : null}
      {g.targets.map((t) => (
        <TargetCard key={`${t.id}:${t.version}`} accountId={accountId} goal={g} target={t} write={write} />
      ))}
      {a.targets ? <AddTargetForm onSubmit={(input) => write(() => backend.goalTargetAdd(accountId, g.id, input), m.doneTargetAdded)} /> : null}
      {g.state === 'archived' ? <Text style={{ color: colors.muted, marginTop: space(2) }}>{m.archivedNotice}</Text> : null}
      <Button title={m.backToList} kind="secondary" onPress={onClose} />
    </View>
  );
}

type Write = (fn: () => Promise<unknown>, done: string, after?: () => void) => Promise<boolean>;

function GoalHeaderForm({ goal, onSubmit, onCancel }: { goal: GoalDetail; onSubmit: (p: GoalPatch) => Promise<boolean>; onCancel: () => void }) {
  const [title, setTitle] = useState(goal.title);
  const [description, setDescription] = useState(goal.description);
  const [due, setDue] = useState(goal.dueDate ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const save = async () => {
    if (!title.trim()) return setErr(m.errTitleEmpty);
    if (due.trim() && !isDay(due.trim())) return setErr(m.errDateFormat);
    const patch: GoalPatch = { version: goal.version };
    if (title.trim() !== goal.title) patch.title = title.trim();
    if (description.trim() !== goal.description) patch.description = description.trim();
    if ((due.trim() || null) !== goal.dueDate) patch.dueDate = due.trim() || null;
    if (Object.keys(patch).length === 1) return onCancel();
    setErr(undefined);
    setBusy(true);
    await onSubmit(patch);
    setBusy(false);
  };
  return (
    <View style={[card, { marginTop: space(2) }]}>
      <Field label={m.title} value={title} onChangeText={setTitle} maxLength={200} />
      <Text style={ui.label}>{m.description}</Text>
      <TextInput accessibilityLabel={m.description} value={description} onChangeText={setDescription} maxLength={4000} multiline style={[ui.input, { minHeight: 60, paddingTop: 10, marginBottom: space(2) }]} />
      <Field label={m.dueEmptyLabel} value={due} onChangeText={setDue} maxLength={10} />
      <Alert text={err} />
      <View style={{ flexDirection: 'row', gap: space(2) }}>
        <Button title={common.save} busy={busy} onPress={() => void save()} />
        <Button title={m.cancel} kind="secondary" onPress={onCancel} />
      </View>
    </View>
  );
}

function TransferForm({ accountId, goal, onSubmit, onCancel }: { accountId: AccountId; goal: GoalDetail; onSubmit: (uid: string) => Promise<boolean>; onCancel: () => void }) {
  const [to, setTo] = useState<{ uid: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <View style={[card, { marginTop: space(2) }]}>
      <Text style={{ color: colors.text }}>{m.transferHint}</Text>
      {to ? (
        <>
          <Text style={{ color: colors.text, fontWeight: '700', marginTop: space(2) }}>{m.newOwner(to.name)}</Text>
          <View style={{ flexDirection: 'row', gap: space(2) }}>
            <Button title={m.transfer} accessibilityLabel={m.transferLabel(to.name)} busy={busy} onPress={() => { setBusy(true); void onSubmit(to.uid).finally(() => setBusy(false)); }} />
            <Button title={m.anotherPerson} kind="secondary" onPress={() => setTo(null)} />
          </View>
        </>
      ) : (
        <PrincipalPicker accountId={accountId} usersOnly exclude={[`user:${goal.owner.uid}`]} label={m.searchPerson} onPick={(p) => setTo({ uid: p.principalId, name: p.displayName })} />
      )}
      <Button title={m.cancel} kind="secondary" onPress={onCancel} />
    </View>
  );
}

const fmtValue = (t: GoalTarget, v: string | null | undefined) => (v === null || v === undefined ? '—' : `${v.replace('.', m.decimalSeparator)}${t.type === 'currency' && t.currencyCode ? ` ${t.currencyCode}` : ''}`);

function TargetCard({ accountId, goal, target: t, write }: { accountId: AccountId; goal: GoalDetail; target: GoalTarget; write: Write }) {
  const { backend } = useServices();
  const a = goalActions(goal);
  const [panel, setPanel] = useState<'none' | 'checkin' | 'history' | 'edit' | 'delete'>('none');
  return (
    <View style={[card, { backgroundColor: colors.bg }]}>
      <Text style={{ fontWeight: '700', color: colors.text }}>{t.title} <Text style={{ color: colors.muted, fontWeight: '400' }}>· {typeLabel()[t.type]}</Text></Text>
      {t.type === 'number' || t.type === 'currency' ? (
        <Text style={{ color: colors.text }}>{m.targetValues(fmtValue(t, t.current), fmtValue(t, t.target), fmtValue(t, t.start))}</Text>
      ) : null}
      {t.type === 'boolean' ? <Text style={{ color: colors.text }}>{t.booleanValue ? m.completed : m.notCompleted}</Text> : null}
      {t.type === 'task' ? (
        <>
          <Text style={{ color: colors.text }}>
            {m.cardsProgress(t.doneCount ?? '—', t.totalCount ?? '—', t.missingCount)}
          </Text>
          {(t.cards ?? []).map((c) => (
            <View key={c.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), flexWrap: 'wrap' }}>
              <Text style={{ color: colors.text, flexShrink: 1 }}>{c.done ? '✓ ' : '• '}{c.title} <Text style={{ color: colors.muted }}>· {c.boardTitle} / {c.stackTitle}</Text></Text>
              {a.linkCards ? (
                <Button title={m.removeCard} accessibilityLabel={m.removeCardLabel(c.title)} kind="secondary" onPress={() => void write(() => backend.goalSetCards(accountId, goal.id, t.id, t.version, cardSetWithout(t, c.id)), m.doneCardRemoved)} />
              ) : null}
            </View>
          ))}
          {t.totalCount !== null && t.totalCount !== undefined && (t.cards ?? []).length < t.totalCount ? <Text style={{ color: colors.muted, fontSize: font.small }}>{m.hiddenCardsNote}</Text> : null}
          <Text style={{ color: colors.muted, fontSize: font.small }}>{m.addCardsHint}</Text>
        </>
      ) : null}
      <ProgressBar bp={t.progressBp} label={t.title} />
      {t.state !== 'ok' ? <Text style={{ color: colors.muted, fontSize: font.small }}>{progressState()[t.state] ?? t.state}</Text> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
        {a.checkin && isManualTarget(t) ? <Button title={m.checkin} accessibilityLabel={m.checkinLabel(t.title)} onPress={() => setPanel(panel === 'checkin' ? 'none' : 'checkin')} /> : null}
        {isManualTarget(t) ? <Button title={m.history} accessibilityLabel={m.historyLabel(t.title)} kind="secondary" onPress={() => setPanel(panel === 'history' ? 'none' : 'history')} /> : null}
        {a.targets ? <Button title={common.edit} accessibilityLabel={m.editTargetLabel(t.title)} kind="secondary" onPress={() => setPanel(panel === 'edit' ? 'none' : 'edit')} /> : null}
        {a.targets ? <Button title={m.removeTarget} accessibilityLabel={m.removeTargetLabel(t.title)} kind="danger" onPress={() => setPanel(panel === 'delete' ? 'none' : 'delete')} /> : null}
      </View>
      {panel === 'checkin' ? <CheckinForm target={t} onSubmit={(input) => write(() => backend.goalCheckin(accountId, goal.id, t.id, input, uuid()), m.doneCheckin)} /> : null}
      {panel === 'history' ? <CheckinHistory accountId={accountId} goalId={goal.id} target={t} /> : null}
      {panel === 'edit' ? <TargetEditForm target={t} onCancel={() => setPanel('none')} onSubmit={(patch) => write(() => backend.goalTargetUpdate(accountId, goal.id, t.id, patch), m.doneTargetSaved)} /> : null}
      {panel === 'delete' ? (
        <View>
          <Text style={{ color: colors.danger }}>{m.deleteTargetWarning}</Text>
          <View style={{ flexDirection: 'row', gap: space(2) }}>
            <Button title={m.confirmRemove} accessibilityLabel={m.confirmRemoveLabel(t.title)} kind="danger" onPress={() => void write(() => backend.goalTargetDelete(accountId, goal.id, t.id, t.version), m.doneTargetRemoved)} />
            <Button title={m.cancel} kind="secondary" onPress={() => setPanel('none')} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function CheckinForm({ target: t, onSubmit }: { target: GoalTarget; onSubmit: (input: GoalCheckinInput) => Promise<boolean> }) {
  const [mode, setMode] = useState<'absolute' | 'delta'>('absolute');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const send = async (input: GoalCheckinInput) => {
    setErr(undefined);
    setBusy(true);
    if (await onSubmit(input)) {
      setValue('');
      setNote('');
    }
    setBusy(false);
  };
  const noteField = <TextInput accessibilityLabel={m.noteLabel(t.title)} placeholder={m.notePlaceholder} placeholderTextColor={colors.muted} value={note} onChangeText={setNote} maxLength={1000} style={[ui.input, { marginVertical: space(1) }]} />;
  const n = note.trim() ? { note: note.trim() } : {};
  if (t.type === 'boolean') {
    return (
      <View style={{ marginTop: space(1) }}>
        {noteField}
        <View style={{ flexDirection: 'row', gap: space(2) }}>
          <Button title={m.completed} accessibilityLabel={m.completedLabel(t.title)} busy={busy} disabled={t.booleanValue === true} onPress={() => void send({ version: t.version, value: true, ...n })} />
          <Button title={m.notCompleted} accessibilityLabel={m.notCompletedLabel(t.title)} kind="secondary" busy={busy} disabled={t.booleanValue === false} onPress={() => void send({ version: t.version, value: false, ...n })} />
        </View>
      </View>
    );
  }
  const scale = t.scale ?? 0;
  const go = () => {
    const v = normalizeGoalDecimal(value, scale);
    if (v === null) return setErr(scale ? m.errDecimalScaleExample(scale) : m.errWholeNumber);
    void send({ version: t.version, mode, value: v, ...n });
  };
  return (
    <View style={{ marginTop: space(1) }}>
      <View accessibilityRole="radiogroup" accessibilityLabel={m.checkinTypeLabel} style={{ flexDirection: 'row', gap: space(2), marginBottom: space(1) }}>
        <Chip label={m.newValue} selected={mode === 'absolute'} onPress={() => setMode('absolute')} />
        <Chip label={m.changeMode} selected={mode === 'delta'} onPress={() => setMode('delta')} />
      </View>
      <TextInput accessibilityLabel={m.valueLabel(t.title)} placeholder={mode === 'delta' ? m.changePlaceholder : m.newValue} placeholderTextColor={colors.muted} value={value} onChangeText={setValue} keyboardType="numbers-and-punctuation" maxLength={40} style={ui.input} />
      {noteField}
      <Alert text={err} />
      <Button title={common.save} accessibilityLabel={m.saveCheckinLabel(t.title)} busy={busy} disabled={!value.trim()} onPress={go} />
    </View>
  );
}

function CheckinHistory({ accountId, goalId, target: t }: { accountId: AccountId; goalId: number; target: GoalTarget }) {
  const { backend } = useServices();
  const h = useAsync(() => backend.goalCheckins(accountId, goalId, t.id), [accountId, goalId, t.id, t.version]);
  if (h.loading && !h.data) return <Loading />;
  return (
    <View style={{ marginTop: space(1) }}>
      {h.error ? <Alert text={goalError(h.error)} /> : null}
      {h.data && h.data.length === 0 ? <Text style={{ color: colors.muted }}>{m.noCheckins}</Text> : null}
      {(h.data ?? []).map((c) => (
        <Text key={c.id} style={{ color: colors.muted, fontSize: font.small }}>
          {m.checkinEntry(
            dateTime(c.occurredAt),
            c.actor.displayName,
            c.mode === 'boolean' ? (c.newBool ? m.completed : m.notCompleted) : m.checkinChange(fmtValue(t, c.old), fmtValue(t, c.new), c.mode === 'delta'),
            c.note,
          )}
        </Text>
      ))}
      {(h.data ?? []).length >= 100 ? <Text style={{ color: colors.muted, fontSize: font.small }}>{m.lastCheckins}</Text> : null}
    </View>
  );
}

const fractionDigits = (...vals: string[]) => Math.min(GOAL_MAX_SCALE, Math.max(0, ...vals.map((v) => (v.trim().replace(',', '.').split('.')[1] ?? '').replace(/0+$/, '').length)));

function AddTargetForm({ onSubmit }: { onSubmit: (input: GoalTargetInput) => Promise<boolean> }) {
  const [type, setType] = useState<GoalTargetInput['type']>('number');
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('0');
  const [end, setEnd] = useState('');
  const [currency, setCurrency] = useState('TRY');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const numeric = type === 'number' || type === 'currency';
  const go = async () => {
    if (!title.trim()) return setErr(m.errEnterTitle);
    let input: GoalTargetInput;
    if (numeric) {
      const scale = type === 'currency' ? Math.max(2, fractionDigits(start, end)) : fractionDigits(start, end);
      const s = normalizeGoalDecimal(start, scale);
      const e = normalizeGoalDecimal(end, scale);
      if (s === null || e === null) return setErr(m.errStartTargetNumbers);
      if (Number(s) === Number(e)) return setErr(m.errTargetRange);
      if (type === 'currency' && !/^[A-Z]{3}$/.test(currency.trim())) return setErr(m.errCurrency);
      input = type === 'currency' ? { type, title: title.trim(), start: s, target: e, scale, currencyCode: currency.trim() } : { type, title: title.trim(), start: s, target: e, scale };
    } else {
      input = { type, title: title.trim() };
    }
    setErr(undefined);
    setBusy(true);
    if (await onSubmit(input)) {
      setTitle('');
      setEnd('');
    }
    setBusy(false);
  };
  return (
    <View style={[card, { marginTop: space(2) }]}>
      <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(1) }}>{m.addTargetHeading}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={m.targetTypeLabel} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(1), marginBottom: space(2) }}>
        {(['number', 'currency', 'boolean', 'task'] as const).map((k) => <Chip key={k} label={typeLabel()[k]} selected={type === k} onPress={() => setType(k)} />)}
      </View>
      <TextInput accessibilityLabel={m.targetTitleLabel} placeholder={m.title} placeholderTextColor={colors.muted} value={title} onChangeText={setTitle} maxLength={200} style={[ui.input, { marginBottom: space(2) }]} />
      {numeric ? (
        <View style={{ flexDirection: 'row', gap: space(2), flexWrap: 'wrap' }}>
          <View style={{ flexGrow: 1, minWidth: 100 }}><Field label={m.start} value={start} onChangeText={setStart} maxLength={40} keyboardType="numbers-and-punctuation" /></View>
          <View style={{ flexGrow: 1, minWidth: 100 }}><Field label={m.target} value={end} onChangeText={setEnd} maxLength={40} keyboardType="numbers-and-punctuation" /></View>
          {type === 'currency' ? <View style={{ width: 90 }}><Field label={m.currencyField} value={currency} onChangeText={(v) => setCurrency(v.toUpperCase())} maxLength={3} autoCapitalize="characters" /></View> : null}
        </View>
      ) : null}
      {type === 'task' ? <Text style={{ color: colors.muted, fontSize: font.small }}>{m.taskTargetHint}</Text> : null}
      <Alert text={err} />
      <Button title={m.add} busy={busy} disabled={!title.trim() || (numeric && !end.trim())} onPress={() => void go()} />
    </View>
  );
}

function TargetEditForm({ target: t, onSubmit, onCancel }: { target: GoalTarget; onSubmit: (p: GoalTargetPatch) => Promise<boolean>; onCancel: () => void }) {
  const numeric = t.type === 'number' || t.type === 'currency';
  const [title, setTitle] = useState(t.title);
  const [start, setStart] = useState(t.start ?? '');
  const [end, setEnd] = useState(t.target ?? '');
  const [currency, setCurrency] = useState(t.currencyCode ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const go = async () => {
    if (!title.trim()) return setErr(m.errTitleEmpty);
    const patch: GoalTargetPatch = { version: t.version };
    if (title.trim() !== t.title) patch.title = title.trim();
    if (numeric) {
      const scale = t.scale ?? 0;
      const s = normalizeGoalDecimal(start, scale);
      const e = normalizeGoalDecimal(end, scale);
      if (s === null || e === null) return setErr(scale ? m.errDecimalScale(scale) : m.errWholeNumber);
      if (Number(s) === Number(e)) return setErr(m.errTargetRange);
      if (Number(s) !== Number(t.start)) patch.start = s;
      if (Number(e) !== Number(t.target)) patch.target = e;
      if (t.type === 'currency' && currency.trim() !== t.currencyCode) {
        if (!/^[A-Z]{3}$/.test(currency.trim())) return setErr(m.errCurrency);
        patch.currencyCode = currency.trim();
      }
    }
    if (Object.keys(patch).length === 1) return onCancel();
    setErr(undefined);
    setBusy(true);
    await onSubmit(patch);
    setBusy(false);
  };
  return (
    <View style={{ marginTop: space(1) }}>
      <Field label={m.title} value={title} onChangeText={setTitle} maxLength={200} />
      {numeric ? (
        <View style={{ flexDirection: 'row', gap: space(2), flexWrap: 'wrap' }}>
          <View style={{ flexGrow: 1, minWidth: 100 }}><Field label={m.start} value={start} onChangeText={setStart} maxLength={40} keyboardType="numbers-and-punctuation" /></View>
          <View style={{ flexGrow: 1, minWidth: 100 }}><Field label={m.target} value={end} onChangeText={setEnd} maxLength={40} keyboardType="numbers-and-punctuation" /></View>
          {t.type === 'currency' ? <View style={{ width: 90 }}><Field label={m.currencyField} value={currency} onChangeText={(v) => setCurrency(v.toUpperCase())} maxLength={3} autoCapitalize="characters" /></View> : null}
        </View>
      ) : null}
      {numeric ? <Text style={{ color: colors.muted, fontSize: font.small }}>{m.targetEditNote}</Text> : null}
      <Alert text={err} />
      <View style={{ flexDirection: 'row', gap: space(2) }}>
        <Button title={common.save} accessibilityLabel={m.saveTargetLabel(t.title)} busy={busy} onPress={() => void go()} />
        <Button title={m.cancel} kind="secondary" onPress={onCancel} />
      </View>
    </View>
  );
}

/**
 * Task screen section: goals this card is linked to (only those the viewer may see), unlink, and
 * link to another goal the viewer can edit. Hidden entirely when the Goals module is off.
 */
export function TaskGoalsSection({ accountId, cardId }: { accountId: AccountId; cardId: number }) {
  const { backend } = useServices();
  const linked = useAsync(() => backend.cardGoals(accountId, cardId), [accountId, cardId]);
  const [picking, setPicking] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState<number | null>(null);
  const run = async (key: number, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setMsg(undefined);
    try {
      await fn();
      setMsg({ ok: true, text: done });
      setPicking(false);
    } catch (e) {
      setMsg({ ok: false, text: goalError(e) });
    } finally {
      linked.reload();
      setBusy(null);
    }
  };
  const items = linked.data ?? [];
  return (
    <View style={card}>
      <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(2) }}>{m.goalsHeading}</Text>
      {linked.error ? <Alert text={goalError(linked.error)} /> : null}
      {linked.loading && !linked.data ? <Loading /> : null}
      {linked.data && items.length === 0 ? <Text style={{ color: colors.muted }}>{m.notLinked}</Text> : null}
      {items.map((g) => {
        const can = goalActions(g).linkCards;
        return (
          <View key={g.id} style={{ marginBottom: space(2) }}>
            <Text style={{ color: colors.text, fontWeight: '600' }}>{g.title}</Text>
            <Text style={{ color: colors.muted, fontSize: font.small }}>{g.owner.displayName} · {g.linkedTargets.map((x) => x.title).join(', ')}</Text>
            <ProgressBar bp={g.progressBp} label={g.title} />
            {can
              ? g.linkedTargets.map((lt) => (
                  <Button key={lt.id} title={m.unlinkGoal} accessibilityLabel={m.unlinkLabel(g.title, g.linkedTargets.length > 1 ? lt.title : null)} kind="secondary" busy={busy === lt.id} onPress={() => void run(lt.id, () => backend.cardUnlinkGoal(accountId, cardId, g.id, lt.id), m.doneTaskUnlinked)} />
                ))
              : null}
          </View>
        );
      })}
      <Alert text={msg?.text} ok={msg?.ok} />
      {picking ? (
        <GoalPicker accountId={accountId} exclude={items.map((g) => g.id)} busy={busy !== null} onCancel={() => setPicking(false)} onPick={(g) => void run(-g.id, () => backend.cardLinkGoal(accountId, cardId, g.id), m.doneTaskLinked(g.title))} />
      ) : (
        <Button title={m.linkToGoal} kind="secondary" onPress={() => setPicking(true)} />
      )}
    </View>
  );
}

/** Only active goals the viewer may edit (server flags); filtered by name, at most 12 shown. */
function GoalPicker({ accountId, exclude, busy, onPick, onCancel }: { accountId: AccountId; exclude: number[]; busy: boolean; onPick: (g: GoalSummary) => void; onCancel: () => void }) {
  const { backend } = useServices();
  const s = useAsync(async () => (await backend.goals(accountId, { owner: 'all', state: 'active' })).filter((g) => goalActions(g).linkCards), [accountId]);
  const [q, setQ] = useState('');
  const needle = q.trim().toLocaleLowerCase(intlTag());
  const shown = (s.data ?? []).filter((g) => !exclude.includes(g.id) && (!needle || g.title.toLocaleLowerCase(intlTag()).includes(needle))).slice(0, 12);
  return (
    <View style={{ marginTop: space(2) }}>
      {s.error ? <Alert text={goalError(s.error)} /> : null}
      {s.loading && !s.data ? <Loading /> : null}
      {s.data && s.data.length > 6 ? <TextInput accessibilityLabel={m.searchGoal} placeholder={m.searchGoal} placeholderTextColor={colors.muted} value={q} onChangeText={setQ} style={[ui.input, { marginBottom: space(1) }]} /> : null}
      {s.data && shown.length === 0 ? <Text style={{ color: colors.muted }}>{m.noLinkableGoals}</Text> : null}
      {shown.map((g) => <Button key={g.id} title={g.title} accessibilityLabel={m.linkLabel(g.title)} kind="secondary" disabled={busy} onPress={() => onPick(g)} />)}
      <Button title={m.cancel} kind="secondary" onPress={onCancel} />
    </View>
  );
}
