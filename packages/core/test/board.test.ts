import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeFilterCount, adjacentColumn, dropOrder, dueState, emptyFilters, initials, isNoopMove, kanbanColumns, matchesFilters, moveToColumn, moveWithinColumn, orderByStack, reorderTarget,
} from '../src/board';
import type { BoardPayload, Task } from '../src/workhub';

const task = (id: number, stackId: number, order: number, over: Partial<Task> = {}): Task => ({
  id, boardId: 1, stackId, order, title: `Görev ${id}`, labels: [], priority: null, assignees: [], startDate: null, dueDate: null, done: null, archived: false,
  lastModified: '', url: '', subtasks: { done: 0, total: 0 }, ...over,
});

const board = (tasks: Task[]): BoardPayload => ({
  project: {
    board: { id: 1, title: 'P', color: '0082c9' },
    // Deliberately out of order: columns follow `order`.
    stacks: [{ id: 20, title: 'Sürüyor', order: 1, isDone: false }, { id: 10, title: 'Yapılacak', order: 0, isDone: false }, { id: 30, title: 'Bitti', order: 2, isDone: true }],
    labels: [{ id: 5, title: 'Tasarım', color: 'ff0000', priority: null }],
    members: [],
    permissions: { read: true, edit: true, manage: false, share: false },
  },
  tasks,
});

test('orderByStack sorts by order then id', () => {
  const m = orderByStack([task(3, 1, 1), task(1, 1, 1), task(2, 1, 0), task(9, 2, 0)]);
  assert.deepEqual(m.get(1), [2, 1, 3]);
  assert.deepEqual(m.get(2), [9]);
});

test('dropOrder positions against the full order without the dragged card (web parity)', () => {
  assert.equal(dropOrder([1, 2, 3], 9, 2), 1);
  assert.equal(dropOrder([1, 2, 3], 1, 3), 1); // card itself removed first
  assert.equal(dropOrder([1, 2, 3], 9, null), 3);
  // Hidden card 3 after the last visible one: append right after visible 2, not after hidden 3.
  assert.equal(dropOrder([1, 2, 3], 9, null, [1, 2]), 2);
  assert.equal(dropOrder([], 9, null), 0);
  assert.equal(isNoopMove([1, 2, 3], 2, 7, 7, 1), true);
  assert.equal(isNoopMove([1, 2, 3], 2, 7, 8, 1), false);
});

test('reorderTarget moves past visible neighbours only', () => {
  assert.equal(reorderTarget([1, 2, 3, 4], [1, 3, 4], 3, -1), 0);
  assert.equal(reorderTarget([1, 2, 3, 4], [1, 3, 4], 3, 1), 3);
  assert.equal(reorderTarget([1, 2, 3], [1, 2, 3], 1, -1), null);
  assert.equal(reorderTarget([1, 2, 3], [1, 2, 3], 3, 1), null);
});

test('matchesFilters: search, mine, priority, unassigned, labels, done', () => {
  const titles = new Map([[5, 'Tasarım']]);
  const t = task(42, 1, 0, { title: 'Logo İşi', priority: 'high', labels: [5], assignees: [{ type: 'user', id: 'ali', displayName: 'Ali Veli' }] });
  const f = emptyFilters();
  assert.equal(matchesFilters(t, f, titles, 'ali'), true);
  assert.equal(matchesFilters(t, { ...f, q: 'logo i' }, titles, 'ali'), true); // Turkish-aware lowercase of "İ"
  assert.equal(matchesFilters(t, { ...f, q: '#42' }, titles, 'ali'), true);
  assert.equal(matchesFilters(t, { ...f, q: 'tasar' }, titles, 'ali'), true);
  assert.equal(matchesFilters(t, { ...f, q: 'veli' }, titles, 'ali'), true);
  assert.equal(matchesFilters(t, { ...f, q: 'yok' }, titles, 'ali'), false);
  assert.equal(matchesFilters(t, { ...f, mine: true }, titles, 'ali'), true);
  assert.equal(matchesFilters(t, { ...f, mine: true }, titles, 'bob'), false);
  assert.equal(matchesFilters(t, { ...f, priorities: ['urgent'] }, titles, 'ali'), false);
  assert.equal(matchesFilters(task(1, 1, 0), { ...f, priorities: ['none'] }, titles, 'ali'), true);
  assert.equal(matchesFilters(task(1, 1, 0), { ...f, assignees: [''] }, titles, 'ali'), true);
  assert.equal(matchesFilters(t, { ...f, assignees: [''] }, titles, 'ali'), false);
  assert.equal(matchesFilters(t, { ...f, labels: [6] }, titles, 'ali'), false);
  assert.equal(matchesFilters(task(1, 1, 0, { done: '2026-01-01T00:00:00Z' }), { ...f, showDone: false }, titles, 'ali'), false);
  assert.equal(activeFilterCount({ ...f, q: ' x ', mine: true, priorities: ['low', 'high'], showDone: false }), 5);
  assert.equal(activeFilterCount(f), 0);
});

test('kanbanColumns: stack order, archived hidden, filtered vs total counts', () => {
  const b = board([task(1, 10, 1), task(2, 10, 0, { priority: 'urgent' }), task(3, 20, 0, { archived: true }), task(4, 30, 0)]);
  const cols = kanbanColumns(b, { ...emptyFilters(), priorities: ['urgent'] }, 'me');
  assert.deepEqual(cols.map((c) => c.stack.id), [10, 20, 30]);
  assert.deepEqual(cols[0]!.tasks.map((t) => t.id), [2]);
  assert.deepEqual(cols[0]!.fullIds, [2, 1]);
  assert.equal(cols[1]!.totalCount, 0); // archived card never counted
  assert.equal(cols[2]!.totalCount, 1);
});

test('moveToColumn / moveWithinColumn / adjacentColumn', () => {
  const b = board([task(1, 10, 0), task(2, 10, 1), task(3, 20, 0), task(4, 20, 1, { priority: 'low' })]);
  const all = kanbanColumns(b, emptyFilters(), 'me');
  assert.deepEqual(moveToColumn(all, 1, 20), { stackId: 20, order: 2 });
  assert.equal(moveToColumn(all, 2, 10), null); // already last in its own column
  assert.equal(moveToColumn(all, 1, 99), null);
  // Filtered: card 4 hidden → appended after visible card 3, i.e. before hidden 4.
  const filtered = kanbanColumns(b, { ...emptyFilters(), priorities: ['none'] }, 'me');
  assert.deepEqual(moveToColumn(filtered, 1, 20), { stackId: 20, order: 1 });
  assert.deepEqual(moveWithinColumn(all, 2, -1), { stackId: 10, order: 0 });
  assert.equal(moveWithinColumn(all, 1, -1), null);
  assert.equal(adjacentColumn(all, 10, -1), null);
  assert.equal(adjacentColumn(all, 10, 1)!.stack.id, 20);
});

test('dueState and initials', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  const day = (iso: string) => iso.slice(0, 10);
  assert.equal(dueState(null, null, now, '2026-11-03', day), 'none');
  assert.equal(dueState('2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z', now, '2026-11-03', day), 'done');
  assert.equal(dueState('2026-11-03T09:00:00Z', null, now, '2026-11-03', day), 'overdue');
  assert.equal(dueState('2026-11-03T18:00:00Z', null, now, '2026-11-03', day), 'today');
  assert.equal(dueState('2026-11-09T18:00:00Z', null, now, '2026-11-03', day), 'future');
  assert.equal(initials('ayşe yılmaz'), 'AY');
  assert.equal(initials('İsmail'), 'İS');
  assert.equal(initials('  '), '?');
});
