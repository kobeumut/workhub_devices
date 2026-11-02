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
  /** May add members (Deck "share" permission). */
  share?: boolean;
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

export interface StackSummary {
  id: number;
  title: string;
  order: number;
  isDone: boolean;
}

/** User or group returned by the share-subject search (`GET /principals?q=`). */
export interface Principal {
  principalType: 'user' | 'group';
  principalId: string;
  displayName: string;
}

/** A project ACL row to add. Grants above the actor's own permissions are clamped by the server. */
export interface MemberGrant {
  type: 'user' | 'group';
  participant: string;
  edit: boolean;
  share: boolean;
  manage: boolean;
}

/** Objects with Workhub's own ACL (projects use Deck/native board ACL instead). */
export const SHARE_OBJECT_TYPES = ['dashboard', 'goal', 'workflow'] as const;
export type ShareObjectType = (typeof SHARE_OBJECT_TYPES)[number];
export const SHARE_ROLES = ['view', 'edit', 'manage'] as const;
export type ShareRole = (typeof SHARE_ROLES)[number];

export interface ObjectShare {
  principalType: 'user' | 'group';
  principalId: string;
  displayName: string;
  role: ShareRole;
}

export interface ObjectShares {
  owner: { uid: string; displayName: string };
  shares: ObjectShare[];
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

const text = (v: string, max: number) => {
  const s = v.trim();
  if (!s || s.length > max) throw new OcsError('client', undefined, 'invalid title');
  return s;
};

const shareType = (t: string): ShareObjectType => {
  if (!(SHARE_OBJECT_TYPES as readonly string[]).includes(t)) throw new OcsError('client', undefined, 'invalid object type');
  return t as ShareObjectType;
};

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

  // ---- Project management. The server checks `manage` (rename, columns) and `share` (members). ----
  /** Creates the project with To Do / In Progress / Done columns. Idempotent with the same key. */
  createProject: async (c: OcsClient, title: string, color: string | undefined, idempotencyKey: string = uuid()) =>
    (await c.request<Pick<ProjectSummary, 'id' | 'title' | 'color' | 'openCount' | 'doneCount' | 'overdueCount'>>(`${BASE}/projects`, {
      method: 'POST',
      body: { title: text(title, PROJECT_TITLE_MAX), ...(color ? { color } : {}) },
      headers: { 'Idempotency-Key': idempotencyKey },
    })).data,
  renameProject: async (c: OcsClient, boardId: number, title: string) =>
    (await c.request<{ id: number; title: string }>(`${BASE}/projects/${id(boardId)}`, { method: 'PATCH', body: { title: text(title, RENAME_MAX) } })).data,
  /** 409 `PROJECT_MEMBER_EXISTS` when the user/group already has direct access. There is no remove API. */
  addProjectMember: async (c: OcsClient, boardId: number, grant: MemberGrant, idempotencyKey: string = uuid()) =>
    (await c.request<{ id: number }>(`${BASE}/projects/${id(boardId)}/members`, {
      method: 'POST',
      body: { type: grant.type, participant: grant.participant, edit: grant.edit, share: grant.share, manage: grant.manage },
      headers: { 'Idempotency-Key': idempotencyKey },
    })).data,
  createStack: async (c: OcsClient, boardId: number, title: string, order: number) =>
    (await c.request<StackSummary>(`${BASE}/projects/${id(boardId)}/stacks`, { method: 'POST', body: { title: text(title, STACK_TITLE_MAX), order: idx(order) } })).data,
  renameStack: async (c: OcsClient, stackId: number, title: string) =>
    (await c.request<{ id: number; title: string }>(`${BASE}/stacks/${id(stackId)}`, { method: 'PATCH', body: { title: text(title, RENAME_MAX) } })).data,

  // ---- Users/groups search and Workhub object shares (dashboard, goal, workflow). ----
  /** Local users and groups by display name; empty query → no request. */
  principals: async (c: OcsClient, q: string): Promise<Principal[]> => {
    const query = q.trim().slice(0, 64);
    if (!query) return [];
    return (await c.get<{ principals: Principal[] }>(`${BASE}/principals`, { query: { q: query } })).principals;
  },
  /** Requires the `manage` role on the object (owner or a manage share). */
  objectShares: async (c: OcsClient, type: ShareObjectType, objectId: number) =>
    c.get<ObjectShares>(`${BASE}/objects/${shareType(type)}/${id(objectId)}/shares`),
  /** Replaces the whole share list (the owner is implicit and never listed). */
  setObjectShares: async (c: OcsClient, type: ShareObjectType, objectId: number, shares: Array<Pick<ObjectShare, 'principalType' | 'principalId' | 'role'>>) =>
    (await c.request<{ shares: ObjectShare[] }>(`${BASE}/objects/${shareType(type)}/${id(objectId)}/shares`, {
      method: 'PUT',
      body: { shares: shares.map((s) => ({ principalType: s.principalType, principalId: s.principalId, role: s.role })) },
    })).data,
};

/** Server limits: project create 255, rename (project/column) 100, column create 255. */
export const PROJECT_TITLE_MAX = 255;
export const RENAME_MAX = 100;
export const STACK_TITLE_MAX = 255;

/** Next column position: after the last existing column (the server default 999 would also work but drifts). */
export const nextStackOrder = (stacks: Array<{ order: number }>) => (stacks.length ? Math.max(...stacks.map((s) => s.order)) + 1 : 0);

/** Replace-or-add one principal in a share list (the server replaces the whole list on save). */
export function upsertShare(list: ObjectShare[], p: Principal, role: ShareRole): ObjectShare[] {
  const rest = list.filter((s) => !(s.principalType === p.principalType && s.principalId === p.principalId));
  return [...rest, { principalType: p.principalType, principalId: p.principalId, displayName: p.displayName, role }];
}

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

export interface TimeCardRef {
  id: number;
  title: string;
  boardId?: number | null;
  restricted?: boolean;
}

export interface Timer {
  cardId: number | null;
  card: TimeCardRef | null;
  description: string | null;
  billable: boolean;
  startedAt: string;
  elapsedSec: number;
  version: number;
}

export interface TimeEntry {
  id: number;
  kind: 'range' | 'duration';
  cardId: number | null;
  card: TimeCardRef | null;
  /** ISO-8601 UTC; null for duration entries. */
  startUtc: string | null;
  endUtc: string | null;
  localDate: string;
  durationSec: number;
  zone: string;
  description: string | null;
  billable: boolean;
  origin: string;
  periodId: number;
  version: number;
  /**
   * Set by the server only in period payloads (`/time/week`, `/time/periods/{id}`); treat the
   * entry as read-only when this OR its period is not open.
   */
  locked: boolean;
  slices: { localDate: string; durationSec: number }[];
}

export type PeriodState = 'draft' | 'submitted' | 'changes_requested' | 'approved' | 'reopened';

export interface TimePeriod {
  id: number;
  userUid: string;
  localStartDate: string;
  localEndDate: string;
  zone: string;
  state: PeriodState;
  open: boolean;
  revision: number;
  /** Optimistic lock for submit / withdraw / review decisions. */
  version: number;
}

export type SubmissionStatus = 'pending' | 'approved' | 'changes_requested' | 'withdrawn' | 'superseded';

export interface TimeSubmission {
  id: number;
  periodId: number;
  revision: number;
  status: SubmissionStatus;
  submittedBy: string;
  submittedAt: string;
  totalSec: number;
  billableSec: number;
  reviews: { actorUid: string; action: string; reason: string | null; occurredAt: string }[];
}

export interface TimePolicySummary {
  zone: string;
  weekStart: number;
  overlap: 'allow' | 'warn' | 'reject';
  allowTaskless: boolean;
  maxEntrySeconds: number;
}

export interface TimeWeek {
  period: TimePeriod;
  days: { date: string; totalSec: number; billableSec: number }[];
  entries: TimeEntry[];
  totals: { totalSec: number; billableSec: number };
  submissions: TimeSubmission[];
  timer: Timer | null;
  serverTime: string;
  policy: TimePolicySummary;
  navigation: { today: string; prevDate: string; nextDate: string };
  /** False when the user has no manager: submitting would wait for nobody. */
  reviewerConfigured: boolean;
}

/** Fields of a manual entry. `version` is required for updates (optimistic lock). */
export type TimeEntryInput =
  | { kind: 'range'; startUtc: string; endUtc: string; timezone: string; description?: string | null; billable?: boolean; cardId?: number | null }
  | { kind: 'duration'; localDate: string; durationSeconds: number; timezone: string; description?: string | null; billable?: boolean; cardId?: number | null };

export interface TimeEntryPatch {
  version: number;
  startUtc?: string;
  endUtc?: string;
  localDate?: string;
  durationSeconds?: number;
  timezone?: string;
  description?: string | null;
  billable?: boolean;
  cardId?: number | null;
}

export interface TimeEntryResult {
  entries: TimeEntry[];
  /** e.g. `TIME_OVERLAP` under the `warn` overlap policy; the entry was saved. */
  warnings: { code: string; message: string }[];
}

export interface SubmissionResult {
  period: TimePeriod;
  submission: TimeSubmission;
}

/** One submission in the reviewer queue (or a single one via `/time/submissions/{id}`). */
export interface ReviewItem {
  submission: TimeSubmission;
  period: TimePeriod;
  user: { uid: string; displayName: string };
  /** Frozen snapshot of the submitted entries. */
  entries: Array<Omit<TimeEntry, 'id' | 'cardId' | 'zone' | 'periodId' | 'version' | 'locked'> & { entryId: number; entryVersion: number }>;
  canReview: boolean;
}

export type ReviewAction = 'approve' | 'request_changes' | 'reopen';

export interface TeamReport {
  from: string;
  to: string;
  users: Array<{
    uid: string;
    displayName: string;
    totalSec: number;
    billableSec: number;
    byState: Partial<Record<PeriodState, number>>;
    days: { date: string; totalSec: number }[];
    cards: { key: string; title: string; restricted: boolean; totalSec: number }[];
  }>;
  totals: { totalSec: number; billableSec: number };
}

export type CsvScope = 'own' | 'team';

const posId = (id: number) => {
  if (!Number.isInteger(id) || id <= 0) throw new OcsError('client', undefined, 'invalid id');
  return id;
};
const keyHeader = (k: string) => ({ 'Idempotency-Key': k });

export const timeApi = {
  week: (c: OcsClient, date?: string) => c.get<TimeWeek>(`${BASE}/time/week`, date ? { query: { date } } : {}),
  period: (c: OcsClient, periodId: number) => c.get<TimeWeek & { viewerRole: 'owner' | 'reviewer'; user: { uid: string; displayName: string } }>(`${BASE}/time/periods/${posId(periodId)}`),
  createEntry: async (c: OcsClient, input: TimeEntryInput, idempotencyKey: string) => {
    const { kind, ...rest } = input;
    return (await c.request<TimeEntryResult>(`${BASE}/time/entries`, { method: 'POST', body: { entryKind: kind, ...rest }, headers: keyHeader(idempotencyKey) })).data;
  },
  updateEntry: async (c: OcsClient, id: number, patch: TimeEntryPatch) =>
    (await c.request<TimeEntryResult>(`${BASE}/time/entries/${posId(id)}`, { method: 'PATCH', body: patch })).data,
  deleteEntry: async (c: OcsClient, id: number, version: number) =>
    (await c.request<{ deleted: number }>(`${BASE}/time/entries/${posId(id)}`, { method: 'DELETE', body: { version } })).data,
  submit: async (c: OcsClient, periodId: number, version: number, idempotencyKey: string) =>
    (await c.request<SubmissionResult>(`${BASE}/time/periods/${posId(periodId)}/submit`, { method: 'POST', body: { version }, headers: keyHeader(idempotencyKey) })).data,
  withdraw: async (c: OcsClient, submissionId: number, version: number, idempotencyKey: string) =>
    (await c.request<SubmissionResult>(`${BASE}/time/submissions/${posId(submissionId)}/withdraw`, { method: 'POST', body: { version }, headers: keyHeader(idempotencyKey) })).data,
  reviews: async (c: OcsClient, status: 'pending' | 'approved') => (await c.get<{ items: ReviewItem[] }>(`${BASE}/time/reviews`, { query: { status } })).items,
  submission: (c: OcsClient, id: number) => c.get<ReviewItem>(`${BASE}/time/submissions/${posId(id)}`),
  /** Period `version` (not submission) is the lock; `reason` is required except for approve. */
  decide: async (c: OcsClient, submissionId: number, action: ReviewAction, version: number, reason: string | null, idempotencyKey: string) => {
    const path = action === 'approve' ? 'approve' : action === 'request_changes' ? 'request-changes' : 'reopen';
    const body: Record<string, unknown> = { version };
    if (reason) body.reason = reason;
    return (await c.request<SubmissionResult>(`${BASE}/time/submissions/${posId(submissionId)}/${path}`, { method: 'POST', body, headers: keyHeader(idempotencyKey) })).data;
  },
  team: (c: OcsClient, from?: string, to?: string) => c.get<TeamReport>(`${BASE}/time/team`, { query: { from, to } }),
  /** Non-OCS route (`TimeCsvController`); the server caps the range at 366 days. */
  csv: async (c: OcsClient, scope: CsvScope, from: string, to: string) => {
    const r = await c.download('/index.php/apps/workhub/csv/time', { query: { scope, from, to } });
    // The server writes a UTF-8 BOM (Excel); `Response.text()` strips it, so put it back.
    return { filename: timeCsvFilename(scope, from, to), csv: r.text.startsWith('\uFEFF') ? r.text : `\uFEFF${r.text}` };
  },
};

/** Filename built locally from validated parts (never from a server header). */
export const timeCsvFilename = (scope: CsvScope, from: string, to: string) => `workhub-time-${scope}-${from}_${to}.csv`;

// ---- Time entry form → request body (pure) ---------------------------------------

export interface TimeEntryForm {
  kind: 'range' | 'duration';
  /** `YYYY-MM-DD` in the user's zone. */
  date: string;
  /** `HH:MM` (range only). An end before the start means the next day. */
  start: string;
  end: string;
  /** Hours as typed for duration entries ('1,5' / '1.5' / '1:30'). */
  hours: string;
  description: string;
  billable: boolean;
}

export type TimeFormError = 'date_invalid' | 'time_invalid' | 'duration_invalid' | 'too_long' | 'description_required' | 'description_too_long';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isValidLocalDate = (d: string) => {
  if (!DATE_RE.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().startsWith(d);
};

/** Offset (minutes, east positive) of `zone` at the UTC instant `ms`, via Intl (no tz database copy). */
function zoneOffsetMinutes(zone: string, ms: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour') % 24, n('minute'), n('second'));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** Local wall time in `zone` → UTC ISO (`…Z`). Two passes settle DST edges. */
export function zonedToUtc(date: string, hhmm: string, zone: string): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let ts = wall - zoneOffsetMinutes(zone, wall) * 60000;
  ts = wall - zoneOffsetMinutes(zone, ts) * 60000;
  return new Date(ts).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** UTC ISO → `{date, time}` wall clock in `zone`. */
export function utcToZoned(iso: string, zone: string): { date: string; time: string } {
  const ms = Date.parse(iso);
  const local = new Date(ms + zoneOffsetMinutes(zone, ms) * 60000).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

function parseHours(raw: string): number | null {
  const v = raw.trim();
  const hm = /^(\d{1,2}):([0-5]\d)$/.exec(v);
  if (hm) return Number(hm[1]) * 3600 + Number(hm[2]) * 60;
  if (!/^\d+([.,]\d+)?$/.test(v)) return null;
  return Math.round(Number(v.replace(',', '.')) * 3600);
}

export function timeEntryFormOf(entry: TimeEntry | null, zone: string, today: string): TimeEntryForm {
  if (!entry) return { kind: 'range', date: today, start: '09:00', end: '10:00', hours: '', description: '', billable: false };
  const base = { kind: entry.kind, description: entry.description ?? '', billable: entry.billable, hours: '', start: '', end: '', date: entry.localDate };
  if (entry.kind === 'duration') return { ...base, hours: String(Math.round((entry.durationSec / 3600) * 100) / 100) };
  const s = utcToZoned(entry.startUtc!, zone);
  const e = utcToZoned(entry.endUtc!, zone);
  return { ...base, date: s.date, start: s.time, end: e.time };
}

/**
 * Validates the form and builds the create body (or, with `entry`, the minimal PATCH incl.
 * `version`). Mirrors the server rules that the user can fix in the form; the server stays the
 * authority (locked periods, overlap policy, card permission).
 */
export function buildTimeEntry(form: TimeEntryForm, zone: string, opts: { maxEntrySeconds: number; allowTaskless: boolean; cardId?: number | null }, entry?: TimeEntry):
  | { create: TimeEntryInput }
  | { patch: TimeEntryPatch }
  | { error: TimeFormError } {
  if (!isValidLocalDate(form.date)) return { error: 'date_invalid' };
  const description = form.description.trim();
  if (description.length > 1000) return { error: 'description_too_long' };
  const cardId = entry ? entry.cardId : (opts.cardId ?? null);
  if (!description && cardId === null) return { error: 'description_required' };
  let time: { startUtc: string; endUtc: string } | { localDate: string; durationSeconds: number };
  if (form.kind === 'range') {
    const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!hm.test(form.start) || !hm.test(form.end)) return { error: 'time_invalid' };
    const startUtc = zonedToUtc(form.date, form.start, zone);
    let endDate = form.date;
    if (form.end <= form.start) endDate = new Date(Date.parse(`${form.date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    const endUtc = zonedToUtc(endDate, form.end, zone);
    const sec = (Date.parse(endUtc) - Date.parse(startUtc)) / 1000;
    if (sec <= 0) return { error: 'time_invalid' };
    if (sec > opts.maxEntrySeconds) return { error: 'too_long' };
    time = { startUtc, endUtc };
  } else {
    const sec = parseHours(form.hours);
    if (sec === null || sec <= 0) return { error: 'duration_invalid' };
    if (sec > opts.maxEntrySeconds) return { error: 'too_long' };
    time = { localDate: form.date, durationSeconds: sec };
  }
  if (!entry) {
    const extra = { timezone: zone, description: description || null, billable: form.billable, ...(cardId ? { cardId } : {}) };
    return { create: form.kind === 'range' ? { kind: 'range', ...(time as { startUtc: string; endUtc: string }), ...extra } : { kind: 'duration', ...(time as { localDate: string; durationSeconds: number }), ...extra } };
  }
  if (entry.kind !== form.kind) return { error: 'time_invalid' };
  const patch: TimeEntryPatch = { version: entry.version };
  if ('startUtc' in time) {
    if (time.startUtc !== entry.startUtc) patch.startUtc = time.startUtc;
    if (time.endUtc !== entry.endUtc) patch.endUtc = time.endUtc;
  } else {
    if (time.localDate !== entry.localDate) patch.localDate = time.localDate;
    if (time.durationSeconds !== entry.durationSec) patch.durationSeconds = time.durationSeconds;
  }
  if (Object.keys(patch).length > 1 && zone !== entry.zone) patch.timezone = zone;
  if ((description || null) !== (entry.description ?? null)) patch.description = description || null;
  if (form.billable !== entry.billable) patch.billable = form.billable;
  return { patch };
}

/** Owner-side period actions, derived only from server state (no local guessing of locks). */
export function periodActions(week: Pick<TimeWeek, 'period' | 'submissions'>): { canEdit: boolean; canSubmit: boolean; withdrawable: TimeSubmission | null } {
  const current = week.submissions.find((s) => s.revision === week.period.revision) ?? null;
  return {
    canEdit: week.period.open,
    canSubmit: week.period.open,
    withdrawable: week.period.state === 'submitted' && current?.status === 'pending' ? current : null,
  };
}

/** An entry may be edited/deleted only when the server says neither it nor its period is locked. */
export const entryEditable = (week: Pick<TimeWeek, 'period'>, e: TimeEntry) => week.period.open && !e.locked && e.periodId === week.period.id;

export type RequestState = 'pending' | 'rejected' | 'open' | 'converted' | 'resolved';
export type RequestTaskState = 'open' | 'closed' | 'missing' | null;

/** Linked task as the server resolves it for the caller (null when not readable → `cardRestricted`). */
export interface RequestCard {
  id: number;
  boardId: number;
  boardTitle: string;
  stackId: number;
  stackTitle: string;
  title: string;
  done: string | null;
  due: string | null;
  archived: boolean;
  url: string;
}

export interface WorkRequest {
  id: number;
  /** Optimistic lock for respond / resolve / convert. */
  version: number;
  title: string;
  description: string;
  requesterUid: string;
  requesterName: string;
  recipientName: string;
  managerName: string | null;
  /** Caller is in the approval subject's management chain (only meaningful once consented). */
  canManage: boolean;
  /** Caller is the recipient of a pending request. */
  canRespond: boolean;
  rejectionReason: string | null;
  respondedAt: string | null;
  state: RequestState;
  taskState: RequestTaskState;
  createdAt: string;
  convertedAt: string | null;
  resolvedAt: string | null;
  taskClosedAt: string | null;
  checkedAt: string | null;
  /** Only in detail / mutation responses. */
  card: RequestCard | null;
  cardRestricted: boolean;
}

export interface RequestEvent {
  id: number;
  actorUid: string;
  action: string;
  reason: string | null;
  changes: { doneAt?: string | null; source?: string; recipientUid?: string; state?: string } | null;
  occurredAt: string;
}

export interface RequestPage<T> {
  items: T[];
  nextCursor: number | null;
}

export type ReportScope = 'all' | 'mine' | 'received' | 'team';
export type ReportType = 'all' | 'request' | 'timesheet';
export const REPORT_STATES = ['any', 'pending', 'rejected', 'open', 'converted', 'resolved', 'approved', 'changes_requested', 'withdrawn', 'superseded'] as const;
export type ReportState = (typeof REPORT_STATES)[number];

export interface RequestReportFilters {
  scope: ReportScope;
  type: ReportType;
  state: ReportState;
  /** `YYYY-MM-DD` (UTC days); the server caps the range at 366 days. */
  from: string;
  to: string;
}

export interface RequestReportRow {
  id: number;
  type: 'request' | 'timesheet';
  title: string;
  requesterUid: string;
  requesterName: string;
  recipientUid: string | null;
  recipientName: string | null;
  state: string;
  taskState: RequestTaskState;
  createdAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  revision: number | null;
  totalSec: number | null;
}

export interface RequestReport {
  items: RequestReportRow[];
  total: number;
  byType: { request: number; timesheet: number };
  byState: Record<string, number>;
  from: string;
  to: string;
  scope: ReportScope;
  type: ReportType;
  state: ReportState;
  zone: string;
  timeEnabled: boolean;
  generatedAt: string;
}

export type RequestDecision = 'approve' | 'reject';

/**
 * Actions the UI may offer, derived only from server flags. The server's state machine:
 * respond only `pending` → recipient; resolve/convert only `open` → management chain.
 */
export function requestActions(r: Pick<WorkRequest, 'state' | 'canRespond' | 'canManage'>): { respond: boolean; resolve: boolean; convert: boolean } {
  const manage = r.canManage && r.state === 'open';
  return { respond: r.canRespond && r.state === 'pending', resolve: manage, convert: manage };
}

export const requestsApi = {
  list: (c: OcsClient, scope: 'mine' | 'received' | 'team', state: 'any' | RequestState = 'any', before?: number) =>
    c.get<RequestPage<WorkRequest>>(`${BASE}/requests`, { query: { scope, state, ...(before ? { before: posId(before) } : {}) } }),
  get: (c: OcsClient, id: number) => c.get<WorkRequest>(`${BASE}/requests/${posId(id)}`),
  history: (c: OcsClient, id: number, before?: number) =>
    c.get<RequestPage<RequestEvent>>(`${BASE}/requests/${posId(id)}/history`, before ? { query: { before: posId(before) } } : {}),
  /** `reason` is required for reject, optional for approve. */
  respond: async (c: OcsClient, id: number, version: number, decision: RequestDecision, reason: string | null, idempotencyKey: string) => {
    const body: Record<string, unknown> = { version, decision };
    if (reason) body.reason = reason;
    return (await c.request<WorkRequest>(`${BASE}/requests/${posId(id)}/respond`, { method: 'POST', body, headers: keyHeader(idempotencyKey) })).data;
  },
  resolve: async (c: OcsClient, id: number, version: number, reason: string, idempotencyKey: string) =>
    (await c.request<WorkRequest>(`${BASE}/requests/${posId(id)}/resolve`, { method: 'POST', body: { version, reason }, headers: keyHeader(idempotencyKey) })).data,
  convert: async (c: OcsClient, id: number, version: number, boardId: number, stackId: number, idempotencyKey: string) =>
    (await c.request<WorkRequest>(`${BASE}/requests/${posId(id)}/convert`, { method: 'POST', body: { version, boardId: posId(boardId), stackId: posId(stackId) }, headers: keyHeader(idempotencyKey) })).data,
  report: (c: OcsClient, f: RequestReportFilters) => c.get<RequestReport>(`${BASE}/requests/report`, { query: { scope: f.scope, type: f.type, state: f.state, from: f.from, to: f.to } }),
};

export interface RequestContext {
  uid: string;
  manager: { uid: string; displayName: string } | null;
  managers: { uid: string; displayName: string }[];
  isManager: boolean;
}

export type GoalProgressState = 'ok' | 'not_calculable' | 'restricted' | 'stale' | 'source_missing';
export type GoalLifecycle = 'active' | 'archived';
export const GOAL_TARGET_TYPES = ['number', 'currency', 'boolean', 'task'] as const;
export type GoalTargetType = (typeof GOAL_TARGET_TYPES)[number];
/** Server limit (`GoalProgress::MAX_SCALE`). */
export const GOAL_MAX_SCALE = 4;

/** Goal header + list projection (`GET /goals`, `GET /cards/{id}/goals`). */
export interface GoalSummary {
  id: number;
  title: string;
  dueDate: string | null;
  /** Lifecycle: an archived goal is read-only until reactivated. */
  state: GoalLifecycle;
  owner: { uid: string; displayName: string };
  role: ShareRole;
  canEdit: boolean;
  /** Owner or a `manage` share: may change shares, transfer, delete. */
  canManage: boolean;
  /** Optimistic lock for goal PATCH / DELETE / transfer (targets have their own). */
  version: number;
  updatedAt: string;
  progressBp: number | null;
  progressState: GoalProgressState;
  stateNote: string | null;
  calculatedAt: string | null;
  targetCount?: number;
}

/** A linked card as the VIEWER can read it (unreadable cards are omitted by the server). */
export interface GoalCard {
  id: number;
  title: string;
  boardId: number;
  boardTitle: string;
  stackTitle: string;
  done: string | null;
  archived: boolean;
  url: string;
}

export interface GoalTarget {
  id: number;
  goalId: number;
  type: GoalTargetType;
  title: string;
  version: number;
  weight: number;
  progressBp: number | null;
  state: GoalProgressState;
  /** number / currency: decimal strings with `scale` digits. */
  scale?: number;
  currencyCode?: string | null;
  start?: string | null;
  target?: string | null;
  current?: string | null;
  /** boolean */
  booleanValue?: boolean | null;
  /** task (frozen card set) */
  scopeMode?: string;
  doneCount?: number | null;
  totalCount?: number | null;
  missingCount?: number | null;
  cards?: GoalCard[];
}

export interface GoalDetail extends GoalSummary {
  description: string;
  zone: string;
  createdAt: string;
  targets: GoalTarget[];
}

export interface GoalCheckin {
  id: number;
  actor: { uid: string; displayName: string };
  mode: 'absolute' | 'delta' | 'boolean';
  old: string | null;
  new: string | null;
  oldBool: boolean | null;
  newBool: boolean | null;
  note: string | null;
  occurredAt: string;
}

export interface GoalCheckinResult {
  checkin: GoalCheckin;
  target: { id: number; version: number; current: string | null; booleanValue: boolean | null; progressBp: number | null; state: GoalProgressState };
}

/** A goal the card belongs to, with the target(s) holding it. */
export interface CardGoal extends GoalSummary {
  linkedTargets: { id: number; title: string }[];
}

export interface GoalListFilter {
  owner: 'me' | 'shared' | 'all';
  state: GoalLifecycle | 'any';
}

export interface GoalInput {
  title: string;
  description?: string;
  /** `YYYY-MM-DD` or null (no due date). */
  dueDate?: string | null;
}

export interface GoalPatch {
  version: number;
  title?: string;
  description?: string;
  dueDate?: string | null;
  state?: GoalLifecycle;
}

export type GoalTargetInput =
  | { type: 'number' | 'currency'; title: string; start: string; target: string; current?: string; scale?: number; currencyCode?: string }
  | { type: 'boolean' | 'task'; title: string };

export interface GoalTargetPatch {
  version: number;
  title?: string;
  start?: string;
  target?: string;
  currencyCode?: string;
}

export type GoalCheckinInput =
  | { version: number; mode: 'absolute' | 'delta'; value: string; note?: string }
  | { version: number; value: boolean; note?: string };

/**
 * What the UI may offer, derived only from server flags + lifecycle (the server re-checks):
 * targets/check-ins/card links need `edit` on an ACTIVE goal; archive/reactivate needs `edit`;
 * transfer/delete/shares need `manage`.
 */
export function goalActions(g: Pick<GoalSummary, 'canEdit' | 'canManage' | 'state'>) {
  const active = g.state === 'active';
  return {
    editHeader: g.canEdit,
    archive: g.canEdit && active,
    reactivate: g.canEdit && !active,
    targets: g.canEdit && active,
    checkin: g.canEdit && active,
    linkCards: g.canEdit && active,
    transfer: g.canManage,
    remove: g.canManage,
    share: g.canManage,
  };
}

export const isManualTarget = (t: Pick<GoalTarget, 'type'>) => t.type !== 'task';

/**
 * Normalizes a typed decimal to the server's format (`-?digits(.digits)?`, at most `scale`
 * fraction digits). Accepts a comma decimal separator; rejects grouping separators, exponents,
 * and anything else (the server would 422). Returns null when invalid.
 */
export function normalizeGoalDecimal(input: string, scale: number): string | null {
  const v = input.trim().replace(',', '.');
  const m = /^(-)?(\d{1,30})(?:\.(\d{1,30}))?$/.exec(v);
  if (!m) return null;
  const frac = (m[3] ?? '').replace(/0+$/, '');
  if (frac.length > Math.max(0, Math.min(GOAL_MAX_SCALE, scale))) return null;
  return `${m[1] ?? ''}${m[2]}${frac ? `.${frac}` : ''}`;
}

/** Progress basis points (0–10000, may exceed for over-achievement) → whole percent, or null. */
export const goalPercent = (bp: number | null | undefined) => (bp === null || bp === undefined ? null : Math.round(bp / 100));

/**
 * New card set for a task target after removing one card. Built from the server's detail; the
 * server refuses (CARDS_NOT_READABLE) if the actor cannot see a card the owner still can, so a
 * hidden card is never dropped silently by this client.
 */
export const cardSetWithout = (t: Pick<GoalTarget, 'cards'>, cardId: number) => (t.cards ?? []).map((c) => c.id).filter((id) => id !== cardId);

export const goalsApi = {
  list: async (c: OcsClient, f: GoalListFilter = { owner: 'all', state: 'active' }) =>
    (await c.get<{ items: GoalSummary[] }>(`${BASE}/goals`, { query: { owner: f.owner, state: f.state } })).items,
  get: (c: OcsClient, id: number) => c.get<GoalDetail>(`${BASE}/goals/${posId(id)}`),
  create: async (c: OcsClient, input: GoalInput) => (await c.request<GoalDetail>(`${BASE}/goals`, { method: 'POST', body: input })).data,
  update: async (c: OcsClient, id: number, patch: GoalPatch) => (await c.request<GoalDetail>(`${BASE}/goals/${posId(id)}`, { method: 'PATCH', body: patch })).data,
  remove: async (c: OcsClient, id: number, version: number) =>
    (await c.request<{ id: number; deleted: boolean }>(`${BASE}/goals/${posId(id)}`, { method: 'DELETE', body: { version } })).data,
  /** The previous owner keeps a `manage` share; progress is recalculated with the new owner's Deck access. */
  transfer: async (c: OcsClient, id: number, version: number, newOwnerUid: string) =>
    (await c.request<GoalDetail>(`${BASE}/goals/${posId(id)}/transfer`, { method: 'POST', body: { version, newOwnerUid } })).data,
  addTarget: async (c: OcsClient, goalId: number, input: GoalTargetInput) =>
    (await c.request<GoalTarget>(`${BASE}/goals/${posId(goalId)}/targets`, { method: 'POST', body: input })).data,
  updateTarget: async (c: OcsClient, goalId: number, targetId: number, patch: GoalTargetPatch) =>
    (await c.request<GoalTarget>(`${BASE}/goals/${posId(goalId)}/targets/${posId(targetId)}`, { method: 'PATCH', body: patch })).data,
  removeTarget: async (c: OcsClient, goalId: number, targetId: number, version: number) =>
    (await c.request<{ id: number; deleted: boolean }>(`${BASE}/goals/${posId(goalId)}/targets/${posId(targetId)}`, { method: 'DELETE', body: { version } })).data,
  /** Same Idempotency-Key → the first result; the delta is not applied twice. */
  checkin: async (c: OcsClient, goalId: number, targetId: number, input: GoalCheckinInput, idempotencyKey: string) =>
    (await c.request<GoalCheckinResult>(`${BASE}/goals/${posId(goalId)}/targets/${posId(targetId)}/checkins`, { method: 'POST', body: input, headers: keyHeader(idempotencyKey) })).data,
  /** Newest first, at most 100 (server limit; no paging). */
  checkins: async (c: OcsClient, goalId: number, targetId: number) =>
    (await c.get<{ items: GoalCheckin[] }>(`${BASE}/goals/${posId(goalId)}/targets/${posId(targetId)}/checkins`)).items,
  /** Replaces the frozen card set of a task target. */
  setCards: async (c: OcsClient, goalId: number, targetId: number, version: number, cardIds: number[]) =>
    (await c.request<GoalTarget>(`${BASE}/goals/${posId(goalId)}/targets/${posId(targetId)}/cards`, { method: 'PUT', body: { version, cardIds: cardIds.map(posId) } })).data,
  cardGoals: async (c: OcsClient, cardId: number) => (await c.get<{ items: CardGoal[] }>(`${BASE}/cards/${posId(cardId)}/goals`)).items,
  /** Adds the card to the goal's task target (created when missing); returns the goal detail. */
  linkCard: async (c: OcsClient, cardId: number, goalId: number) =>
    (await c.request<GoalDetail>(`${BASE}/cards/${posId(cardId)}/goals`, { method: 'POST', body: { goalId: posId(goalId) } })).data,
};

export const workhubModulesApi = {
  timer: (c: OcsClient) => c.get<{ timer: Timer | null; serverTime: string }>(`${BASE}/time/timer`),
  /** One active timer per user (server enforced: 409 TIMER_ALREADY_RUNNING). */
  timerStart: async (c: OcsClient, body: { cardId?: number; description?: string }, idempotencyKey: string) =>
    (await c.request<{ timer: Timer }>(`${BASE}/time/timer/start`, { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey } })).data,
  timerStop: async (c: OcsClient) => (await c.request<{ entries: TimeEntry[]; totalSec: number }>(`${BASE}/time/timer/stop`, { method: 'POST', body: {} })).data,
  requests: async (c: OcsClient, scope: 'mine' | 'received' | 'team') => (await c.get<{ items: WorkRequest[] }>(`${BASE}/requests`, { query: { scope, state: 'any' } })).items,
  requestContext: (c: OcsClient) => c.get<RequestContext>(`${BASE}/requests/context`),
  createRequest: async (c: OcsClient, body: { title: string; description: string; recipientUid?: string }, idempotencyKey: string) =>
    (await c.request<{ id: number }>(`${BASE}/requests`, { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey } })).data,
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

// ---- Project views: Gantt, activity stream; workload matrix ------------------------
// Contract: Workhub ProjectController::gantt (= board view + dependencies), ::activity
// (ActivityService::stream) and WorkloadController::index (WorkloadService::matrix).

export const DEPENDENCY_TYPES = ['finish_to_start', 'start_to_start', 'finish_to_finish'] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

export interface GanttDependency {
  id: number;
  predecessorId: number;
  successorId: number;
  type: DependencyType;
  lagDays: number;
}

export interface GanttTask extends Task {
  estimateSec: number | null;
  /** Predecessor ids (tasks this one waits for). */
  dependsOn: number[];
}

export interface GanttPayload extends Omit<BoardPayload, 'tasks'> {
  tasks: GanttTask[];
  dependencies: GanttDependency[];
  generatedAt: string;
}

export const ACTIVITY_TYPES = ['all', 'status', 'time', 'goal', 'subtasks', 'comments'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
/** Server page size limit (`limit` 1…100). */
export const ACTIVITY_PAGE = 30;

export interface ActivityFilter {
  type: ActivityType;
  /** Actor uid. */
  actor?: string;
  /** Inclusive UTC days (YYYY-MM-DD). */
  from?: string;
  to?: string;
  /** Free-text filter (applied by the server to the returned page). */
  q?: string;
}

export interface ActivityEvent {
  id: string;
  /** Filter group; Deck field edits come as `update` (only visible under `all`). */
  type: 'status' | 'time' | 'goal' | 'subtasks' | 'comments' | 'update';
  /** Deck subject (`card_update_stackId`, …), `time_logged`, `goal.checkin`, `task.subtask.add`, … */
  kind: string;
  actor: { uid: string; displayName: string } | null;
  card: { id: number; title: string; exists: boolean } | null;
  data: Record<string, unknown>;
  occurredAt: string;
}

export interface ActivityPage {
  events: ActivityEvent[];
  /** Opaque; null = no older events. */
  nextCursor: string | null;
  /** Which sources contributed (Deck activity needs the Activity app; time/goals per viewer). */
  sources: { deck: boolean; time: boolean; goals: boolean };
}

export interface WorkloadQuery {
  /** Inclusive local days in the Workhub reporting zone; at most WORKLOAD_MAX_DAYS. */
  from: string;
  to: string;
  boardIds?: number[];
  members?: string[];
}
export const WORKLOAD_MAX_DAYS = 120;

export interface WorkloadDay {
  date: string;
  plannedSec: number;
  capacitySec: number;
  /** Null when the viewer may not see this member's time (never shown as zero). */
  actualSec: number | null;
  tasks: Array<{ cardId: number; plannedSec: number }>;
}

export interface WorkloadMember {
  uid: string;
  displayName: string;
  capacitySec: number;
  plannedSec: number;
  actualSec: number | null;
  taskCount: number;
  overdue: number[];
  unscheduled: number[];
  overallocatedDays: number;
  days: WorkloadDay[];
}

export interface WorkloadTask {
  id: number;
  title: string;
  boardId: number;
  boardTitle: string;
  startDate: string | null;
  dueDate: string | null;
  estimateSec: number | null;
}

export interface WorkloadMatrix {
  from: string;
  to: string;
  today: string;
  zone: string;
  weekStart: number;
  dailyCapacitySec: number;
  workDays: number[];
  days: Array<{ date: string; workday: boolean }>;
  boards: Array<{ id: number; title: string; color: string }>;
  members: WorkloadMember[];
  tasks: Record<string, WorkloadTask>;
  summary: { capacitySec: number; plannedSec: number; actualSec: number | null; overallocatedMembers: number; utilizationBp: number | null };
  timeVisibleMembers: string[];
  truncated: boolean;
}

const activityQuery = (f: ActivityFilter, cursor: string | null, limit: number) => ({
  type: f.type,
  ...(f.actor ? { actor: f.actor } : {}),
  ...(f.from ? { from: f.from } : {}),
  ...(f.to ? { to: f.to } : {}),
  ...(f.q?.trim() ? { q: f.q.trim().slice(0, 200) } : {}),
  ...(cursor ? { cursor } : {}),
  limit,
});

export const projectViewsApi = {
  gantt: (c: OcsClient, boardId: number) => c.get<GanttPayload>(`${BASE}/projects/${id(boardId)}/views/gantt`),
  /** Newest first. A page may hold more than `limit` items (all events of the boundary second are kept). */
  activity: (c: OcsClient, boardId: number, f: ActivityFilter, cursor: string | null = null, limit = ACTIVITY_PAGE) =>
    c.get<ActivityPage>(`${BASE}/projects/${id(boardId)}/views/activity`, { query: activityQuery(f, cursor, limit) }),
  workload: (c: OcsClient, q: WorkloadQuery) =>
    c.get<WorkloadMatrix>(`${BASE}/workload`, {
      query: {
        from: q.from,
        to: q.to,
        ...(q.boardIds?.length ? { boardIds: q.boardIds.map(posId).join(',') } : {}),
        ...(q.members?.length ? { members: q.members.join(',') } : {}),
      },
    }),
};

// ---- Gantt scheduling (pure; dates are local calendar days "YYYY-MM-DD") ----

const DAY_MS = 86_400_000;
const epoch = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY_MS);
export const addDays = (d: string, n: number) => new Date((epoch(d) + n) * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => epoch(b) - epoch(a);
/** Local calendar day of an ISO instant in the device time zone. */
export const deviceDay = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export interface GanttLink {
  dependency: GanttDependency;
  /** The other task of the link (predecessor for `waitsFor`, successor for `blocks`). */
  other: { id: number; title: string; done: boolean };
  /** The dates of both scheduled tasks break the link rule. */
  violated: boolean;
}

export interface GanttRow {
  task: GanttTask;
  /** First / last local day, inclusive; null when the task has no due date. */
  start: string | null;
  end: string | null;
  /** Only a due date: a single-day milestone. */
  milestone: boolean;
  /** Inclusive length in days (milestone 1). */
  days: number;
  done: boolean;
  overdue: boolean;
  waitsFor: GanttLink[];
  blocks: GanttLink[];
  /** At least one predecessor link is still open (predecessor not done). */
  blocked: boolean;
}

export interface GanttSchedule {
  /** Scheduled rows by start, end, id. */
  rows: GanttRow[];
  /** Open tasks without a due date (not placed on the timeline). */
  unscheduled: GanttRow[];
  /** First/last visible day, null when nothing is scheduled. */
  range: { start: string; end: string; days: number } | null;
  violations: number;
}

/**
 * A link is violated when the scheduled dates break its rule:
 * finish→start: successor starts after the predecessor's last day + lag;
 * start→start: successor starts no earlier than predecessor start + lag;
 * finish→finish: successor ends no earlier than predecessor end + lag.
 * Links with an unscheduled side are never violations.
 */
export function linkViolated(dep: GanttDependency, pred: { start: string | null; end: string | null }, succ: { start: string | null; end: string | null }): boolean {
  if (!pred.start || !pred.end || !succ.start || !succ.end) return false;
  const lag = dep.lagDays || 0;
  if (dep.type === 'start_to_start') return daysBetween(addDays(pred.start, lag), succ.start) < 0;
  if (dep.type === 'finish_to_finish') return daysBetween(addDays(pred.end, lag), succ.end) < 0;
  return daysBetween(addDays(pred.end, 1 + lag), succ.start) < 0;
}

export function ganttSchedule(p: Pick<GanttPayload, 'tasks' | 'dependencies'>, today: string, toLocal: (iso: string) => string = deviceDay): GanttSchedule {
  const tasks = p.tasks.filter((t) => !t.archived);
  const byId = new Map<number, GanttRow>();
  for (const task of tasks) {
    const end = task.dueDate ? toLocal(task.dueDate) : null;
    let start = end && task.startDate ? toLocal(task.startDate) : end;
    if (start && end && start > end) start = end;
    const done = task.done !== null;
    byId.set(task.id, {
      task, start, end, milestone: !!end && !task.startDate, days: start && end ? daysBetween(start, end) + 1 : 0,
      done, overdue: !done && !!end && end < today, waitsFor: [], blocks: [], blocked: false,
    });
  }
  let violations = 0;
  for (const dep of p.dependencies) {
    const pred = byId.get(dep.predecessorId);
    const succ = byId.get(dep.successorId);
    if (!pred || !succ) continue;
    const violated = linkViolated(dep, pred, succ);
    if (violated) violations++;
    succ.waitsFor.push({ dependency: dep, other: { id: pred.task.id, title: pred.task.title, done: pred.done }, violated });
    pred.blocks.push({ dependency: dep, other: { id: succ.task.id, title: succ.task.title, done: succ.done }, violated });
    if (!pred.done) succ.blocked = true;
  }
  const all = [...byId.values()];
  const rows = all.filter((r) => r.start).sort((a, b) => a.start!.localeCompare(b.start!) || a.end!.localeCompare(b.end!) || a.task.id - b.task.id);
  const unscheduled = all.filter((r) => !r.start && !r.done).sort((a, b) => a.task.order - b.task.order || a.task.id - b.task.id);
  let range: GanttSchedule['range'] = null;
  if (rows.length) {
    const start = rows.reduce((m, r) => (r.start! < m ? r.start! : m), rows[0]!.start!);
    const end = rows.reduce((m, r) => (r.end! > m ? r.end! : m), rows[0]!.end!);
    range = { start, end, days: daysBetween(start, end) + 1 };
  }
  return { rows, unscheduled, range, violations };
}

/** Bar position as fractions of the range (0…1), for a decorative timeline. */
export function ganttBar(row: Pick<GanttRow, 'start' | 'end'>, range: { start: string; days: number }): { left: number; width: number } | null {
  if (!row.start || !row.end || range.days <= 0) return null;
  return { left: daysBetween(range.start, row.start) / range.days, width: (daysBetween(row.start, row.end) + 1) / range.days };
}

/** Append an older page; ids already shown are dropped (stable against re-reads). */
export function mergeActivity(shown: ActivityEvent[], page: ActivityEvent[]): ActivityEvent[] {
  const seen = new Set(shown.map((e) => e.id));
  return [...shown, ...page.filter((e) => !seen.has(e.id))];
}

export type WorkloadLoad = 'off' | 'free' | 'ok' | 'full' | 'over';
/** Cell state: non-working day without plan → off; planned > capacity → over; ≥ 85% → full. */
export function workloadLoad(d: Pick<WorkloadDay, 'plannedSec' | 'capacitySec'>): WorkloadLoad {
  if (d.capacitySec <= 0) return d.plannedSec > 0 ? 'over' : 'off';
  if (d.plannedSec > d.capacitySec) return 'over';
  if (d.plannedSec === 0) return 'free';
  return d.plannedSec * 100 >= d.capacitySec * 85 ? 'full' : 'ok';
}

/** Week (weekStart 1 = Monday … 7 = Sunday) containing `day`. */
export function workloadWeek(day: string, weekStart = 1): { from: string; to: string } {
  const iso = ((epoch(day) + 3) % 7 + 7) % 7 + 1; // 1 = Monday
  const back = (iso - weekStart + 7) % 7;
  const from = addDays(day, -back);
  return { from, to: addDays(from, 6) };
}
