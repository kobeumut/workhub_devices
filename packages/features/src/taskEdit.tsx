import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { buildTaskPatch, STORY_POINT_SCALE, taskFormOf, type AccountId, type BoardPayload, type Priority, type TaskDetail, type TaskForm, type TaskFormError } from '@workhub-devices/core';
import { useServices } from './services';
import { Button, ErrorBanner, Field, card, styles as ui } from './ui';
import { colors, font, space } from './theme';
import { intlTag, messages, t } from './i18n';

const m = messages.tasks;

type Board = BoardPayload['project'];

/** Priority choices with their labels; built per call so the labels follow the active language. */
const priorities = (): Array<[Priority | null, string]> => [
  [null, m.priorityNone],
  ['low', m.priorityLow],
  ['normal', m.priorityNormal],
  ['high', m.priorityHigh],
  ['urgent', m.priorityUrgent],
];

const formError = (error: TaskFormError): string =>
  ({
    title_empty: m.formTitleEmpty,
    date_invalid: m.formDateInvalid,
    date_range: m.formDateRange,
    estimate_invalid: m.formEstimateInvalid,
    points_invalid: m.formPointsInvalid,
  })[error];

export function Chip({ label, selected, onPress, disabled }: { label: string; selected: boolean; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected, disabled: !!disabled }}
      // RN Web ignores accessibilityState; aria-* exposes the selection to desktop screen readers.
      aria-checked={selected}
      aria-disabled={!!disabled}
      accessibilityLabel={label}
      onPress={disabled ? undefined : onPress}
      style={{ paddingVertical: space(1), paddingHorizontal: space(3), borderRadius: 16, borderWidth: 1, borderColor: selected ? colors.primary : colors.border, backgroundColor: selected ? colors.primary : colors.bg, minHeight: 32, justifyContent: 'center', opacity: disabled ? 0.5 : 1 }}
    >
      <Text style={{ color: selected ? colors.primaryText : colors.text }}>{label}</Text>
    </Pressable>
  );
}

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** Full task edit form. Only changed fields are PATCHed; assignees and labels are sent as complete sets. */
export function TaskEditor({ accountId, task, board, onSaved, onCancel }: { accountId: AccountId; task: TaskDetail; board: Board; onSaved: () => void; onCancel: () => void }) {
  const { backend } = useServices();
  const [form, setForm] = useState<TaskForm>(() => taskFormOf(task, board.labels));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [formErr, setFormErr] = useState<string>();
  const set = (p: Partial<TaskForm>) => setForm((f) => ({ ...f, ...p }));
  const plainLabels = board.labels.filter((l) => !l.priority);

  const save = async () => {
    const r = buildTaskPatch(task, board.labels, form);
    if ('error' in r) return setFormErr(formError(r.error));
    setFormErr(undefined);
    if (Object.keys(r.patch).length === 0) return onCancel();
    setBusy(true);
    setErr(undefined);
    try {
      await backend.updateTask(accountId, task.id, r.patch);
      onSaved();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={card}>
      <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(2) }}>
        {t.editTask}
      </Text>
      <ErrorBanner error={err} />
      {formErr ? (
        <Text accessibilityRole="alert" style={{ color: colors.danger, marginBottom: space(2) }}>
          {formErr}
        </Text>
      ) : null}
      <Field label={m.fieldTitle} value={form.title} onChangeText={(v) => set({ title: v })} />
      <Field label={m.fieldDescription} value={form.description} onChangeText={(v) => set({ description: v })} multiline style={{ minHeight: 96, paddingTop: 10 }} />
      <Text style={ui.label}>{t.priority}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginBottom: space(3) }}>
        {priorities().map(([p, label]) => (
          <Chip key={label} label={label} selected={form.priority === p} onPress={() => set({ priority: p })} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: space(2) }}>
        <View style={{ flex: 1 }}>
          <Field label={m.fieldStart} value={form.startDate} onChangeText={(v) => set({ startDate: v })} placeholder="—" autoCapitalize="none" />
        </View>
        <View style={{ flex: 1 }}>
          <Field label={m.fieldDue} value={form.dueDate} onChangeText={(v) => set({ dueDate: v })} placeholder="—" autoCapitalize="none" />
        </View>
      </View>
      <Field label={m.fieldEstimate} value={form.estimateHours} onChangeText={(v) => set({ estimateHours: v })} keyboardType="decimal-pad" placeholder="—" />
      <Text style={ui.label}>{m.storyPoints}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginBottom: space(3) }}>
        {STORY_POINT_SCALE.map((p) => (
          <Chip key={p} label={String(p)} selected={form.storyPoints === String(p)} onPress={() => set({ storyPoints: form.storyPoints === String(p) ? '' : String(p) })} />
        ))}
      </View>
      <Field label={m.storyPointsWhole} value={form.storyPoints} onChangeText={(v) => set({ storyPoints: v })} keyboardType="number-pad" placeholder="—" />
      {plainLabels.length ? (
        <>
          <Text style={ui.label}>{m.labels}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginBottom: space(3) }}>
            {plainLabels.map((l) => (
              <Chip key={l.id} label={l.title} selected={form.labels.includes(l.id)} onPress={() => set({ labels: toggle(form.labels, l.id) })} />
            ))}
          </View>
        </>
      ) : null}
      <Text style={ui.label}>{t.assignees}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginBottom: space(3) }}>
        {board.members.length === 0 ? <Text style={{ color: colors.muted }}>{m.noMembers}</Text> : null}
        {board.members.map((m) => (
          <Chip key={m.uid} label={m.displayName} selected={form.assignees.includes(m.uid)} onPress={() => set({ assignees: toggle(form.assignees, m.uid) })} />
        ))}
      </View>
      {task.assignees.some((a) => a.type === 'group') ? (
        <Text style={{ color: colors.muted, fontSize: font.small, marginBottom: space(2) }}>{m.groupAssignmentsNote}</Text>
      ) : null}
      <View style={{ flexDirection: 'row', gap: space(2) }}>
        <View style={{ flex: 1 }}>
          <Button title={t.save} onPress={() => void save()} busy={busy} />
        </View>
        <View style={{ flex: 1 }}>
          <Button title={t.cancel} kind="secondary" onPress={onCancel} disabled={busy} />
        </View>
      </View>
    </View>
  );
}

/** Checklist subtasks. Every index write sends the text we displayed so a concurrent change fails safely (409). */
export function SubtaskSection({ accountId, task, canEdit, onChanged }: { accountId: AccountId; task: TaskDetail; canEdit: boolean; onChanged: () => void }) {
  const { backend } = useServices();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(undefined);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr(e);
      onChanged(); // conflict → show the server's current list
    } finally {
      setBusy(false);
    }
  };
  const items = task.subtaskItems ?? [];
  return (
    <View style={card}>
      <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(2) }}>
        {m.subtasksHeading(items.filter((i) => i.done).length, items.length)}
      </Text>
      <ErrorBanner error={err} />
      {items.length === 0 ? <Text style={{ color: colors.muted }}>{m.noSubtasks}</Text> : null}
      {items.map((it) => (
        <View key={`${it.index}:${it.text}`} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 40 }}>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: it.done, disabled: !canEdit || busy }}
            accessibilityLabel={it.text}
            onPress={!canEdit || busy ? undefined : () => void run(() => backend.updateSubtask(accountId, task.id, it.index, it.text, { done: !it.done }))}
            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space(2), paddingVertical: space(1) }}
          >
            <Text style={{ fontSize: 18, color: it.done ? colors.ok : colors.muted }}>{it.done ? '☑' : '☐'}</Text>
            <Text style={{ color: colors.text, textDecorationLine: it.done ? 'line-through' : 'none', flex: 1 }}>{it.text}</Text>
          </Pressable>
          {canEdit ? (
            <Pressable accessibilityRole="button" accessibilityLabel={m.deleteSubtaskLabel(it.text)} onPress={busy ? undefined : () => void run(() => backend.deleteSubtask(accountId, task.id, it.index, it.text))} style={{ padding: space(2) }}>
              <Text style={{ color: colors.danger }}>{m.deleteAction}</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
      {canEdit ? (
        <View style={{ flexDirection: 'row', gap: space(2), marginTop: space(2) }}>
          <TextInput
            accessibilityLabel={m.newSubtask}
            placeholder={m.newSubtask}
            placeholderTextColor={colors.muted}
            value={text}
            onChangeText={setText}
            onSubmitEditing={() => text.trim() && void run(async () => { await backend.addSubtask(accountId, task.id, text.trim()); setText(''); })}
            style={[ui.input, { flex: 1 }]}
          />
          <Button title={m.addSubtask} busy={busy} disabled={!text.trim()} onPress={() => void run(async () => { await backend.addSubtask(accountId, task.id, text.trim()); setText(''); })} />
        </View>
      ) : null}
    </View>
  );
}

/** "Waits for" (predecessors) and "blocks" (successors) inside the same project. */
export function DependencySection({ accountId, task, board, tasks, canEdit, onChanged }: { accountId: AccountId; task: TaskDetail; board: Board; tasks: BoardPayload['tasks']; canEdit: boolean; onChanged: () => void }) {
  const { backend } = useServices();
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  if (board.features?.dependencies === false) return null;
  const linked = new Set([task.id, ...task.predecessors.map((p) => p.id), ...task.successors.map((s) => s.id)]);
  const candidates = tasks.filter((x) => !linked.has(x.id) && !x.archived && x.title.toLocaleLowerCase(intlTag()).includes(filter.trim().toLocaleLowerCase(intlTag()))).slice(0, 20);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(undefined);
    try {
      await fn();
      setPicking(false);
      setFilter('');
      onChanged();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const row = (label: string, l: TaskDetail['predecessors'][number]) => (
    <View key={`${label}${l.dependencyId}`} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 40 }}>
      <Text style={{ flex: 1, color: colors.text }}>
        {label} {l.done ? '✓ ' : ''}
        {l.title}
      </Text>
      {canEdit ? (
        <Pressable accessibilityRole="button" accessibilityLabel={m.removeDependencyLabel(l.title)} onPress={busy ? undefined : () => void run(() => backend.removeDependency(accountId, task.id, l.dependencyId))} style={{ padding: space(2) }}>
          <Text style={{ color: colors.danger }}>{m.remove}</Text>
        </Pressable>
      ) : null}
    </View>
  );
  return (
    <View style={card}>
      <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(2) }}>
        {m.dependencies}
      </Text>
      <ErrorBanner error={err} />
      {task.predecessors.length + task.successors.length === 0 ? <Text style={{ color: colors.muted }}>{m.noDependencies}</Text> : null}
      {task.predecessors.map((p) => row(m.waitsForPrefix, p))}
      {task.successors.map((s) => row(m.blocksPrefix, s))}
      {canEdit && !picking ? <Button title={m.addPredecessor} kind="secondary" onPress={() => setPicking(true)} /> : null}
      {picking ? (
        <View style={{ marginTop: space(2) }}>
          <TextInput accessibilityLabel={m.searchTask} placeholder={m.searchTask} placeholderTextColor={colors.muted} value={filter} onChangeText={setFilter} style={[ui.input, { marginBottom: space(2) }]} />
          {candidates.length === 0 ? <Text style={{ color: colors.muted }}>{m.noEligibleTasks}</Text> : null}
          {candidates.map((c) => (
            <Pressable key={c.id} accessibilityRole="button" accessibilityLabel={m.waitForLabel(c.title)} onPress={busy ? undefined : () => void run(() => backend.addDependency(accountId, c.id, task.id))} style={{ paddingVertical: space(2) }}>
              <Text style={{ color: colors.primary }}>{c.title}</Text>
            </Pressable>
          ))}
          <Button title={t.cancel} kind="secondary" onPress={() => setPicking(false)} />
        </View>
      ) : null}
    </View>
  );
}
