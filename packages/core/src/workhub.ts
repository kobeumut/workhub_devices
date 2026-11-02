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

export interface TaskDetail extends Task {
  description: string;
}

export interface BoardPayload {
  project: {
    board: { id: number; title: string; color: string };
    stacks: { id: number; title: string; order: number; isDone: boolean }[];
    permissions: { read: boolean; edit: boolean; manage: boolean; share: boolean };
  };
  tasks: Task[];
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
  updateTask: async (c: OcsClient, cardId: number, patch: Partial<Pick<TaskDetail, 'title' | 'description' | 'priority' | 'dueDate' | 'startDate'>> & { done?: boolean; assignees?: string[]; labels?: number[] }) =>
    (await c.request<Task>(`${BASE}/tasks/${id(cardId)}`, { method: 'PATCH', body: patch })).data,
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
