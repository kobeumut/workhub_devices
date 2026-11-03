/**
 * Kanban / list board maths shared by every platform — a port of the web app's
 * `services/boardOrder.ts` and `stores/projects.ts#matchesFilters` (kobeumut/nextcloud_workhub)
 * so the devices board orders, filters and moves cards exactly like the web board.
 *
 * Deck orders cards per stack; the move endpoint takes a 0-based position among the target
 * stack's cards WITHOUT the moved card. Filters may hide cards, so positions are always computed
 * against the FULL stack order while the user aims at visible cards.
 */
import type { BoardPayload, Priority, Task } from './workhub';

export interface Orderable {
  id: number;
  stackId: number;
  order: number;
}

/** Card ids per stack in Deck order (order, then id), including hidden cards. */
export function orderByStack(tasks: readonly Orderable[]): Map<number, number[]> {
  const grouped = new Map<number, Orderable[]>();
  for (const task of tasks) {
    const list = grouped.get(task.stackId) ?? [];
    list.push(task);
    grouped.set(task.stackId, list);
  }
  const out = new Map<number, number[]>();
  for (const [stackId, list] of grouped) out.set(stackId, list.sort((a, b) => a.order - b.order || a.id - b.id).map((t) => t.id));
  return out;
}

/**
 * Target position for a drop.
 * @param fullIds all card ids of the target stack in Deck order
 * @param beforeId visible card the card is dropped before; null = after the last visible card
 * @param visibleIds visible card ids of the target stack in Deck order
 */
export function dropOrder(fullIds: readonly number[], draggedId: number, beforeId: number | null, visibleIds: readonly number[] = fullIds): number {
  const rest = fullIds.filter((id) => id !== draggedId);
  if (beforeId !== null) {
    const index = rest.indexOf(beforeId);
    if (index !== -1) return index;
  }
  for (let i = visibleIds.length - 1; i >= 0; i--) {
    const id = visibleIds[i]!;
    if (id === draggedId) continue;
    const index = rest.indexOf(id);
    if (index !== -1) return index + 1;
  }
  return rest.length;
}

/** True when a move would leave the card where it already is. */
export function isNoopMove(fullIds: readonly number[], draggedId: number, fromStackId: number, toStackId: number, order: number): boolean {
  return fromStackId === toStackId && fullIds.indexOf(draggedId) === order;
}

/** Moves the card past its previous (-1) or next (+1) visible neighbour; null at the edges. */
export function reorderTarget(fullIds: readonly number[], visibleIds: readonly number[], id: number, delta: -1 | 1): number | null {
  const visibleIndex = visibleIds.indexOf(id);
  if (visibleIndex === -1) return null;
  const neighbour = visibleIds[visibleIndex + delta];
  if (neighbour === undefined) return null;
  const index = fullIds.filter((other) => other !== id).indexOf(neighbour);
  if (index === -1) return null;
  return delta < 0 ? index : index + 1;
}

// ---- Filters (web toolbar parity) ------------------------------------------------------------

export const NO_PRIORITY = 'none' as const;
export type PriorityFilter = Priority | typeof NO_PRIORITY;

export interface TaskFilters {
  q: string;
  mine: boolean;
  priorities: PriorityFilter[];
  /** User ids; `''` = unassigned. */
  assignees: string[];
  labels: number[];
  showDone: boolean;
}

export const emptyFilters = (): TaskFilters => ({ q: '', mine: false, priorities: [], assignees: [], labels: [], showDone: true });

export function activeFilterCount(f: TaskFilters): number {
  return (f.q.trim() ? 1 : 0) + (f.mine ? 1 : 0) + f.priorities.length + f.assignees.length + f.labels.length + (f.showDone ? 0 : 1);
}

export function matchesFilters(task: Task, f: TaskFilters, labelTitles: ReadonlyMap<number, string>, me: string): boolean {
  if (!f.showDone && task.done !== null) return false;
  if (f.mine && !task.assignees.some((a) => a.type === 'user' && a.id === me)) return false;
  if (f.assignees.length) {
    const ids = task.assignees.filter((a) => a.type === 'user').map((a) => a.id);
    const wantsNone = f.assignees.includes('');
    if (!(wantsNone && ids.length === 0) && !f.assignees.some((uid) => ids.includes(uid))) return false;
  }
  if (f.priorities.length && !f.priorities.includes(task.priority ?? NO_PRIORITY)) return false;
  if (f.labels.length && !task.labels.some((id) => f.labels.includes(id))) return false;
  const q = f.q.trim().toLocaleLowerCase('tr-TR');
  if (q) {
    const haystack = [task.title, `#${task.id}`, ...task.assignees.map((a) => a.displayName), ...task.labels.map((id) => labelTitles.get(id) ?? '')]
      .join(' ')
      .toLocaleLowerCase('tr-TR');
    if (!haystack.includes(q)) return false;
  }
  return true;
}

// ---- Columns ---------------------------------------------------------------------------------

export interface KanbanColumn {
  stack: BoardPayload['project']['stacks'][number];
  /** Visible (filtered, non-archived) tasks in Deck order. */
  tasks: Task[];
  /** Every non-archived task of the stack, including the ones hidden by filters. */
  fullIds: number[];
  totalCount: number;
}

/** Columns in stack order with filtered cards; archived cards never show (web parity). */
export function kanbanColumns(board: BoardPayload, f: TaskFilters, me: string): KanbanColumn[] {
  const live = board.tasks.filter((t) => !t.archived);
  const byStack = orderByStack(live);
  const byId = new Map(live.map((t) => [t.id, t]));
  const labelTitles = new Map(board.project.labels.map((l) => [l.id, l.title]));
  return board.project.stacks
    .slice()
    .sort((a, b) => a.order - b.order || a.id - b.id)
    .map((stack) => {
      const fullIds = byStack.get(stack.id) ?? [];
      const tasks = fullIds.map((id) => byId.get(id)!).filter((t) => matchesFilters(t, f, labelTitles, me));
      return { stack, tasks, fullIds, totalCount: fullIds.length };
    });
}

/** Planned move of a card to another column (appended after the last visible card), or null when it is a no-op. */
export function moveToColumn(columns: readonly KanbanColumn[], taskId: number, toStackId: number): { stackId: number; order: number } | null {
  const from = columns.find((c) => c.fullIds.includes(taskId));
  const to = columns.find((c) => c.stack.id === toStackId);
  if (!from || !to) return null;
  const order = dropOrder(to.fullIds, taskId, null, to.tasks.map((t) => t.id));
  return isNoopMove(to.fullIds, taskId, from.stack.id, toStackId, order) ? null : { stackId: toStackId, order };
}

/** Planned move one visible slot up/down inside the card's column, or null at the edges. */
export function moveWithinColumn(columns: readonly KanbanColumn[], taskId: number, delta: -1 | 1): { stackId: number; order: number } | null {
  const col = columns.find((c) => c.fullIds.includes(taskId));
  if (!col) return null;
  const order = reorderTarget(col.fullIds, col.tasks.map((t) => t.id), taskId, delta);
  return order === null ? null : { stackId: col.stack.id, order };
}

/** Neighbouring column (for "move left/right"), or null at the board edges. */
export function adjacentColumn(columns: readonly KanbanColumn[], stackId: number, delta: -1 | 1): KanbanColumn | null {
  const i = columns.findIndex((c) => c.stack.id === stackId);
  return i === -1 ? null : columns[i + delta] ?? null;
}

export type DueState = 'none' | 'done' | 'overdue' | 'today' | 'future';

/** Due-date state for the card badge; `todayDay` is the device's local "YYYY-MM-DD". */
export function dueState(due: string | null, done: string | null, now: number, todayDay: string, toLocalDay: (iso: string) => string): DueState {
  if (!due) return 'none';
  if (done) return 'done';
  if (Date.parse(due) < now) return 'overdue';
  return toLocalDay(due) === todayDay ? 'today' : 'future';
}

/** Initials for the avatar fallback ("Ayşe Yılmaz" → "AY"). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const s = parts.length > 1 ? `${parts[0]![0]}${parts[parts.length - 1]![0]}` : (parts[0] ?? '?').slice(0, 2);
  return s.toLocaleUpperCase('tr-TR');
}
