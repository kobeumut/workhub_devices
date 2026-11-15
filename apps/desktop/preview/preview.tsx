/**
 * Offline design preview: the real shared UI (`@workhub-devices/features`) on a fixture backend,
 * used for screenshots when no live server is available (`npm run preview:shots`). Not part of
 * the shipped renderer bundle. Writes are applied to the in-memory fixture so moves/toggles show.
 */
import { createRoot } from 'react-dom/client';
import type { Backend, BoardPayload, Task, TaskDetail } from '@workhub-devices/core';
import { WorkhubApp, type PlatformServices } from '@workhub-devices/features';
import { setLocale } from '@workhub-devices/features/src/i18n/core';
import { messages, t as cm } from '@workhub-devices/features/src/i18n/messages';

const now = Date.now();
const day = (d: number) => new Date(now + d * 86_400_000).toISOString();
const people = {
  alice: { type: 'user' as const, id: 'alice', displayName: 'Alice Johnson' },
  ben: { type: 'user' as const, id: 'ben', displayName: 'Ben Carter' },
  zoe: { type: 'user' as const, id: 'zoe', displayName: 'Zoe Martin' },
  chris: { type: 'user' as const, id: 'chris', displayName: 'Chris Evans' },
};
/** Fixture names the screenshot script also needs (it reads them back through `window.__preview`). */
const NAMES = {
  project: 'Mobile App',
  todo: 'To do',
  doing: 'In progress',
  review: 'In review',
  done: 'Done',
  menuTask: 'Talk search API research',
  openTask: 'New design for the login screen',
  newTask: 'Preview task',
};
let seq = 200;
const task = (id: number, stackId: number, order: number, title: string, o: Partial<Task> = {}): Task => ({
  id, boardId: 7, stackId, order, title, labels: [], priority: null, assignees: [], startDate: null, dueDate: null, done: null, archived: false, lastModified: '', url: '', subtasks: { done: 0, total: 0 }, ...o,
});
const board: BoardPayload = {
  project: {
    board: { id: 7, title: NAMES.project, color: '0082c9' },
    stacks: [
      { id: 1, title: NAMES.todo, order: 0, isDone: false },
      { id: 2, title: NAMES.doing, order: 1, isDone: false },
      { id: 3, title: NAMES.review, order: 2, isDone: false },
      { id: 4, title: NAMES.done, order: 3, isDone: true },
    ],
    labels: [
      { id: 11, title: 'Design', color: '7c3aed', priority: null },
      { id: 12, title: 'Backend', color: '0891b2', priority: null },
      { id: 13, title: 'Mobile', color: 'd97706', priority: null },
    ],
    members: Object.values(people).map((p) => ({ uid: p.id, displayName: p.displayName })),
    permissions: { read: true, edit: true, manage: true, share: true },
  },
  tasks: [
    task(101, 1, 0, NAMES.openTask, { priority: 'high', labels: [11, 13], assignees: [people.alice], dueDate: day(3), subtasks: { done: 1, total: 4 } }),
    task(102, 1, 1, 'Notification permission texts', { priority: 'low', labels: [13], dueDate: day(9) }),
    task(103, 1, 2, NAMES.menuTask, { priority: 'normal', labels: [12], assignees: [people.chris, people.ben] }),
    task(104, 2, 0, 'Kanban drag and drop', { priority: 'urgent', labels: [13], assignees: [people.ben, people.zoe, people.alice, people.chris], dueDate: day(-1), subtasks: { done: 3, total: 5 } }),
    task(105, 2, 1, 'Refresh project counters', { priority: 'normal', labels: [12], assignees: [people.zoe], dueDate: day(0) }),
    task(106, 3, 0, 'Premium icon set (Lucide)', { priority: 'high', labels: [11], assignees: [people.alice], subtasks: { done: 6, total: 6 } }),
    task(107, 4, 0, 'Login Flow v2', { assignees: [people.ben], done: day(-4), dueDate: day(-5), subtasks: { done: 2, total: 2 } }),
    task(108, 4, 1, 'Multi-account support', { labels: [12], assignees: [people.chris], done: day(-2) }),
  ],
};
const detail = (id: number): TaskDetail => {
  const t = board.tasks.find((x) => x.id === id)!;
  return { ...t, description: 'Same look as the Workhub web screen: columns, cards, priority and date badges.', estimateSec: 5400, subtaskItems: [], predecessors: [], successors: [] };
};
const projects = [
  { id: 7, title: NAMES.project, color: '0082c9', archived: false, edit: true, manage: true, share: true, openCount: 6, doneCount: 2, overdueCount: 1 },
  { id: 8, title: 'Marketing Q4', color: 'db2777', archived: false, edit: true, manage: false, openCount: 12, doneCount: 30, overdueCount: 0 },
  { id: 9, title: 'Infrastructure', color: '059669', archived: false, edit: true, manage: false, openCount: 4, doneCount: 9, overdueCount: 2 },
];
const account = { id: 'acc1', serverBase: 'https://cloud.example.com', loginName: 'alice' };
const fixtures: Partial<Record<keyof Backend, (...a: any[]) => unknown>> = {
  listAccounts: () => [account],
  session: () => ({
    account, nextcloudVersion: '35.0.2', talkVersion: '25.0.6', talkFeatures: [], talkCanCreate: true, talkAttachmentsAllowed: true, issues: [], webPush: true,
    workhub: { apiVersion: '1', user: { uid: 'alice', displayName: 'Alice Johnson', isAdmin: false, timezone: 'UTC' }, modules: { projects: true, dashboard: true, ai: true, goals: true, requests: true, time: true }, permissions: { canViewTeamReport: true }, backend: 'native' },
  }),
  rooms: () => ({
    rooms: [
      { token: 'r1', type: 2, name: 'mobile', displayName: 'Mobile team', unreadMessages: 3, unreadMention: true, isFavorite: true, lastActivity: now / 1000 - 120, readOnly: 0, lastMessage: { id: 1, message: 'Is the Kanban screen ready?', actorDisplayName: 'Ben Carter' } },
      { token: 'r2', type: 1, name: 'zoe', displayName: 'Zoe Martin', unreadMessages: 0, unreadMention: false, isFavorite: false, lastActivity: now / 1000 - 3600, readOnly: 0, lastMessage: { id: 2, message: 'Thanks!', actorDisplayName: 'Zoe Martin' } },
    ],
    modifiedBefore: null, talkHash: null,
  }),
  projects: () => projects,
  board: () => structuredClone(board),
  openTask: (_a: string, id: number) => ({ state: 'ok', task: detail(id) }),
  comments: () => [{ id: 1, actorDisplayName: 'Ben Carter', createdAt: day(-1), message: 'Keep the design identical to the web.' }],
  moveTask: (_a: string, id: number, stackId: number, order: number) => {
    const t = board.tasks.find((x) => x.id === id)!;
    const ids = board.tasks.filter((x) => x.stackId === stackId && x.id !== id).sort((a, b) => a.order - b.order).map((x) => x.id);
    ids.splice(order, 0, id);
    t.stackId = stackId;
    ids.forEach((tid, i) => (board.tasks.find((x) => x.id === tid)!.order = i));
    return t;
  },
  updateTask: (_a: string, id: number, patch: { done?: boolean }) => {
    const t = board.tasks.find((x) => x.id === id)!;
    if (patch.done !== undefined) t.done = patch.done ? new Date().toISOString() : null;
    return t;
  },
  createTask: (_a: string, _b: number, stackId: number, title: string) => {
    const t = task(++seq, stackId, 99, title);
    board.tasks.push(t);
    return t;
  },
  notifications: () => [],
};
const backend = new Proxy({} as Backend, {
  get: (_t, name: string) => async (...args: unknown[]) => {
    const f = fixtures[name as keyof Backend];
    if (!f) throw Object.assign(new Error(`Not available in the preview: ${name}`), { kind: 'client' });
    return f(...args);
  },
});
// The preview always renders in English: the screenshot script finds controls by their English text.
const platform: PlatformServices = {
  kind: 'desktop',
  openExternal: async () => undefined,
  setBadgeCount: () => undefined,
  appVersion: 'preview',
  localePreference: { load: async () => 'en', save: async () => undefined },
} as PlatformServices;

// Texts the screenshot script clicks, resolved from the same catalogs the UI renders (so they cannot drift).
setLocale('en');
const ts = messages.tasks;
(window as unknown as { __preview: Record<string, string> }).__preview = {
  ...NAMES,
  tasksTab: cm.tasks,
  filters: ts.filters,
  urgent: ts.priorityUrgent,
  clear: ts.clear,
  addTask: ts.addTask,
  add: ts.add,
  close: cm.close,
  back: cm.back,
  listView: ts.viewList,
  menuTaskActions: ts.taskActionsLabel(NAMES.menuTask),
  moveRight: ts.moveRightTo(NAMES.doing),
  doingColumn3: ts.columnLabel(NAMES.doing, 3),
  reviewColumn2: ts.columnLabel(NAMES.review, 2),
  // "New task in <list>": the list name follows the text, so the script matches the prefix.
  newTaskInputPrefix: ts.newTaskInList('\u0001').split('\u0001')[0]!,
  // "In review, N tasks": everything before the count.
  reviewColumnPrefix: `${NAMES.review}, `,
};
createRoot(document.getElementById('root')!).render(<WorkhubApp backend={backend} platform={platform} />);
