import { OcsError, type OcsClient } from './ocs';

/**
 * Workhub OCS API v1 client (protocol implementation; DTOs are re-declared here, no server
 * code is copied). The server decides native vs Deck backend — never call the Deck API directly.
 */
const BASE = '/ocs/v2.php/apps/workhub/api/v1';

export type Priority = 'urgent' | 'high' | 'normal' | 'low';

export interface ProjectSummary {
  id: number;
  title: string;
  color: string;
  archived: boolean;
  edit: boolean;
  manage: boolean;
  openCount: number;
  doneCount: number;
  overdueCount: number;
}

export interface TaskAssignee {
  type: 'user' | 'group';
  id: string;
  displayName: string;
}

export interface Task {
  id: number;
  boardId: number;
  stackId: number;
  order: number;
  title: string;
  labels: number[];
  priority: Priority | null;
  assignees: TaskAssignee[];
  startDate: string | null;
  dueDate: string | null;
  done: string | null;
  archived: boolean;
  lastModified: string;
  url: string;
  subtasks: { done: number; total: number };
}

export interface SubtaskItem {
  index: number;
  text: string;
  done: boolean;
}

export interface TaskLink {
  id: number;
  title: string;
  done: boolean;
  stackId: number;
  dependencyId: number;
  type: string;
  lagDays: number;
}

export interface TaskDetail extends Task {
  /** Description WITHOUT checklist lines; the server preserves the checklist on PATCH. */
  description: string;
  estimateSec: number | null;
  subtaskItems: SubtaskItem[];
  /** Tasks this task waits for. */
  predecessors: TaskLink[];
  /** Tasks waiting for this task. */
  successors: TaskLink[];
}

export interface ProjectLabel {
  id: number;
  title: string;
  color: string;
  /** Non-null for the labels that encode priority; edit those via `priority`, not `labels`. */
  priority: Priority | null;
}

export interface BoardPayload {
  project: {
    board: { id: number; title: string; color: string };
    stacks: { id: number; title: string; order: number; isDone: boolean }[];
    labels: ProjectLabel[];
    members: { uid: string; displayName: string }[];
    permissions: { read: boolean; edit: boolean; manage: boolean; share: boolean };
    features?: { dependencies?: boolean; doneColumn?: boolean };
  };
  tasks: Task[];
}

export interface SubtaskList {
  cardId: number;
  subtasks: SubtaskItem[];
  progress: { done: number; total: number };
}

export interface TaskPatch {
  title?: string;
  description?: string;
  done?: boolean;
  /** Complete set of user ids (replaces). */
  assignees?: string[];
  /** Complete set of label ids INCLUDING the current priority label (the server replaces the whole set). */
  labels?: number[];
  startDate?: string | null;
  dueDate?: string | null;
  estimateSec?: number | null;
  priority?: Priority | null;
}

export interface TaskComment {
  id: number;
  actorId: string;
  actorDisplayName: string;
  message: string;
  createdAt: string;
}

const id = (n: number) => {
  if (!Number.isInteger(n) || n <= 0) throw new OcsError('client', undefined, 'invalid id');
  return n;
};

const idx = (n: number) => {
  if (!Number.isInteger(n) || n < 0) throw new OcsError('client', undefined, 'invalid index');
  return n;
};

const uuid = (): string => crypto.randomUUID();

export const workhubApi = {
  projects: async (c: OcsClient, includeArchived = false) =>
    (await c.get<{ projects: ProjectSummary[] }>(`${BASE}/projects`, { query: { includeArchived } })).projects,
  board: async (c: OcsClient, boardId: number, view: 'kanban' | 'list' = 'kanban') =>
    c.get<BoardPayload>(`${BASE}/projects/${id(boardId)}/views/${view}`),
  task: async (c: OcsClient, cardId: number) => c.get<TaskDetail>(`${BASE}/tasks/${id(cardId)}`),
  comments: async (c: OcsClient, cardId: number) => (await c.get<{ items: TaskComment[] }>(`${BASE}/tasks/${id(cardId)}/comments`)).items,
  /** Idempotency-Key is supported by this endpoint, so a lost response can be retried with the same key. */
  addComment: async (c: OcsClient, cardId: number, message: string, idempotencyKey: string = uuid()) =>
    (await c.request<TaskComment>(`${BASE}/tasks/${id(cardId)}/comments`, { method: 'POST', body: { message }, headers: { 'Idempotency-Key': idempotencyKey } })).data,
  /** `assignees`/`labels` replace the whole set — always send the complete list. */
  updateTask: async (c: OcsClient, cardId: number, patch: TaskPatch) =>
    (await c.request<Task>(`${BASE}/tasks/${id(cardId)}`, { method: 'PATCH', body: patch })).data,
  // Subtasks are checklist lines of the description. Index-based writes carry the text the
  // client saw at that index (`expectedText`), so a concurrent edit fails instead of hitting
  // the wrong item.
  addSubtask: async (c: OcsClient, cardId: number, text: string) =>
    (await c.request<SubtaskList>(`${BASE}/tasks/${id(cardId)}/subtasks`, { method: 'POST', body: { text } })).data,
  updateSubtask: async (c: OcsClient, cardId: number, index: number, expectedText: string, change: { text?: string; done?: boolean }) =>
    (await c.request<SubtaskList>(`${BASE}/tasks/${id(cardId)}/subtasks/${idx(index)}`, { method: 'PUT', body: { expectedText, ...change } })).data,
  deleteSubtask: async (c: OcsClient, cardId: number, index: number, expectedText: string) =>
    (await c.request<SubtaskList>(`${BASE}/tasks/${id(cardId)}/subtasks/${idx(index)}`, { method: 'DELETE', query: { expectedText } })).data,
  /** `predecessorId` must finish before `successorId` (same project; cycles → 409 DEPENDENCY_CYCLE). */
  addDependency: async (c: OcsClient, predecessorId: number, successorId: number) =>
    (await c.request<{ id: number }>(`${BASE}/tasks/${id(predecessorId)}/dependencies`, { method: 'POST', body: { successorCardId: id(successorId) } })).data,
  removeDependency: async (c: OcsClient, cardId: number, dependencyId: number) => {
    await c.request(`${BASE}/tasks/${id(cardId)}/dependencies/${id(dependencyId)}`, { method: 'DELETE' });
  },
  moveTask: async (c: OcsClient, cardId: number, stackId: number, order: number) =>
    (await c.request<Task>(`${BASE}/tasks/${id(cardId)}/move`, { method: 'POST', body: { stackId: id(stackId), order } })).data,
};

export type TaskOpenResult =
  | { state: 'ok'; task: TaskDetail }
  | { state: 'forbidden' } // access revoked / Projects gate off
  | { state: 'gone' } // task deleted
  | { state: 'feature_off' };

/**
 * Opening a task from a notification ALWAYS re-fetches with current ACL; the notification's
 * captured title is never shown as task content.
 */
export async function openTaskFromNotification(c: OcsClient, cardId: number, projectsEnabled: boolean): Promise<TaskOpenResult> {
  if (!projectsEnabled) return { state: 'feature_off' };
  try {
    return { state: 'ok', task: await workhubApi.task(c, cardId) };
  } catch (e) {
    if (e instanceof OcsError && e.kind === 'forbidden') return { state: e.errorCode === 'PROJECTS_DISABLED' ? 'feature_off' : 'forbidden' };
    if (e instanceof OcsError && e.kind === 'not_found') return { state: 'gone' };
    throw e;
  }
}

// ---- Further modules (Time, Requests, Goals) -----------------------------------

export interface Timer {
  cardId: number | null;
  card: { id: number; title: string } | null;
  description: string;
  billable: boolean;
  startedAt: string;
  elapsedSec: number;
  version: number;
}

export interface TimeEntry {
  id: number;
  cardId: number | null;
  card: { id: number; title: string } | null;
  localDate: string;
  durationSec: number;
  description: string;
  billable: boolean;
  locked: boolean;
}

export interface TimeWeek {
  period: { id: number; localStartDate: string; localEndDate: string; state: string; open: boolean };
  days: { date: string; totalSec: number; billableSec: number }[];
  entries: TimeEntry[];
  totals: { totalSec: number; billableSec: number };
  timer: Timer | null;
  serverTime: string;
}

export interface WorkRequest {
  id: number;
  version: number;
  title: string;
  description: string;
  requesterName: string;
  recipientName: string;
  state: string;
  canRespond: boolean;
  createdAt: string;
}

export interface RequestContext {
  uid: string;
  manager: { uid: string; displayName: string } | null;
  managers: { uid: string; displayName: string }[];
  isManager: boolean;
}

export interface GoalSummary {
  id: number;
  title: string;
  progressBp: number | null;
  state: string;
  owner: string;
}

export const workhubModulesApi = {
  timer: (c: OcsClient) => c.get<{ timer: Timer | null; serverTime: string }>(`${BASE}/time/timer`),
  /** One active timer per user (server enforced: 409 TIMER_ALREADY_RUNNING). */
  timerStart: async (c: OcsClient, body: { cardId?: number; description?: string }, idempotencyKey: string) =>
    (await c.request<{ timer: Timer }>(`${BASE}/time/timer/start`, { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey } })).data,
  timerStop: async (c: OcsClient) => (await c.request<{ entries: TimeEntry[]; totalSec: number }>(`${BASE}/time/timer/stop`, { method: 'POST', body: {} })).data,
  week: (c: OcsClient, date?: string) => c.get<TimeWeek>(`${BASE}/time/week`, date ? { query: { date } } : {}),
  requests: async (c: OcsClient, scope: 'mine' | 'received' | 'team') => (await c.get<{ items: WorkRequest[] }>(`${BASE}/requests`, { query: { scope, state: 'any' } })).items,
  requestContext: (c: OcsClient) => c.get<RequestContext>(`${BASE}/requests/context`),
  createRequest: async (c: OcsClient, body: { title: string; description: string; recipientUid?: string }, idempotencyKey: string) =>
    (await c.request<{ id: number }>(`${BASE}/requests`, { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey } })).data,
  goals: async (c: OcsClient) => (await c.get<{ items: GoalSummary[] }>(`${BASE}/goals`)).items,
};

// ---- Task edit form → minimal PATCH ----------------------------------------------

export interface TaskForm {
  title: string;
  description: string;
  priority: Priority | null;
  /** `YYYY-MM-DD` or '' (no date). */
  startDate: string;
  dueDate: string;
  /** Hours as typed ('' = no estimate); comma or dot decimals. */
  estimateHours: string;
  /** Selected NON-priority label ids. */
  labels: number[];
  /** Selected user ids (board members). */
  assignees: string[];
}

export type TaskFormError = 'title_empty' | 'date_invalid' | 'date_range' | 'estimate_invalid';

const dayOf = (iso: string | null) => (iso ? iso.slice(0, 10) : '');
const sameSet = <T>(a: T[], b: T[]) => a.length === b.length && a.every((x) => b.includes(x));

export function taskFormOf(task: TaskDetail, labels: ProjectLabel[]): TaskForm {
  const priorityIds = new Set(labels.filter((l) => l.priority).map((l) => l.id));
  return {
    title: task.title,
    description: task.description,
    priority: task.priority,
    startDate: dayOf(task.startDate),
    dueDate: dayOf(task.dueDate),
    estimateHours: task.estimateSec == null ? '' : String(Math.round((task.estimateSec / 3600) * 100) / 100),
    labels: task.labels.filter((id) => !priorityIds.has(id)),
    assignees: task.assignees.filter((a) => a.type === 'user').map((a) => a.id),
  };
}

/**
 * Only changed fields are sent. Labels are a full replace on the server, so the task's current
 * priority label ids are kept in the set (a priority change is applied after labels).
 */
export function buildTaskPatch(task: TaskDetail, labels: ProjectLabel[], form: TaskForm): { patch: TaskPatch } | { error: TaskFormError } {
  const base = taskFormOf(task, labels);
  const title = form.title.trim();
  if (!title) return { error: 'title_empty' };
  const date = /^\d{4}-\d{2}-\d{2}$/;
  const valid = (d: string) => d === '' || (date.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d));
  const start = form.startDate.trim();
  const due = form.dueDate.trim();
  if (!valid(start) || !valid(due)) return { error: 'date_invalid' };
  if (start && due && start > due) return { error: 'date_range' };
  let estimateSec: number | null = null;
  const est = form.estimateHours.trim().replace(',', '.');
  if (est) {
    const h = Number(est);
    if (!/^\d+(\.\d+)?$/.test(est) || !Number.isFinite(h) || h > 10_000) return { error: 'estimate_invalid' };
    estimateSec = Math.round(h * 3600);
  }
  const patch: TaskPatch = {};
  if (title !== task.title) patch.title = title;
  if (form.description !== base.description) patch.description = form.description;
  if (form.priority !== base.priority) patch.priority = form.priority;
  if (start !== base.startDate) patch.startDate = start || null;
  if (due !== base.dueDate) patch.dueDate = due || null;
  if (estimateSec !== (task.estimateSec ?? null)) patch.estimateSec = estimateSec;
  if (!sameSet(form.labels, base.labels)) {
    const priorityIds = new Set(labels.filter((l) => l.priority).map((l) => l.id));
    patch.labels = [...new Set([...form.labels.filter((id) => !priorityIds.has(id)), ...task.labels.filter((id) => priorityIds.has(id))])];
  }
  if (!sameSet(form.assignees, base.assignees)) patch.assignees = [...new Set(form.assignees)];
  return { patch };
}
