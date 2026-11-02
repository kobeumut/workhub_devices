import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDirectBackend, dispatchWire, isValidHandoffInput, isValidWorkflowGraph, isValidWorkflowInput, isValidWorkflowPatch, isValidWorkflowStart,
  type PlainStore,
} from '../src/backend';
import type { SecretStore } from '../src/accounts';
import { OcsError } from '../src/ocs';
import {
  addNode, buildHandoffInput, buildWorkflowPatch, connect, createsCycle, disconnect, graphIssues, handoffCandidates, hasBlockingIssue, removeNode,
  runProgress, sameGraph, setEdgeMode, stepActions, unknownPlaceholders, updateNode, workflowActions,
  type WorkflowDetail, type WorkflowGraph, type WorkflowNode, type WorkflowRun, type WorkflowStep,
} from '../src/workflows';
import { headerOf, json, ocs, scriptedFetch, type Call } from './helpers';

class Mem implements SecretStore, PlainStore {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
  async deletePrefix(p: string) { for (const k of [...this.m.keys()]) if (k.startsWith(p)) this.m.delete(k); }
}
const BAD = { ok: false, error: { kind: 'client', message: 'invalid arguments' } };
const bootstrap = (projects: boolean) => json(200, ocs({ apiVersion: '1', modules: { projects, dashboard: false }, permissions: { canViewTeamReport: false } }));

async function loggedIn(...rest: Array<Response | ((c: Call) => Response)>) {
  const f = scriptedFetch(
    json(200, { login: 'https://ex.com/index.php/login/v2/flow/x', poll: { token: 't', endpoint: 'https://ex.com/index.php/login/v2/poll' } }),
    json(200, { server: 'https://ex.com', loginName: 'ali', appPassword: 'secret-app-pw' }),
    ...rest,
  );
  const b = createDirectBackend({ secrets: new Mem(), plain: new Mem(), fetch: f });
  const { flowId } = await b.beginLogin('ex.com');
  const acc = await b.completeLogin(flowId);
  return { b, f, id: acc.id };
}

const node = (id: string, over: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id, type: 'task', label: id.toUpperCase(), title: '{{run.title}} – {{step.label}}', description: '', stackId: 10, boardId: 4,
  assigneeMode: 'fixed', assignees: [], dueDays: null, x: 0, y: 0, ...over,
});
const graph = (over: Partial<WorkflowGraph> = {}): WorkflowGraph => ({
  start: { mode: 'manual', nodeId: 'a', stackId: null, boardId: null, x: 40, y: 120 },
  nodes: [node('a', { assignees: ['ali'] }), node('b', { assigneeMode: 'choose', assignees: [] })],
  edges: [{ id: 'e1', from: 'a', to: 'b', mode: 'manual' }],
  ...over,
});
const wf = (over: Partial<WorkflowDetail> = {}): WorkflowDetail => ({
  id: 3, title: 'Akış', description: '', category: 'custom', enabled: true, version: 4, owner: { uid: 'ali', displayName: 'Ali' }, role: 'manage',
  startMode: 'manual', stepCount: 2, entryLabel: 'A', runs: { running: 0, completed: 0 }, createdAt: '', updatedAt: '',
  graph: graph(), boards: [], placeholders: ['workflow.title', 'run.title', 'step.label', 'previous.title', 'previous.url', 'previous.assignees', 'previous.doneBy', 'date'], ...over,
});
const step = (id: number, over: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id, nodeId: 'b', label: 'B', state: 'pending_handoff', cardId: null, card: null, assignee: null, doneBy: null, error: null, sourceStepId: 1, sourceCardId: 50,
  canAct: true, createdAt: '', doneAt: null,
  node: { label: 'B', assigneeMode: 'choose', assignees: [], stackId: 10, boardId: 4, dueDays: null },
  preview: { title: 'Run – B', description: 'Önceki: X', dueDate: '2026-11-09T00:00:00Z' }, ...over,
});
const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 9, workflowId: 3, workflowTitle: 'Akış', title: 'Run', state: 'running', startedBy: { uid: 'ali', displayName: 'Ali' }, version: 2, canManage: true,
  createdAt: '', finishedAt: null, nodes: [], edges: [], steps: [step(1, { nodeId: 'a', state: 'done', canAct: false }), step(2)], ...over,
});
const isCode = (code: string) => (e: unknown) => e instanceof OcsError && e.errorCode === code;

test('workflow gate is fail-closed: Projects off → PROJECTS_DISABLED, no workflow request', async () => {
  const { b, f, id } = await loggedIn(bootstrap(false));
  await assert.rejects(b.workflows(id), isCode('PROJECTS_DISABLED'));
  await assert.rejects(b.workflowHandoffs(id), isCode('PROJECTS_DISABLED'));
  assert.equal(f.calls.filter((c) => c.url.includes('/workflows')).length, 0);
});

test('role gate reads the CURRENT template: view cannot edit, edit cannot delete; stale delete → 409; no write sent', async () => {
  const { b, f, id } = await loggedIn(
    bootstrap(true),
    json(200, ocs(wf({ role: 'view' }))),
    json(200, ocs(wf({ role: 'edit' }))),
    json(200, ocs(wf({ role: 'manage', version: 5 }))),
    json(200, ocs(wf({ role: 'manage', version: 4 }))),
    json(200, ocs({ id: 3, deleted: true })),
  );
  await assert.rejects(b.workflowUpdate(id, 3, { version: 4, title: 'x' }), isCode('WORKFLOW_EDIT_REQUIRED'));
  await assert.rejects(b.workflowDelete(id, 3, 4), isCode('WORKFLOW_MANAGE_REQUIRED'));
  await assert.rejects(b.workflowDelete(id, 3, 4), (e: unknown) => e instanceof OcsError && e.kind === 'conflict' && e.errorCode === 'VERSION_CONFLICT');
  assert.ok(!f.calls.some((c) => c.url.includes('/workflows') && c.init.method !== 'GET'));
  await b.workflowDelete(id, 3, 4);
  const del = f.calls.at(-1)!;
  assert.equal(del.init.method, 'DELETE');
  assert.ok(del.url.endsWith('/workflows/3?format=json'));
});

test('start gate: disabled → WORKFLOW_DISABLED, no first step → WORKFLOW_NO_ENTRY, chosen assignee rules; Idempotency-Key sent', async () => {
  const chooseEntry = graph({ nodes: [node('a', { assigneeMode: 'choose', assignees: ['bob'] })], edges: [] });
  const { b, f, id } = await loggedIn(
    bootstrap(true),
    json(200, ocs(wf({ enabled: false, role: 'view' }))),
    json(200, ocs(wf({ graph: graph({ start: { ...graph().start, nodeId: null } }) }))),
    json(200, ocs(wf())),
    json(200, ocs(wf({ graph: chooseEntry }))),
    json(200, ocs(wf({ role: 'view' }))),
    json(201, ocs(run())),
  );
  await assert.rejects(b.workflowStart(id, 3, {}, 'abcdef12-3456'), isCode('WORKFLOW_DISABLED'));
  await assert.rejects(b.workflowStart(id, 3, {}, 'abcdef12-3456'), isCode('WORKFLOW_NO_ENTRY'));
  await assert.rejects(b.workflowStart(id, 3, { assigneeUid: 'bob' }, 'abcdef12-3456'), isCode('WORKFLOW_ASSIGNEE_FIXED'));
  await assert.rejects(b.workflowStart(id, 3, { assigneeUid: 'carol' }, 'abcdef12-3456'), isCode('WORKFLOW_ASSIGNEE_NOT_ALLOWED'));
  assert.ok(!f.calls.some((c) => c.url.includes('/start')));
  await b.workflowStart(id, 3, { title: 'Run' }, 'abcdef12-3456');
  const start = f.calls.at(-1)!;
  assert.equal(start.init.method, 'POST');
  assert.ok(start.url.endsWith('/workflows/3/start?format=json'));
  assert.equal(headerOf(start, 'Idempotency-Key'), 'abcdef12-3456');
  assert.deepEqual(JSON.parse(String(start.init.body)), { title: 'Run' });
});

test('step gate reads the CURRENT run: handled → 409, not allowed → 403, unknown step → 404; allow-list enforced', async () => {
  const { b, f, id } = await loggedIn(
    bootstrap(true),
    json(200, ocs(run({ steps: [step(2, { state: 'open' })] }))),
    json(200, ocs(run({ state: 'cancelled' }))),
    json(200, ocs(run({ steps: [step(2, { canAct: false })] }))),
    json(200, ocs(run())),
    json(200, ocs(run({ steps: [step(2, { node: { label: 'B', assigneeMode: 'choose', assignees: [{ uid: 'bob', displayName: 'Bob' }], stackId: 10, boardId: 4, dueDays: null } })] }))),
    json(200, ocs(run({ steps: [step(2, { node: { label: 'B', assigneeMode: 'fixed', assignees: [], stackId: 10, boardId: 4, dueDays: null } })] }))),
    json(200, ocs(run())),
    json(200, ocs(run())),
    json(200, ocs(run())),
    json(200, ocs(run())),
    json(200, ocs(run())),
    json(200, ocs(run())),
  );
  await assert.rejects(b.workflowHandoff(id, 9, 2, {}, 'abcdef12-3456'), isCode('WORKFLOW_STEP_HANDLED'));
  await assert.rejects(b.workflowSkip(id, 9, 2, ''), isCode('WORKFLOW_STEP_HANDLED'));
  await assert.rejects(b.workflowHandoff(id, 9, 2, {}, 'abcdef12-3456'), isCode('ACTION_FORBIDDEN'));
  await assert.rejects(b.workflowHandoff(id, 9, 77, {}, 'abcdef12-3456'), (e: unknown) => e instanceof OcsError && e.kind === 'not_found');
  await assert.rejects(b.workflowHandoff(id, 9, 2, { assigneeUid: 'carol' }, 'abcdef12-3456'), isCode('WORKFLOW_ASSIGNEE_NOT_ALLOWED'));
  await assert.rejects(b.workflowHandoff(id, 9, 2, { assigneeUid: 'bob' }, 'abcdef12-3456'), isCode('WORKFLOW_ASSIGNEE_FIXED'));
  assert.ok(!f.calls.some((c) => c.init.method === 'POST' && c.url.includes('/workflows')));
  await b.workflowHandoff(id, 9, 2, { assigneeUid: 'bob', title: 'İncele' }, 'abcdef12-3456');
  const h = f.calls.at(-1)!;
  assert.ok(h.url.endsWith('/workflows/steps/2/handoff?format=json'));
  assert.equal(headerOf(h, 'Idempotency-Key'), 'abcdef12-3456');
  assert.deepEqual(JSON.parse(String(h.init.body)), { assigneeUid: 'bob', title: 'İncele' });
  await b.workflowSkip(id, 9, 2, '  gerek yok ');
  const s = f.calls.at(-1)!;
  assert.ok(s.url.endsWith('/workflows/steps/2/skip?format=json'));
  assert.deepEqual(JSON.parse(String(s.init.body)), { reason: 'gerek yok' });
  await b.workflowSkip(id, 9, 2, '   ');
  assert.deepEqual(JSON.parse(String(f.calls.at(-1)!.init.body)), {});
});

test('cancel gate: not starter/editor → ACTION_FORBIDDEN, finished run → WORKFLOW_RUN_FINISHED; cancel sends the version', async () => {
  const { b, f, id } = await loggedIn(
    bootstrap(true),
    json(200, ocs(run({ canManage: false }))),
    json(200, ocs(run({ state: 'completed' }))),
    json(200, ocs(run())),
    json(200, ocs(run({ state: 'cancelled' }))),
  );
  await assert.rejects(b.workflowCancel(id, 9, 2), isCode('ACTION_FORBIDDEN'));
  await assert.rejects(b.workflowCancel(id, 9, 2), isCode('WORKFLOW_RUN_FINISHED'));
  const r = await b.workflowCancel(id, 9, 2);
  assert.equal(r?.state, 'cancelled');
  const c = f.calls.at(-1)!;
  assert.ok(c.url.endsWith('/workflows/runs/9/cancel?format=json'));
  assert.deepEqual(JSON.parse(String(c.init.body)), { version: 2 });
});

test('IPC: graph shape + limits, ids, references, assignee list, dueDays, coords; inputs and patches exact', () => {
  assert.ok(isValidWorkflowGraph(graph()));
  assert.ok(isValidWorkflowGraph({ start: { mode: 'manual' }, nodes: [], edges: [] }));
  assert.ok(!isValidWorkflowGraph({ ...graph(), extra: 1 }));
  assert.ok(!isValidWorkflowGraph(graph({ nodes: [node('a'), node('a')] })), 'duplicate node id');
  assert.ok(!isValidWorkflowGraph(graph({ nodes: [node('a b')] })), 'id charset');
  assert.ok(!isValidWorkflowGraph(graph({ edges: [{ id: 'e1', from: 'a', to: 'zz', mode: 'manual' }] })), 'dangling edge');
  assert.ok(!isValidWorkflowGraph(graph({ edges: [{ id: 'e1', from: 'a', to: 'a', mode: 'manual' }] })), 'self loop');
  assert.ok(!isValidWorkflowGraph(graph({ start: { ...graph().start, nodeId: 'zz' } })), 'unknown entry');
  assert.ok(!isValidWorkflowGraph(graph({ nodes: [node('a', { label: '  ' }), node('b')] })), 'empty label');
  assert.ok(!isValidWorkflowGraph(graph({ nodes: [node('a', { assignees: ['x', 'x'] }), node('b')] })), 'duplicate assignee');
  assert.ok(!isValidWorkflowGraph(graph({ nodes: [node('a', { dueDays: 366 }), node('b')] })), 'dueDays');
  assert.ok(!isValidWorkflowGraph(graph({ nodes: [node('a', { x: -1 }), node('b')] })), 'coord');
  assert.ok(!isValidWorkflowGraph(graph({ nodes: [node('a', { stackId: 1.5 as unknown as number }), node('b')] })), 'stack id');
  assert.ok(!isValidWorkflowGraph({ ...graph(), nodes: Array.from({ length: 41 }, (_, i) => node(`n${i}`)), edges: [] }), 'too many nodes');
  assert.ok(!isValidWorkflowGraph({ ...graph(), nodes: [{ ...node('a'), evil: true }], edges: [] }), 'unknown node key');

  assert.ok(isValidWorkflowInput({ title: 'A', category: 'production', graph: graph() }));
  assert.ok(!isValidWorkflowInput({ title: ' ' }));
  assert.ok(!isValidWorkflowInput({ title: 'A', category: 'other' }));
  assert.ok(!isValidWorkflowInput({ title: 'A', ownerUid: 'x' }));
  assert.ok(isValidWorkflowPatch({ version: 1, enabled: false }));
  assert.ok(!isValidWorkflowPatch({ version: 1 }), 'empty patch');
  assert.ok(!isValidWorkflowPatch({ title: 'x' }), 'version required');
  assert.ok(isValidWorkflowStart({}));
  assert.ok(isValidWorkflowStart({ title: 'R', dueDate: '2026-11-30', assigneeUid: 'bob' }));
  assert.ok(!isValidWorkflowStart({ dueDate: '2026-02-30' }), 'calendar day');
  assert.ok(!isValidWorkflowStart({ cardId: 0 }));
  assert.ok(!isValidWorkflowStart({ startedBy: 'x' }));
  assert.ok(isValidHandoffInput({ assigneeUid: null, dueDate: null }));
  assert.ok(!isValidHandoffInput({ assigneeUid: 'a\u0000b' }));
  assert.ok(!isValidHandoffInput({ title: 'x'.repeat(256) }));
});

test('IPC dispatcher rejects malformed workflow calls before the backend runs', async () => {
  const backend = new Proxy({}, { get: () => () => { throw new Error('should not be called'); } }) as never;
  const cases: Array<[string, unknown[]]> = [
    ['workflowCreate', ['acc', { title: 'A' }, 'not a key!']],
    ['workflowUpdate', ['acc', 3, { version: 1 }]],
    ['workflowDelete', ['acc', 3]],
    ['workflowStart', ['acc', 3, { cardId: -1 }, 'abcdef12-3456']],
    ['workflowCancel', ['acc', 9, -1]],
    ['workflowHandoff', ['acc', 9, 2, { assigneeUid: 'bob' }]],
    ['workflowSkip', ['acc', 9, 2, 'x'.repeat(2001)]],
    ['cardWorkflowHandoffs', ['acc', '5']],
  ];
  for (const [m, args] of cases) assert.deepEqual(await dispatchWire(backend, m, args), BAD, m);
});

test('graph issues mirror the server rules and editor warnings', () => {
  assert.deepEqual(graphIssues(graph()), []);
  const codes = (g: WorkflowGraph) => graphIssues(g).map((i) => i.code);
  assert.deepEqual(codes(graph({ start: { ...graph().start, nodeId: null } })), ['no_entry']);
  assert.ok(codes(graph({ nodes: [node('a', { stackId: null }), node('b', { assigneeMode: 'choose' })] })).includes('no_list'));
  assert.ok(codes(graph({ edges: [] })).includes('unreachable'));
  assert.ok(codes(graph({ edges: [{ id: 'e1', from: 'a', to: 'b', mode: 'auto' }] })).includes('auto_to_choose'));
  const loop = graph({ nodes: [node('a'), node('b')], edges: [{ id: 'e1', from: 'a', to: 'b', mode: 'auto' }, { id: 'e2', from: 'b', to: 'a', mode: 'auto' }] });
  assert.ok(codes(loop).includes('cycle'));
  assert.ok(hasBlockingIssue(graphIssues(loop)));
  assert.ok(!hasBlockingIssue(graphIssues(graph({ edges: [] }))), 'warnings do not block saving');
  assert.ok(codes(graph({ start: { ...graph().start, mode: 'auto' } })).includes('auto_start_no_list'));
  const typo = graphIssues(graph({ nodes: [node('a', { title: '{{run.titel}} {{ date }}' }), node('b', { assigneeMode: 'choose' })] }));
  assert.deepEqual(typo, [{ code: 'unknown_placeholder', nodeId: 'a', names: ['run.titel'] }]);
  assert.deepEqual(unknownPlaceholders('{{a.b}} {{a.b}} {{date}}'), ['a.b']);
});

test('graph editing keeps the server rules: no loops, no duplicate, no auto → choose; remove cleans edges and entry', () => {
  let g: WorkflowGraph = { start: { mode: 'manual', nodeId: null, stackId: null, boardId: null, x: 40, y: 120 }, nodes: [], edges: [] };
  const a = addNode(g, 'Hazırla');
  g = a.graph;
  assert.equal(g.start.nodeId, a.nodeId, 'first step becomes the entry');
  const b = addNode(g, 'İncele');
  g = b.graph;
  assert.equal(g.nodes[1]!.x, g.nodes[0]!.x + 340);
  assert.notEqual(a.nodeId, b.nodeId);
  g = connect(g, a.nodeId, b.nodeId, 'auto')!;
  assert.equal(g.edges.length, 1);
  assert.equal(connect(g, a.nodeId, b.nodeId, 'manual'), null, 'duplicate');
  assert.equal(connect(g, b.nodeId, a.nodeId, 'manual'), null, 'loop');
  assert.ok(createsCycle(g, b.nodeId, a.nodeId));
  g = updateNode(g, b.nodeId, { assigneeMode: 'choose' });
  assert.equal(g.edges[0]!.mode, 'manual', 'auto edge into a chosen step becomes a hand-off');
  assert.equal(setEdgeMode(g, g.edges[0]!.id, 'auto'), null);
  const c = addNode(g, 'Yayınla');
  g = c.graph;
  assert.equal(connect(g, b.nodeId, c.nodeId, 'auto')!.edges.length, 2);
  g = removeNode(g, a.nodeId);
  assert.equal(g.start.nodeId, null);
  assert.equal(g.edges.length, 0);
  assert.equal(disconnect(connect(g, b.nodeId, c.nodeId, 'manual')!, 'e1').edges.length, 0);
});

test('actions, progress, hand-off candidates and minimal bodies', () => {
  assert.deepEqual(workflowActions({ role: 'view', enabled: true, entryLabel: 'A' }), { start: true, edit: false, share: false, remove: false });
  assert.deepEqual(workflowActions({ role: 'edit', enabled: false, entryLabel: 'A' }), { start: false, edit: true, share: false, remove: false });
  assert.equal(workflowActions({ role: 'manage', enabled: true, entryLabel: null }).start, false);
  assert.deepEqual(stepActions({ state: 'running' }, { state: 'failed', canAct: true }), { handoff: false, retry: true, skip: true });
  assert.deepEqual(stepActions({ state: 'cancelled' }, { state: 'pending_handoff', canAct: true }), { handoff: false, retry: false, skip: false });
  assert.deepEqual(stepActions({ state: 'running' }, { state: 'pending_handoff', canAct: false }), { handoff: false, retry: false, skip: false });
  const p = runProgress(run());
  assert.equal(p.done, 1);
  assert.equal(p.pending_handoff, 1);
  assert.equal(p.total, 2);
  const members = [{ uid: 'ali', displayName: 'Ali' }, { uid: 'bob', displayName: 'Bob' }];
  assert.deepEqual(handoffCandidates(step(2).node, members), members, 'empty allow-list → board members');
  assert.deepEqual(handoffCandidates({ ...step(2).node!, assignees: [members[1]!] }, members), [members[1]]);
  assert.deepEqual(handoffCandidates({ ...step(2).node!, assigneeMode: 'fixed' }, members), []);
  const s = step(2);
  assert.deepEqual(buildHandoffInput(s, { assigneeUid: 'bob', title: 'Run – B', description: 'Önceki: X', dueDate: '2026-11-09' }), { assigneeUid: 'bob' });
  assert.deepEqual(buildHandoffInput(s, { assigneeUid: null, title: 'Yeni', description: '', dueDate: '' }), { title: 'Yeni', description: '', dueDate: null });
  assert.deepEqual(buildHandoffInput({ ...s, node: { ...s.node!, assigneeMode: 'fixed' } }, { assigneeUid: 'bob', title: 'Run – B', description: 'Önceki: X', dueDate: '2026-11-09' }), {});
  const d = wf();
  assert.equal(buildWorkflowPatch(d, { title: ' Akış ', description: '', category: 'custom', enabled: true }), null);
  assert.deepEqual(buildWorkflowPatch(d, { title: 'Yeni', description: 'x', category: 'marketing', enabled: false }), { version: 4, title: 'Yeni', description: 'x', category: 'marketing', enabled: false });
  assert.ok(sameGraph(graph(), graph({ nodes: graph().nodes.map((n) => ({ ...n, boardId: null })) })), 'boardId is server-derived');
  assert.ok(!sameGraph(graph(), graph({ edges: [] })));
});
