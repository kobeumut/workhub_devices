/**
 * Kanban board with the web app's look (Workhub `KanbanView.vue` / `KanbanColumn.vue` /
 * `TaskCard.vue`): horizontally scrolling columns, cards with key, priority badge, title, labels,
 * sub-task progress, done check, due date and assignee avatars.
 *
 * Moving cards: every platform has the card menu (move to a list, left/right, up/down) — that is
 * the accessible path and the only one on touch screens. The desktop renderer additionally
 * supports mouse drag & drop through the DOM drag events (RN Web renders real elements).
 */
import { useEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import {
  activeFilterCount, adjacentColumn, deviceDay, dropOrder, dueState, emptyFilters, initials, isNoopMove, moveToColumn, moveWithinColumn,
  type BoardPayload, type KanbanColumn, type Priority, type PriorityFilter, type Task, type TaskAssignee, type TaskFilters,
} from '@workhub-devices/core';
import { Icon, type IconName } from './icons';
import { colors, hexColor, priorityColors, radius, shadow, space } from './theme';
import { t } from './i18n';

export const PRIORITY_LABEL: Record<Priority, string> = { urgent: 'Acil', high: 'Yüksek', normal: 'Normal', low: 'Düşük' };
/** Distinct, colour-independent cue per priority (web uses ▲▲ / ▲ / ■ / ▼). */
const PRIORITY_GLYPH: Record<Priority, string> = { urgent: '▲▲', high: '▲', normal: '■', low: '▼' };
const STACK_PALETTE = ['#64748b', '#2563eb', '#7c3aed', '#d97706', '#0891b2', '#db2777'];

/** Column colour: done columns green, others cycle a fixed palette (web `KanbanView.vue`). */
export const stackColor = (index: number, isDone: boolean) => (isDone ? '#059669' : STACK_PALETTE[index % STACK_PALETTE.length]!);

// ---- Small building blocks ---------------------------------------------------------------------

export function PriorityBadge({ priority }: { priority: Priority | null }) {
  if (!priority) return null;
  const c = priorityColors[priority]!;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 6, height: 20, borderRadius: radius.sm, backgroundColor: c.bg }}>
      <Text style={{ color: c.fg, fontSize: 9 }} accessibilityElementsHidden importantForAccessibility="no">
        {PRIORITY_GLYPH[priority]}
      </Text>
      <Text style={{ color: c.fg, fontSize: 11.5, fontWeight: '600' }}>{PRIORITY_LABEL[priority]}</Text>
    </View>
  );
}

const AVATAR_BG = ['#0071b0', '#7c3aed', '#047857', '#b45309', '#be185d', '#0e7490'];
const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7);

export function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: AVATAR_BG[Math.abs(hash(name)) % AVATAR_BG.length], alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.bg }}>
      <Text style={{ color: '#fff', fontSize: Math.round(size * 0.36), fontWeight: '700', letterSpacing: -0.3 }}>{initials(name)}</Text>
    </View>
  );
}

export function AvatarStack({ people, max = 3, size = 24 }: { people: Pick<TaskAssignee, 'id' | 'displayName'>[]; max?: number; size?: number }) {
  if (!people.length) return null;
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <View accessible accessibilityLabel={`${t.assignees}: ${people.map((p) => p.displayName).join(', ')}`} style={{ flexDirection: 'row' }}>
      {shown.map((p, i) => (
        <View key={p.id} style={{ marginLeft: i ? -size / 3 : 0 }}>
          <Avatar name={p.displayName} size={size} />
        </View>
      ))}
      {rest > 0 ? (
        <View style={{ marginLeft: -size / 3, width: size, height: size, borderRadius: size / 2, backgroundColor: colors.hover, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.bg }}>
          <Text style={{ fontSize: size * 0.38, color: colors.muted, fontWeight: '700' }}>+{rest}</Text>
        </View>
      ) : null}
    </View>
  );
}

const shortDate = (iso: string) => new Date(iso).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });

export function DueBadge({ due, done }: { due: string | null; done: string | null }) {
  if (!due) return null;
  const state = dueState(due, done, Date.now(), deviceDay(new Date().toISOString()), deviceDay);
  const tone = state === 'overdue' ? { fg: colors.danger, bg: colors.dangerSoft } : state === 'today' ? { fg: colors.warning, bg: colors.warningSoft } : state === 'done' ? { fg: colors.ok, bg: 'transparent' } : { fg: colors.muted, bg: 'transparent' };
  const word = state === 'overdue' ? ' · gecikmiş' : state === 'today' ? ' · bugün' : '';
  return (
    <View accessible accessibilityLabel={`${t.due}: ${shortDate(due)}${word}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: tone.bg === 'transparent' ? 0 : 6, height: 20, borderRadius: radius.sm, backgroundColor: tone.bg }}>
      <Icon name="calendar" size={13} color={tone.fg} />
      <Text style={{ color: tone.fg, fontSize: 12, fontWeight: state === 'overdue' || state === 'today' ? '600' : '400' }}>{shortDate(due)}</Text>
    </View>
  );
}

export function LabelChips({ ids, labels }: { ids: number[]; labels: BoardPayload['project']['labels'] }) {
  const shown = labels.filter((l) => !l.priority && ids.includes(l.id));
  if (!shown.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
      {shown.map((l) => (
        <View key={l.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, height: 20, borderRadius: 10, backgroundColor: colors.hover }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: hexColor(l.color) }} />
          <Text style={{ fontSize: 11.5, color: colors.text }}>{l.title}</Text>
        </View>
      ))}
    </View>
  );
}

export function IconButton({ icon, label, onPress, color = colors.muted, size = 18, expanded, disabled }: { icon: IconName; label: string; onPress: () => void; color?: string; size?: number; expanded?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, ...(expanded !== undefined ? { expanded } : {}) }}
      onPress={disabled ? undefined : onPress}
      hitSlop={8}
      style={({ pressed }) => ({ width: 32, height: 32, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? colors.hover : 'transparent', opacity: disabled ? 0.4 : 1 })}
    >
      <Icon name={icon} size={size} color={color} />
    </Pressable>
  );
}

// ---- Task card ---------------------------------------------------------------------------------

export function TaskCard({ task, labels, canEdit, onOpen, onToggleDone, onMenu, menuOpen, dragging }: {
  task: Task;
  labels: BoardPayload['project']['labels'];
  canEdit: boolean;
  onOpen: () => void;
  onToggleDone: () => void;
  onMenu?: () => void;
  menuOpen?: boolean;
  dragging?: boolean;
}) {
  const done = !!task.done;
  const pct = task.subtasks.total ? Math.round((task.subtasks.done / task.subtasks.total) * 100) : 0;
  return (
    <View style={[{ backgroundColor: colors.bg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: space(3), gap: space(2), opacity: dragging ? 0.4 : 1 }, shadow]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${done ? 'Tamamlandı: ' : ''}${task.title}`} accessibilityHint="Görev ayrıntılarını açar" onPress={onOpen} onLongPress={onMenu} style={{ gap: space(2) }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 22 }}>
          <Text style={{ fontSize: 11.5, color: colors.muted, fontVariant: ['tabular-nums'] }}>#{task.id}</Text>
          <PriorityBadge priority={task.priority} />
          <View style={{ flex: 1 }} />
        </View>
        <Text numberOfLines={2} style={{ fontSize: 14, fontWeight: '600', lineHeight: 20, color: done ? colors.muted : colors.textStrong, textDecorationLine: done ? 'line-through' : 'none' }}>
          {task.title}
        </Text>
        <LabelChips ids={task.labels} labels={labels} />
        {task.subtasks.total ? (
          <View style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 11.5, color: colors.muted }}>Alt işler</Text>
              <Text style={{ fontSize: 11.5, color: colors.muted, fontVariant: ['tabular-nums'] }}>
                {task.subtasks.done}/{task.subtasks.total} (%{pct})
              </Text>
            </View>
            <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.hover, overflow: 'hidden' }}>
              <View style={{ width: `${pct}%`, height: 4, backgroundColor: pct === 100 ? colors.ok : colors.primary }} />
            </View>
          </View>
        ) : null}
      </Pressable>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: space(2), borderTopWidth: 1, borderColor: colors.border }}>
        {canEdit ? (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: done }}
            accessibilityLabel={done ? `${task.title}: tamamlanmadı olarak işaretle` : `${task.title}: tamamlandı olarak işaretle`}
            onPress={onToggleDone}
            hitSlop={10}
            style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: done ? colors.ok : colors.borderStrong, backgroundColor: done ? colors.ok : 'transparent', alignItems: 'center', justifyContent: 'center' }}
          >
            {done ? <Icon name="check" size={12} color="#fff" strokeWidth={3} /> : null}
          </Pressable>
        ) : done ? (
          <Icon name="checkCircle" size={18} color={colors.ok} />
        ) : null}
        <DueBadge due={task.dueDate} done={task.done} />
        <View style={{ flex: 1 }} />
        <AvatarStack people={task.assignees} size={22} />
        {onMenu ? <IconButton icon="more" label={`${task.title}: işlemler`} onPress={onMenu} expanded={!!menuOpen} /> : null}
      </View>
    </View>
  );
}

// ---- Toolbar (web ProjectToolbar parity) ----------------------------------------------------------

export function Chip({ label, selected, onPress, icon, count }: { label: string; selected: boolean; onPress: () => void; icon?: IconName; count?: number }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space(3), height: 32, borderRadius: radius.sm, borderWidth: 1, borderColor: selected ? colors.primary : colors.border, backgroundColor: selected ? colors.primarySoft : colors.bg }}
    >
      {icon ? <Icon name={icon} size={15} color={selected ? colors.primary : colors.muted} /> : null}
      <Text style={{ color: selected ? colors.primaryStrong : colors.text, fontWeight: selected ? '600' : '500', fontSize: 13 }}>{label}</Text>
      {count ? (
        <View style={{ minWidth: 18, height: 18, borderRadius: 9, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 }}>
          <Text style={{ color: colors.primaryText, fontSize: 11, fontWeight: '700' }}>{count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export function BoardToolbar({ filters, onChange }: { filters: TaskFilters; onChange: (f: TaskFilters) => void }) {
  const [open, setOpen] = useState(false);
  const count = activeFilterCount(filters) - (filters.q.trim() ? 1 : 0);
  const togglePriority = (p: PriorityFilter) => onChange({ ...filters, priorities: filters.priorities.includes(p) ? filters.priorities.filter((x) => x !== p) : [...filters.priorities, p] });
  return (
    <View accessibilityRole="toolbar" style={{ backgroundColor: colors.bg, borderBottomWidth: 1, borderColor: colors.border, paddingHorizontal: space(3), paddingVertical: space(2), gap: space(2) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2) }}>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, paddingHorizontal: space(2) }}>
          <Icon name="search" size={16} color={colors.muted} />
          <TextInput
            accessibilityLabel="Görevlerde ara"
            placeholder="Görevlerde ara…"
            placeholderTextColor={colors.muted}
            value={filters.q}
            onChangeText={(q) => onChange({ ...filters, q })}
            style={{ flex: 1, fontSize: 14, color: colors.text, paddingVertical: 0, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) }}
          />
          {filters.q ? <IconButton icon="close" label="Aramayı temizle" size={15} onPress={() => onChange({ ...filters, q: '' })} /> : null}
        </View>
        <Chip label="Filtreler" icon="filter" selected={open || count > 0} {...(count ? { count } : {})} onPress={() => setOpen((o) => !o)} />
      </View>
      {open ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
          <Chip label="Yalnız benim" icon="user" selected={filters.mine} onPress={() => onChange({ ...filters, mine: !filters.mine })} />
          <Chip label="Tamamlananları göster" icon="checkCircle" selected={filters.showDone} onPress={() => onChange({ ...filters, showDone: !filters.showDone })} />
          {(['urgent', 'high', 'normal', 'low', 'none'] as const).map((p) => (
            <Chip key={p} label={p === 'none' ? 'Önceliksiz' : PRIORITY_LABEL[p]} selected={filters.priorities.includes(p)} onPress={() => togglePriority(p)} />
          ))}
          {count ? <Chip label="Temizle" icon="close" selected={false} onPress={() => onChange({ ...emptyFilters(), q: filters.q })} /> : null}
        </View>
      ) : null}
    </View>
  );
}

// ---- Desktop drag & drop (RN Web renders DOM nodes) -------------------------------------------

type DomEl = HTMLElement;
const asDom = (ref: unknown): DomEl | null => (Platform.OS === 'web' && ref && typeof (ref as DomEl).addEventListener === 'function' ? (ref as DomEl) : null);

function useDraggable(ref: { current: unknown }, id: number, enabled: boolean, onStart: (id: number) => void, onEnd: () => void) {
  useEffect(() => {
    const el = asDom(ref.current);
    if (!el || !enabled) return;
    el.setAttribute('draggable', 'true');
    el.dataset['taskId'] = String(id);
    const start = (e: DragEvent) => {
      e.dataTransfer?.setData('text/plain', String(id));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      onStart(id);
    };
    el.addEventListener('dragstart', start);
    el.addEventListener('dragend', onEnd);
    return () => {
      el.removeEventListener('dragstart', start);
      el.removeEventListener('dragend', onEnd);
      el.removeAttribute('draggable');
    };
  }, [ref, id, enabled, onStart, onEnd]);
}

/** Calls `onDrop(beforeId)`; `beforeId` = first visible card whose midpoint is below the pointer. */
function useDropZone(ref: { current: unknown }, enabled: boolean, onOver: (beforeId: number | null) => void, onDrop: (beforeId: number | null) => void) {
  useEffect(() => {
    const el = asDom(ref.current);
    if (!el || !enabled) return;
    const slot = (e: DragEvent): number | null => {
      for (const card of Array.from(el.querySelectorAll<HTMLElement>('[data-task-id]'))) {
        const r = card.getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) return Number(card.dataset['taskId']);
      }
      return null;
    };
    const over = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      onOver(slot(e));
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      onDrop(slot(e));
    };
    el.addEventListener('dragover', over);
    el.addEventListener('drop', drop);
    return () => {
      el.removeEventListener('dragover', over);
      el.removeEventListener('drop', drop);
    };
  }, [ref, enabled, onOver, onDrop]);
}

// ---- Column + board ----------------------------------------------------------------------------

export interface KanbanActions {
  open: (task: Task) => void;
  toggleDone: (task: Task) => void;
  move: (task: Task, target: { stackId: number; order: number }) => void;
  create: (stackId: number, title: string) => Promise<void>;
}

function DraggableCard({ task, children, enabled, onStart, onEnd }: { task: Task; children: ReactNode; enabled: boolean; onStart: (id: number) => void; onEnd: () => void }) {
  const ref = useRef<ComponentRef<typeof View>>(null);
  useDraggable(ref, task.id, enabled, onStart, onEnd);
  return <View ref={ref}>{children}</View>;
}

function CardMenu({ task, columns, onMove, onToggleDone, onOpen, onClose }: { task: Task; columns: KanbanColumn[]; onMove: (target: { stackId: number; order: number }) => void; onToggleDone: () => void; onOpen: () => void; onClose: () => void }) {
  const left = adjacentColumn(columns, task.stackId, -1);
  const right = adjacentColumn(columns, task.stackId, 1);
  const up = moveWithinColumn(columns, task.id, -1);
  const down = moveWithinColumn(columns, task.id, 1);
  const item = (key: string, icon: IconName, label: string, onPress: () => void, disabled = false) => (
    <Pressable key={key} accessibilityRole="menuitem" accessibilityState={{ disabled }} onPress={disabled ? undefined : () => { onClose(); onPress(); }} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space(2), paddingHorizontal: space(3), minHeight: 40, opacity: disabled ? 0.4 : 1, backgroundColor: pressed ? colors.hover : 'transparent' })}>
      <Icon name={icon} size={16} color={colors.muted} />
      <Text style={{ color: colors.text, fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
  const to = (c: KanbanColumn | null) => (c ? moveToColumn(columns, task.id, c.stack.id) : null);
  return (
    <View accessibilityRole="menu" style={[{ backgroundColor: colors.bg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingVertical: space(1), marginTop: space(1) }, shadow]}>
      {item('open', 'chevronRight', 'Ayrıntıları aç', onOpen)}
      {item('done', 'checkCircle', task.done ? 'Tamamlanmadı olarak işaretle' : 'Tamamlandı olarak işaretle', onToggleDone)}
      <View style={{ height: 1, backgroundColor: colors.border, marginVertical: space(1) }} />
      {item('left', 'arrowLeft', left ? `Sola taşı: ${left.stack.title}` : 'Sola taşı', () => onMove(to(left)!), !to(left))}
      {item('right', 'arrowRight', right ? `Sağa taşı: ${right.stack.title}` : 'Sağa taşı', () => onMove(to(right)!), !to(right))}
      {item('up', 'arrowUp', 'Yukarı taşı', () => onMove(up!), !up)}
      {item('down', 'arrowDown', 'Aşağı taşı', () => onMove(down!), !down)}
      {columns.length > 3 ? (
        <>
          <View style={{ height: 1, backgroundColor: colors.border, marginVertical: space(1) }} />
          {columns.filter((c) => c.stack.id !== task.stackId).map((c) => item(`to-${c.stack.id}`, 'kanban', `Taşı: ${c.stack.title}`, () => onMove(to(c)!), !to(c)))}
        </>
      ) : null}
      {item('close', 'close', t.cancel, () => undefined)}
    </View>
  );
}

function Column({ col, index, board, canEdit, actions, width, menuFor, setMenuFor, columns, dragId, setDragId, addOpen, setAddOpen }: {
  col: KanbanColumn;
  index: number;
  board: BoardPayload;
  canEdit: boolean;
  actions: KanbanActions;
  width: number;
  menuFor: number | null;
  setMenuFor: (id: number | null) => void;
  columns: KanbanColumn[];
  dragId: number | null;
  setDragId: (id: number | null) => void;
  addOpen: boolean;
  setAddOpen: (open: boolean) => void;
}) {
  const ref = useRef<ComponentRef<typeof View>>(null);
  const [dropBefore, setDropBefore] = useState<number | null | 'none'>('none');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const color = stackColor(index, col.stack.isDone);
  const onOver = useMemo(() => (before: number | null) => setDropBefore(before), []);
  const onDrop = useMemo(
    () => (before: number | null) => {
      setDropBefore('none');
      const id = dragId;
      setDragId(null);
      if (id === null) return;
      const task = board.tasks.find((x) => x.id === id);
      if (!task) return;
      const order = dropOrder(col.fullIds, id, before, col.tasks.map((x) => x.id));
      if (!isNoopMove(col.fullIds, id, task.stackId, col.stack.id, order)) actions.move(task, { stackId: col.stack.id, order });
    },
    [dragId, setDragId, board.tasks, col, actions],
  );
  useDropZone(ref, canEdit && Platform.OS === 'web', onOver, onDrop);
  // Stable so the card's DOM drag listeners are not re-attached while a drag is in progress.
  const endDrag = useMemo(() => () => setDragId(null), [setDragId]);
  useEffect(() => {
    if (dragId === null) setDropBefore('none');
  }, [dragId]);
  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await actions.create(col.stack.id, title.trim());
      setTitle('');
    } finally {
      setBusy(false);
    }
  };
  const countText = col.tasks.length === col.totalCount ? String(col.totalCount) : `${col.tasks.length}/${col.totalCount}`;
  const target = dragId !== null && dropBefore !== 'none';
  return (
    <View ref={ref} accessibilityLabel={`${col.stack.title}, ${col.totalCount} görev`} style={{ width, maxHeight: '100%', backgroundColor: target ? colors.primarySoft : colors.hover, borderRadius: radius.lg, borderWidth: 1, borderColor: target ? colors.primary : 'transparent', padding: space(2) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), paddingHorizontal: space(1), minHeight: 36 }}>
        <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: color }} />
        <Text accessibilityRole="header" numberOfLines={1} style={{ flexShrink: 1, fontWeight: '700', fontSize: 14, color: colors.textStrong }}>
          {col.stack.title}
        </Text>
        <View style={{ paddingHorizontal: 7, height: 20, borderRadius: 10, backgroundColor: colors.bg, justifyContent: 'center' }}>
          <Text style={{ fontSize: 12, color: colors.muted, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{countText}</Text>
        </View>
        {col.stack.isDone ? <Icon name="checkCircle" size={15} color={colors.ok} /> : null}
        <View style={{ flex: 1 }} />
        {canEdit ? <IconButton icon="plus" label={`${col.stack.title} listesine görev ekle`} onPress={() => setAddOpen(!addOpen)} expanded={addOpen} /> : null}
      </View>
      <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: space(2), paddingTop: space(1), paddingBottom: space(1) }}>
        {col.tasks.map((task) => (
          <View key={task.id}>
            {dragId !== null && dropBefore === task.id ? <View style={{ height: 3, borderRadius: 2, backgroundColor: colors.primary, marginBottom: space(1) }} /> : null}
            <DraggableCard task={task} enabled={canEdit} onStart={setDragId} onEnd={endDrag}>
              <TaskCard
                task={task}
                labels={board.project.labels}
                canEdit={canEdit}
                dragging={dragId === task.id}
                onOpen={() => actions.open(task)}
                onToggleDone={() => actions.toggleDone(task)}
                {...(canEdit ? { onMenu: () => setMenuFor(menuFor === task.id ? null : task.id), menuOpen: menuFor === task.id } : {})}
              />
            </DraggableCard>
            {menuFor === task.id ? (
              <CardMenu task={task} columns={columns} onMove={(target) => actions.move(task, target)} onToggleDone={() => actions.toggleDone(task)} onOpen={() => actions.open(task)} onClose={() => setMenuFor(null)} />
            ) : null}
          </View>
        ))}
        {dragId !== null && dropBefore === null ? <View style={{ height: 3, borderRadius: 2, backgroundColor: colors.primary }} /> : null}
        {col.tasks.length === 0 ? (
          <View style={{ borderWidth: 1, borderStyle: 'dashed', borderColor: colors.borderStrong, borderRadius: radius.md, paddingVertical: space(5), alignItems: 'center' }}>
            <Text style={{ color: colors.muted, fontSize: 13 }}>{dragId !== null ? 'Buraya bırakın' : col.totalCount ? 'Eşleşen görev yok' : t.noTasks}</Text>
          </View>
        ) : null}
      </ScrollView>
      {canEdit && addOpen ? (
        <View style={{ gap: space(2), paddingTop: space(2) }}>
          <TextInput
            autoFocus
            accessibilityLabel={`${col.stack.title} listesinde yeni görev`}
            placeholder="Görev başlığı…"
            placeholderTextColor={colors.muted}
            value={title}
            onChangeText={setTitle}
            onSubmitEditing={() => void submit()}
            style={{ minHeight: 40, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.primary, backgroundColor: colors.bg, paddingHorizontal: space(3), fontSize: 14, color: colors.text }}
          />
          <View style={{ flexDirection: 'row', gap: space(2) }}>
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || !title.trim() }} onPress={() => void submit()} style={{ flex: 1, height: 34, borderRadius: radius.sm, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', opacity: busy || !title.trim() ? 0.6 : 1 }}>
              <Text style={{ color: colors.primaryText, fontWeight: '600' }}>{busy ? '…' : 'Ekle'}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => { setTitle(''); setAddOpen(false); }} style={{ paddingHorizontal: space(3), height: 34, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: colors.muted }}>{t.cancel}</Text>
            </Pressable>
          </View>
        </View>
      ) : canEdit ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`${col.stack.title} listesine görev ekle`} onPress={() => setAddOpen(true)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space(2), height: 36, borderRadius: radius.sm, backgroundColor: pressed ? colors.border : 'transparent', marginTop: space(1) })}>
          <Icon name="plus" size={16} color={colors.muted} />
          <Text style={{ color: colors.muted, fontSize: 13 }}>Görev ekle</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function KanbanBoard({ board, columns, canEdit, actions, addInStack, onAddHandled }: {
  board: BoardPayload;
  columns: KanbanColumn[];
  canEdit: boolean;
  actions: KanbanActions;
  /** Opens the quick-add of a column (header "+ Görev ekle"). */
  addInStack?: number | null;
  onAddHandled?: () => void;
}) {
  const { width } = useWindowDimensions();
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState<number | null>(null);
  useEffect(() => {
    if (addInStack != null) {
      setAddOpen(addInStack);
      onAddHandled?.();
    }
  }, [addInStack, onAddHandled]);
  // Phones: a column is most of the screen so the next one peeks in; desktop: web's 300px columns.
  const colWidth = width < 600 ? Math.round(width * 0.84) : 300;
  return (
    <ScrollView
      horizontal
      style={{ flex: 1, backgroundColor: colors.surface }}
      contentContainerStyle={{ padding: space(3), gap: space(3), alignItems: 'flex-start' }}
      {...(width < 600 ? { snapToInterval: colWidth + space(3), decelerationRate: 'fast' as const } : {})}
    >
      {columns.map((col, i) => (
        <Column
          key={col.stack.id}
          col={col}
          index={i}
          board={board}
          canEdit={canEdit}
          actions={actions}
          width={colWidth}
          menuFor={menuFor}
          setMenuFor={setMenuFor}
          columns={columns}
          dragId={dragId}
          setDragId={setDragId}
          addOpen={addOpen === col.stack.id}
          setAddOpen={(open) => setAddOpen(open ? col.stack.id : null)}
        />
      ))}
      {!columns.length ? <Text style={{ color: colors.muted, padding: space(4) }}>Bu projede liste yok.</Text> : null}
    </ScrollView>
  );
}

