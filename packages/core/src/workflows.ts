import { OcsError, type OcsClient } from './ocs';
import type { ShareRole } from './workhub';

/**
 * Workhub workflows (OCS `/workflows…`, Workhub 0.4+): template graphs whose steps are Deck/native
 * cards, runs, hand-offs and skips. Protocol implementation; DTOs are re-declared from the server
 * contract (`WorkflowService`, `Graph`), no server code is copied. The server re-checks every rule.
 */
const BASE = '/ocs/v2.php/apps/workhub/api/v1';

const posId = (id: number) => {
  if (!Number.isInteger(id) || id <= 0) throw new OcsError('client', undefined, 'invalid id');
  return id;
};
const keyHeader = (k: string) => ({ 'Idempotency-Key': k });

/** Server limits (`Graph::MAX_*`, `WorkflowService::MAX_*`). */
export const WORKFLOW_LIMITS = {
  nodes: 40,
  edges: 80,
  label: 80,
  stepTitle: 255,
  stepDescription: 4000,
  assignees: 20,
  dueDays: 365,
  coord: 20000,
  title: 255,
  description: 4000,
  skipReason: 2000,
} as const;
export const WORKFLOW_CATEGORIES = ['production', 'marketing', 'custom'] as const;
export type WorkflowCategory = (typeof WORKFLOW_CATEGORIES)[number];
export type WorkflowStartMode = 'manual' | 'auto';
export type WorkflowEdgeMode = 'auto' | 'manual';
export type WorkflowAssigneeMode = 'fixed' | 'choose';
/** Known placeholders (`TemplateRenderer::PLACEHOLDERS`); the server's list wins when present. */
export const WORKFLOW_PLACEHOLDERS = ['workflow.title', 'run.title', 'step.label', 'previous.title', 'previous.url', 'previous.assignees', 'previous.doneBy', 'date'] as const;
/** Step / connection ids (`Graph`): 1–32 letters, digits, `-`, `_`. */
export const WORKFLOW_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

export interface WorkflowPerson {
  uid: string;
  displayName: string;
}

export interface WorkflowNode {
  id: string;
  type: 'task';
  label: string;
  /** Card title template (placeholders); empty → `<run title> – <label>`. */
  title: string;
  description: string;
  /** Target list; required before a card can be created (WORKFLOW_STEP_NO_LIST). */
  stackId: number | null;
  /** Derived by the server from `stackId`. */
  boardId: number | null;
  assigneeMode: WorkflowAssigneeMode;
  /** fixed: the card's assignees; choose: the people the previous person may pick from (empty = board members). */
  assignees: string[];
  dueDays: number | null;
  x: number;
  y: number;
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  mode: WorkflowEdgeMode;
}

export interface WorkflowStart {
  mode: WorkflowStartMode;
  nodeId: string | null;
  /** auto: the list whose NEW cards start a run. */
  stackId: number | null;
  boardId: number | null;
  x: number;
  y: number;
}

export interface WorkflowGraph {
  start: WorkflowStart;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowSummary {
  id: number;
  title: string;
  description: string;
  category: WorkflowCategory;
  enabled: boolean;
  version: number;
  owner: WorkflowPerson;
  /** view: see + start; edit: change the graph + act on every hand-off; manage: share + delete. */
  role: ShareRole;
  startMode: WorkflowStartMode;
  stepCount: number;
  entryLabel: string | null;
  runs: { running: number; completed: number };
  createdAt: string;
  updatedAt: string;
}

/** A board referenced by the graph that the viewer can read (lists + members for the editor). */
export interface WorkflowBoard {
  id: number;
  title: string;
  color: string;
  edit: boolean;
  archived: boolean;
  stacks: { id: number; title: string }[];
  members: WorkflowPerson[];
}

export interface WorkflowDetail extends WorkflowSummary {
  graph: WorkflowGraph;
  boards: WorkflowBoard[];
  placeholders: string[];
}

export interface WorkflowSample {
  id: string;
  title: string;
  description: string;
  category: WorkflowCategory;
  /** No lists or people: the user sets them before the workflow can run. */
  graph: WorkflowGraph;
}

export type WorkflowStepState = 'pending_handoff' | 'open' | 'done' | 'failed' | 'skipped';
export type WorkflowRunState = 'running' | 'completed' | 'cancelled';

/** A card as the VIEWER can read it (live read; `null` on the step when not readable). */
export interface WorkflowCard {
  id: number;
  boardId: number;
  boardTitle: string;
  stackId: number;
  stackTitle: string;
  title: string;
  done: string | null;
  due: string | null;
  createdAt: string;
  archived: boolean;
  url: string;
}

export interface WorkflowStep {
  id: number;
  nodeId: string;
  label: string;
  state: WorkflowStepState;
  cardId: number | null;
  card: WorkflowCard | null;
  assignee: WorkflowPerson | null;
  doneBy: WorkflowPerson | null;
  /** Server error code of a failed automatic step (e.g. ACTION_FORBIDDEN, NO_SESSION). */
  error: string | null;
  sourceStepId: number | null;
  sourceCardId: number | null;
  /** Server-computed: this viewer may hand over / retry / skip the step now. */
  canAct: boolean;
  createdAt: string;
  doneAt: string | null;
  node: {
    label: string;
    assigneeMode: WorkflowAssigneeMode;
    assignees: WorkflowPerson[];
    stackId: number | null;
    boardId: number | null;
    dueDays: number | null;
  } | null;
  /** Rendered defaults for a pending/failed step (title, description, due). */
  preview: { title: string; description: string; dueDate: string | null } | null;
}

export interface WorkflowRun {
  id: number;
  workflowId: number;
  /** null when the template was deleted. */
  workflowTitle: string | null;
  title: string;
  state: WorkflowRunState;
  startedBy: WorkflowPerson;
  /** Optimistic lock for cancel. */
  version: number;
  /** Starter or a workflow editor: may cancel. */
  canManage: boolean;
  createdAt: string;
  finishedAt: string | null;
  /** Frozen graph of the run (template edits do not change it). */
  nodes: { id: string; label: string; x: number; y: number }[];
  edges: WorkflowEdge[];
  steps: WorkflowStep[];
}

export interface WorkflowHandoff {
  step: WorkflowStep;
  run: { id: number; title: string; workflowId: number; workflowTitle: string };
  sourceCard: WorkflowCard | null;
}

export interface WorkflowInput {
  title: string;
  description?: string;
  category?: WorkflowCategory;
  graph?: WorkflowGraph;
}

export interface WorkflowPatch {
  version: number;
  title?: string;
  description?: string;
  category?: WorkflowCategory;
  enabled?: boolean;
  graph?: WorkflowGraph;
}

export interface WorkflowStartInput {
  /** Empty → the template title (or the bound card's title). */
  title?: string;
  /** Bind an existing, open, unbound card as the entry step instead of creating one. */
  cardId?: number;
  /** Only for an entry step whose assignee is chosen. */
  assigneeUid?: string | null;
  description?: string;
  /** `YYYY-MM-DD` (UTC midnight) or null (no due date). */
  dueDate?: string | null;
}

export interface WorkflowHandoffInput {
  /** Only for a step whose assignee is chosen. */
  assigneeUid?: string | null;
  title?: string;
  description?: string;
  dueDate?: string | null;
}

export const workflowsApi = {
  list: (c: OcsClient) => c.get<{ workflows: WorkflowSummary[]; pendingHandoffs: number }>(`${BASE}/workflows`),
  samples: (c: OcsClient) => c.get<{ items: WorkflowSample[]; placeholders: string[] }>(`${BASE}/workflows/samples`),
  get: (c: OcsClient, id: number) => c.get<WorkflowDetail>(`${BASE}/workflows/${posId(id)}`),
  /** Same Idempotency-Key → the first template (no duplicate). */
  create: async (c: OcsClient, input: WorkflowInput, idempotencyKey: string) =>
    (await c.request<WorkflowDetail>(`${BASE}/workflows`, { method: 'POST', body: input, headers: keyHeader(idempotencyKey) })).data,
  /** Version CAS: a stale version → 409 VERSION_CONFLICT. */
  update: async (c: OcsClient, id: number, patch: WorkflowPatch) =>
    (await c.request<WorkflowDetail>(`${BASE}/workflows/${posId(id)}`, { method: 'PATCH', body: patch })).data,
  /** Soft delete; running runs are cancelled, their cards stay. */
  remove: async (c: OcsClient, id: number) => (await c.request<{ id: number; deleted: boolean }>(`${BASE}/workflows/${posId(id)}`, { method: 'DELETE' })).data,
  start: async (c: OcsClient, id: number, input: WorkflowStartInput, idempotencyKey: string) =>
    (await c.request<WorkflowRun>(`${BASE}/workflows/${posId(id)}/start`, { method: 'POST', body: input, headers: keyHeader(idempotencyKey) })).data,
  /** Last 50 runs, newest first (server limit; no paging). */
  runs: async (c: OcsClient, id: number) => (await c.get<{ items: WorkflowRun[] }>(`${BASE}/workflows/${posId(id)}/runs`)).items,
  run: (c: OcsClient, runId: number) => c.get<WorkflowRun>(`${BASE}/workflows/runs/${posId(runId)}`),
  /** Open / pending / failed steps become `skipped`; cards stay. */
  cancel: async (c: OcsClient, runId: number, version: number) =>
    (await c.request<WorkflowRun>(`${BASE}/workflows/runs/${posId(runId)}/cancel`, { method: 'POST', body: { version } })).data,
  handoffs: async (c: OcsClient) => (await c.get<{ items: WorkflowHandoff[] }>(`${BASE}/workflows/handoffs`)).items,
  cardHandoffs: async (c: OcsClient, cardId: number) => (await c.get<{ items: WorkflowHandoff[] }>(`${BASE}/workflows/cards/${posId(cardId)}/handoffs`)).items,
  /** Creates the card of a pending step (or retries a failed one) as the caller. */
  handoff: async (c: OcsClient, stepId: number, input: WorkflowHandoffInput, idempotencyKey: string) =>
    (await c.request<WorkflowRun>(`${BASE}/workflows/steps/${posId(stepId)}/handoff`, { method: 'POST', body: input, headers: keyHeader(idempotencyKey) })).data,
  skip: async (c: OcsClient, stepId: number, reason: string) =>
    (await c.request<WorkflowRun>(`${BASE}/workflows/steps/${posId(stepId)}/skip`, { method: 'POST', body: reason ? { reason } : {} })).data,
};

// ---- Pure helpers (UI + Backend gates) --------------------------------------

const ROLE_RANK: Record<ShareRole, number> = { view: 1, edit: 2, manage: 3 };
export const workflowRoleAtLeast = (role: ShareRole | null | undefined, need: ShareRole) => !!role && ROLE_RANK[role] >= ROLE_RANK[need];

/** What the UI may offer on a template, from the server role + state only (the server re-checks). */
export function workflowActions(w: Pick<WorkflowSummary, 'role' | 'enabled' | 'entryLabel'>) {
  return {
    start: w.enabled && w.entryLabel !== null,
    edit: workflowRoleAtLeast(w.role, 'edit'),
    share: workflowRoleAtLeast(w.role, 'manage'),
    remove: workflowRoleAtLeast(w.role, 'manage'),
  };
}

export const isActionableStep = (s: Pick<WorkflowStep, 'state'>) => s.state === 'pending_handoff' || s.state === 'failed';

/** Step actions for this viewer: hand over / retry / skip need the server's `canAct` on a running run. */
export function stepActions(run: Pick<WorkflowRun, 'state'>, s: Pick<WorkflowStep, 'state' | 'canAct'>) {
  const ok = run.state === 'running' && s.canAct && isActionableStep(s);
  return { handoff: ok && s.state === 'pending_handoff', retry: ok && s.state === 'failed', skip: ok };
}

/** Counts per step state (run progress line). */
export function runProgress(run: Pick<WorkflowRun, 'steps'>): Record<WorkflowStepState, number> & { total: number } {
  const out = { pending_handoff: 0, open: 0, done: 0, failed: 0, skipped: 0, total: run.steps.length };
  for (const s of run.steps) out[s.state]++;
  return out;
}

/**
 * People a chosen-assignee step may be handed to: the step's allow-list when set (server:
 * WORKFLOW_ASSIGNEE_NOT_ALLOWED otherwise), else the target board's members.
 */
export function handoffCandidates(node: WorkflowStep['node'], boardMembers: WorkflowPerson[]): WorkflowPerson[] {
  if (!node || node.assigneeMode !== 'choose') return [];
  return node.assignees.length ? node.assignees : boardMembers;
}

export const unknownPlaceholders = (template: string, known: readonly string[] = WORKFLOW_PLACEHOLDERS) => {
  const names = [...template.matchAll(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g)].map((m) => m[1]!);
  return [...new Set(names.filter((n) => !known.includes(n)))];
};

export type GraphIssue =
  | { code: 'no_entry' }
  | { code: 'no_list'; nodeId: string }
  | { code: 'unreachable'; nodeId: string }
  | { code: 'cycle' }
  | { code: 'auto_to_choose'; edgeId: string }
  | { code: 'auto_start_no_list' }
  | { code: 'unknown_placeholder'; nodeId: string; names: string[] }
  | { code: 'too_many_nodes' }
  | { code: 'too_many_edges' }
  | { code: 'empty_label'; nodeId: string };

/** Problems that stop the server from saving (`blocking`) and warnings the web editor also shows. */
export const BLOCKING_ISSUES: ReadonlyArray<GraphIssue['code']> = ['cycle', 'auto_to_choose', 'auto_start_no_list', 'too_many_nodes', 'too_many_edges', 'empty_label'];

/**
 * Client mirror of the server's graph rules (`Graph::normalize`) plus the editor warnings (no
 * first step, step without a list, step not reachable from the start, unknown placeholder).
 */
export function graphIssues(g: WorkflowGraph, known: readonly string[] = WORKFLOW_PLACEHOLDERS): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  if (g.nodes.length > WORKFLOW_LIMITS.nodes) issues.push({ code: 'too_many_nodes' });
  if (g.edges.length > WORKFLOW_LIMITS.edges) issues.push({ code: 'too_many_edges' });
  if (!g.start.nodeId || !byId.has(g.start.nodeId)) issues.push({ code: 'no_entry' });
  if (g.start.mode === 'auto' && g.start.stackId === null) issues.push({ code: 'auto_start_no_list' });
  for (const n of g.nodes) {
    if (!n.label.trim()) issues.push({ code: 'empty_label', nodeId: n.id });
    if (n.stackId === null) issues.push({ code: 'no_list', nodeId: n.id });
    const names = unknownPlaceholders(`${n.title}\n${n.description}`, known);
    if (names.length) issues.push({ code: 'unknown_placeholder', nodeId: n.id, names });
  }
  for (const e of g.edges) if (e.mode === 'auto' && byId.get(e.to)?.assigneeMode === 'choose') issues.push({ code: 'auto_to_choose', edgeId: e.id });
  if (hasCycle(g)) issues.push({ code: 'cycle' });
  if (g.start.nodeId && byId.has(g.start.nodeId)) {
    const seen = new Set<string>([g.start.nodeId]);
    const queue = [g.start.nodeId];
    while (queue.length) {
      const id = queue.shift()!;
      for (const e of g.edges) if (e.from === id && !seen.has(e.to)) (seen.add(e.to), queue.push(e.to));
    }
    for (const n of g.nodes) if (!seen.has(n.id)) issues.push({ code: 'unreachable', nodeId: n.id });
  }
  return issues;
}

export const hasBlockingIssue = (issues: GraphIssue[]) => issues.some((i) => BLOCKING_ISSUES.includes(i.code));

/** Would adding `from → to` create a loop (the server rejects cyclic graphs)? */
export function createsCycle(g: Pick<WorkflowGraph, 'edges'>, from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of g.edges) if (e.from === id) stack.push(e.to);
  }
  return false;
}

function hasCycle(g: Pick<WorkflowGraph, 'nodes' | 'edges'>): boolean {
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const e of g.edges) if (e.from === id && visit(e.to)) return true;
    state.set(id, 2);
    return false;
  };
  return g.nodes.some((n) => visit(n.id));
}

const freeId = (taken: Iterable<string>, prefix: string) => {
  const set = new Set(taken);
  for (let i = 1; ; i++) if (!set.has(`${prefix}${i}`)) return `${prefix}${i}`;
};

/** Adds a step to the right of the rightmost one (keeps the web canvas readable); the first step becomes the entry. */
export function addNode(g: WorkflowGraph, label: string): { graph: WorkflowGraph; nodeId: string } {
  const id = freeId(g.nodes.map((n) => n.id), 'step');
  const x = Math.min(WORKFLOW_LIMITS.coord, g.nodes.length ? Math.max(...g.nodes.map((n) => n.x)) + 340 : 270);
  const node: WorkflowNode = { id, type: 'task', label, title: '{{run.title}} – {{step.label}}', description: '', stackId: null, boardId: null, assigneeMode: 'fixed', assignees: [], dueDays: null, x, y: 120 };
  return { graph: { ...g, nodes: [...g.nodes, node], start: g.start.nodeId ? g.start : { ...g.start, nodeId: id } }, nodeId: id };
}

/** Removes a step with its connections; the start loses its first step when it was this one. */
export function removeNode(g: WorkflowGraph, nodeId: string): WorkflowGraph {
  return {
    start: g.start.nodeId === nodeId ? { ...g.start, nodeId: null } : g.start,
    nodes: g.nodes.filter((n) => n.id !== nodeId),
    edges: g.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
  };
}

export function updateNode(g: WorkflowGraph, nodeId: string, patch: Partial<Omit<WorkflowNode, 'id' | 'type'>>): WorkflowGraph {
  let edges = g.edges;
  // A step whose assignee is chosen can only be reached by a manual hand-off (server rule).
  if (patch.assigneeMode === 'choose') edges = edges.map((e) => (e.to === nodeId && e.mode === 'auto' ? { ...e, mode: 'manual' } : e));
  return { ...g, edges, nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) };
}

/**
 * Connects two steps. Refuses (returns null) a self link, a duplicate, a loop, or an automatic
 * connection to a chosen-assignee step — the same rules the server enforces.
 */
export function connect(g: WorkflowGraph, from: string, to: string, mode: WorkflowEdgeMode): WorkflowGraph | null {
  const target = g.nodes.find((n) => n.id === to);
  if (!target || !g.nodes.some((n) => n.id === from)) return null;
  if (g.edges.some((e) => e.from === from && e.to === to) || createsCycle(g, from, to)) return null;
  if (mode === 'auto' && target.assigneeMode === 'choose') return null;
  if (g.edges.length >= WORKFLOW_LIMITS.edges) return null;
  return { ...g, edges: [...g.edges, { id: freeId(g.edges.map((e) => e.id), 'e'), from, to, mode }] };
}

export const disconnect = (g: WorkflowGraph, edgeId: string): WorkflowGraph => ({ ...g, edges: g.edges.filter((e) => e.id !== edgeId) });

/** Switches a connection's mode; refuses auto into a chosen-assignee step. */
export function setEdgeMode(g: WorkflowGraph, edgeId: string, mode: WorkflowEdgeMode): WorkflowGraph | null {
  const e = g.edges.find((x) => x.id === edgeId);
  if (!e) return null;
  if (mode === 'auto' && g.nodes.find((n) => n.id === e.to)?.assigneeMode === 'choose') return null;
  return { ...g, edges: g.edges.map((x) => (x.id === edgeId ? { ...x, mode } : x)) };
}

/** Header edit → PATCH with only changed fields (+ version); null when nothing changed. */
export function buildWorkflowPatch(
  w: Pick<WorkflowDetail, 'version' | 'title' | 'description' | 'category' | 'enabled'>,
  next: { title: string; description: string; category: WorkflowCategory; enabled: boolean },
): WorkflowPatch | null {
  const patch: WorkflowPatch = { version: w.version };
  const title = next.title.trim();
  const description = next.description.trim();
  if (title !== w.title) patch.title = title;
  if (description !== w.description) patch.description = description;
  if (next.category !== w.category) patch.category = next.category;
  if (next.enabled !== w.enabled) patch.enabled = next.enabled;
  return Object.keys(patch).length > 1 ? patch : null;
}

/** Same graph content (ignores the server-derived boardId)? */
export function sameGraph(a: WorkflowGraph, b: WorkflowGraph): boolean {
  const strip = (g: WorkflowGraph) => JSON.stringify({ start: { ...g.start, boardId: null }, nodes: g.nodes.map((n) => ({ ...n, boardId: null })), edges: g.edges });
  return strip(a) === strip(b);
}

/** Hand-off body: only fields that differ from the server preview; the assignee only for chosen steps. */
export function buildHandoffInput(
  step: Pick<WorkflowStep, 'node' | 'preview'>,
  form: { assigneeUid: string | null; title: string; description: string; dueDate: string },
): WorkflowHandoffInput {
  const out: WorkflowHandoffInput = {};
  const p = step.preview;
  if (step.node?.assigneeMode === 'choose' && form.assigneeUid) out.assigneeUid = form.assigneeUid;
  const title = form.title.trim();
  if (title && title !== p?.title) out.title = title;
  if (form.description.trim() !== (p?.description ?? '').trim()) out.description = form.description.trim();
  const previewDay = p?.dueDate ? p.dueDate.slice(0, 10) : '';
  const due = form.dueDate.trim();
  if (due !== previewDay) out.dueDate = due || null;
  return out;
}
