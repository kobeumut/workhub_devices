/**
 * Live smoke for the workflows slice (GENE-55): template CRUD with version locks and graph
 * validation, sharing (view / edit), runs (start, same Idempotency-Key, bind an existing card),
 * card completion → manual hand-off + automatic branch, failed automatic step → retry by an
 * editor, skip, cancel, run history, delete (running runs cancelled) and access (Projects off,
 * outsider 404, view cannot edit).
 * Not part of `npm test`. Run: `npm run smoke:workflows -w @workhub-devices/core` with
 *   WH_SERVER, WH_ALLOW_HTTP=1 (local dev only), WH_A_USER/WH_A_PASS (owner),
 *   WH_B_USER/WH_B_PASS (second user), WH_C_USER/WH_C_PASS (Projects module off).
 * Creates two projects + a few cards per run (Workhub has no project delete API); templates are deleted.
 * Prints no secrets.
 */
import assert from 'node:assert/strict';
import {
  OcsClient, OcsError, graphIssues, normalizeServerUrl, runProgress, workflowsApi, workhubApi,
  type ServerBase, type WorkflowGraph, type WorkflowRun,
} from '../src/index';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const base: ServerBase = normalizeServerUrl(env('WH_SERVER'), { allowInsecureHttp: process.env.WH_ALLOW_HTTP === '1' });
const client = (u: string, p: string) => new OcsClient({ serverBase: base, getCredentials: async () => ({ loginName: u, appPassword: p }) });
const A = client(env('WH_A_USER'), env('WH_A_PASS'));
const B = client(env('WH_B_USER'), env('WH_B_PASS'));
const C = client(env('WH_C_USER'), env('WH_C_PASS'));
const UA = env('WH_A_USER');
const UB = env('WH_B_USER');
const UC = env('WH_C_USER');
const results: Array<[string, string]> = [];
const step = async (name: string, fn: () => Promise<string | void>) => {
  try {
    const note = await fn();
    results.push([name, `PASS${note ? ` — ${note}` : ''}`]);
  } catch (e) {
    results.push([name, `FAIL — ${e instanceof OcsError ? `${e.kind} ${e.status ?? ''} ${e.errorCode ?? ''}` : (e as Error).message}`]);
  }
};
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof OcsError ? `${e.kind}:${e.errorCode ?? ''}` : 'error'));
const key = () => crypto.randomUUID();
const stamp = new Date().toISOString().slice(0, 16);
const stepOf = (r: WorkflowRun, nodeId: string) => {
  const s = r.steps.find((x) => x.nodeId === nodeId);
  assert.ok(s, `step ${nodeId}`);
  return s;
};
const states = (r: WorkflowRun) => r.steps.map((s) => `${s.nodeId}:${s.state}`).sort().join(',');

async function main() {
  let boardP = 0;
  let todoP = 0;
  let boardQ = 0;
  let todoQ = 0;
  let wfId = 0;
  let version = 0;
  let run1: WorkflowRun | null = null;
  let graph: WorkflowGraph | null = null;

  await step('setup: project P (A owner, B edit member) and project Q (B owner, A read-only)', async () => {
    const p = await workhubApi.createProject(A, `GENE-55 smoke P ${stamp}`, undefined, key());
    boardP = p!.id;
    todoP = (await workhubApi.board(A, boardP)).project.stacks.slice().sort((a, b) => a.order - b.order)[0]!.id;
    await workhubApi.addProjectMember(A, boardP, { type: 'user', participant: UB, edit: true, share: false, manage: false });
    const q = await workhubApi.createProject(B, `GENE-55 smoke Q ${stamp}`, undefined, key());
    boardQ = q!.id;
    todoQ = (await workhubApi.board(B, boardQ)).project.stacks.slice().sort((a, b) => a.order - b.order)[0]!.id;
    await workhubApi.addProjectMember(B, boardQ, { type: 'user', participant: UA, edit: false, share: false, manage: false });
    const qa = (await workhubApi.projects(A)).find((x) => x.id === boardQ);
    assert.equal(qa?.edit, false, 'A reads Q without edit');
    return `P=${boardP} (list ${todoP}), Q=${boardQ} (list ${todoQ})`;
  });

  await step('access: Projects module off → 403 PROJECTS_DISABLED (list, samples, handoffs)', async () => {
    assert.equal(await code(workflowsApi.list(C)), 'forbidden:PROJECTS_DISABLED');
    assert.equal(await code(workflowsApi.samples(C)), 'forbidden:PROJECTS_DISABLED');
    assert.equal(await code(workflowsApi.handoffs(C)), 'forbidden:PROJECTS_DISABLED');
  });

  await step('samples: 3 starting points without lists; 8 placeholders', async () => {
    const s = await workflowsApi.samples(A);
    assert.deepEqual(s.items.map((i) => i.id), ['production', 'marketing', 'review']);
    assert.equal(s.placeholders.length, 8);
    for (const i of s.items) assert.ok(i.graph.nodes.every((n) => n.stackId === null && n.assignees.length === 0));
    assert.ok(graphIssues(s.items[2]!.graph, s.placeholders).some((i) => i.code === 'no_list'), 'editor warns: lists missing');
    return s.items.map((i) => `${i.id}(${i.graph.nodes.length})`).join(', ');
  });

  await step('graph validation (server): loop, auto → chosen step, unreadable list, non-member assignee, empty title', async () => {
    const n = (id: string, over: Record<string, unknown> = {}) => ({ id, label: id, stackId: todoP, assigneeMode: 'fixed', assignees: [], ...over });
    const g = (nodes: unknown[], edges: unknown[]) => ({ start: { mode: 'manual', nodeId: 'a' }, nodes, edges }) as unknown as WorkflowGraph;
    const create = (graph: WorkflowGraph, title = 'x') => code(workflowsApi.create(A, { title, graph }, key()));
    assert.equal(await create(g([n('a'), n('b')], [{ id: 'e1', from: 'a', to: 'b', mode: 'auto' }, { id: 'e2', from: 'b', to: 'a', mode: 'auto' }])), 'client:INVALID_GRAPH');
    assert.equal(await create(g([n('a'), n('b', { assigneeMode: 'choose' })], [{ id: 'e1', from: 'a', to: 'b', mode: 'auto' }])), 'client:INVALID_GRAPH');
    assert.equal(await create(g([n('a', { stackId: 999999 })], [])), 'client:INVALID_GRAPH');
    assert.equal(await create(g([n('a', { assignees: [UC] })], [])), 'client:INVALID_ASSIGNEE');
    assert.equal(await create(g([n('a')], []), '  '), 'client:FIELD_REQUIRED');
  });

  await step('create: prepare (fixed A) → hand-off → review (choose, allow-list B) and → auto → notify (Q list); same key → same template', async () => {
    graph = {
      start: { mode: 'manual', nodeId: 'prepare', stackId: null, boardId: null, x: 40, y: 120 },
      nodes: [
        { id: 'prepare', type: 'task', label: 'Hazırla', title: '{{run.title}} – {{step.label}}', description: '', stackId: todoP, boardId: null, assigneeMode: 'fixed', assignees: [UA], dueDays: 2, x: 270, y: 120 },
        { id: 'review', type: 'task', label: 'İncele', title: '{{run.title}} – {{step.label}}', description: 'Önceki: {{previous.title}}', stackId: todoP, boardId: null, assigneeMode: 'choose', assignees: [UB], dueDays: null, x: 610, y: 120 },
        { id: 'notify', type: 'task', label: 'Bildir', title: '{{run.title}} – bildir', description: '', stackId: todoQ, boardId: null, assigneeMode: 'fixed', assignees: [], dueDays: null, x: 610, y: 300 },
      ],
      edges: [
        { id: 'e1', from: 'prepare', to: 'review', mode: 'manual' },
        { id: 'e2', from: 'prepare', to: 'notify', mode: 'auto' },
      ],
    };
    assert.deepEqual(graphIssues(graph), []);
    const k = key();
    const d = await workflowsApi.create(A, { title: `Smoke akış ${stamp}`, category: 'production', graph }, k);
    wfId = d!.id;
    version = d!.version;
    const again = await workflowsApi.create(A, { title: `Smoke akış ${stamp}`, category: 'production', graph }, k);
    assert.equal(again!.id, wfId);
    assert.equal(d!.role, 'manage');
    assert.equal(d!.stepCount, 3);
    assert.equal(d!.entryLabel, 'Hazırla');
    assert.deepEqual(d!.graph.nodes.map((x) => x.boardId), [boardP, boardP, boardQ], 'boardId derived by the server');
    assert.deepEqual(d!.boards.map((b) => b.id).sort((a, b) => a - b), [boardP, boardQ].sort((a, b) => a - b));
    const list = await workflowsApi.list(A);
    assert.ok(list.workflows.some((w) => w.id === wfId));
    return `template ${wfId} v${version}`;
  });

  await step('update: title → version +1; stale version → 409 VERSION_CONFLICT; empty patch → 422; disabled → start 403 WORKFLOW_DISABLED', async () => {
    const d = await workflowsApi.update(A, wfId, { version, title: `Smoke akış ${stamp} ✓` });
    assert.equal(d!.version, version + 1);
    assert.equal(await code(workflowsApi.update(A, wfId, { version, title: 'eski' })), 'conflict:VERSION_CONFLICT');
    assert.equal(await code(workflowsApi.update(A, wfId, { version: d!.version })), 'client:EMPTY_PATCH');
    const off = await workflowsApi.update(A, wfId, { version: d!.version, enabled: false });
    assert.equal(await code(workflowsApi.start(A, wfId, {}, key())), 'forbidden:WORKFLOW_DISABLED');
    const on = await workflowsApi.update(A, wfId, { version: off!.version, enabled: true });
    version = on!.version;
    return `v${version}`;
  });

  await step('sharing: B without share → 404; view share → reads, cannot edit (403) or delete', async () => {
    assert.equal(await code(workflowsApi.get(B, wfId)), 'not_found:RESOURCE_NOT_FOUND');
    await workhubApi.setObjectShares(A, 'workflow', wfId, [{ principalType: 'user', principalId: UB, role: 'view' }]);
    const d = await workflowsApi.get(B, wfId);
    assert.equal(d.role, 'view');
    assert.equal(await code(workflowsApi.update(B, wfId, { version, title: 'B' })), 'forbidden:ACTION_FORBIDDEN');
    assert.equal(await code(workflowsApi.remove(B, wfId)), 'forbidden:ACTION_FORBIDDEN');
  });

  await step('run 1: start → entry card (assignee A, due +2 days); same Idempotency-Key → same run', async () => {
    const k = key();
    const r = await workflowsApi.start(A, wfId, { title: `Koşu 1 ${stamp}` }, k);
    run1 = r!;
    const again = await workflowsApi.start(A, wfId, { title: `Koşu 1 ${stamp}` }, k);
    assert.equal(again!.id, run1.id);
    const prep = stepOf(run1, 'prepare');
    assert.equal(prep.state, 'open');
    assert.ok(prep.cardId);
    assert.equal(prep.card?.title, `Koşu 1 ${stamp} – Hazırla`);
    assert.equal(prep.assignee?.uid, UA);
    assert.ok(prep.card?.due, 'due date from dueDays');
    assert.equal(run1.canManage, true);
    return `run ${run1.id}, card ${prep.cardId}`;
  });

  await step('complete entry card → hand-off pending (review) + automatic branch failed (A cannot edit Q); listed for A and per card', async () => {
    const r0 = run1!;
    const cardId = stepOf(r0, 'prepare').cardId!;
    await workhubApi.updateTask(A, cardId, { done: true });
    const r = await workflowsApi.run(A, r0.id);
    assert.equal(states(r), 'notify:failed,prepare:done,review:pending_handoff');
    const notify = stepOf(r, 'notify');
    assert.ok(notify.error, 'failure code stored');
    const review = stepOf(r, 'review');
    assert.equal(review.preview?.title, `Koşu 1 ${stamp} – İncele`);
    assert.equal(review.preview?.description, `Önceki: Koşu 1 ${stamp} – Hazırla`);
    const mine = await workflowsApi.handoffs(A);
    assert.ok(mine.some((h) => h.step.id === review.id) && mine.some((h) => h.step.id === notify.id));
    const forCard = await workflowsApi.cardHandoffs(A, cardId);
    assert.deepEqual(forCard.map((h) => h.step.nodeId).sort(), ['notify', 'review']);
    assert.equal(forCard[0]!.sourceCard?.id, cardId);
    run1 = r;
    return `notify error ${notify.error}; list ${(await workflowsApi.list(A)).pendingHandoffs} pending`;
  });

  await step('hand-off: assignee outside the allow-list → 422; to B → card for B; second hand-off → 409 WORKFLOW_STEP_HANDLED', async () => {
    const review = stepOf(run1!, 'review');
    assert.equal(await code(workflowsApi.handoff(A, review.id, { assigneeUid: UA }, key())), 'client:WORKFLOW_ASSIGNEE_NOT_ALLOWED');
    const r = await workflowsApi.handoff(A, review.id, { assigneeUid: UB, title: `İncele ${stamp}` }, key());
    const s = stepOf(r!, 'review');
    assert.equal(s.state, 'open');
    assert.equal(s.assignee?.uid, UB);
    assert.equal(s.card?.title, `İncele ${stamp}`);
    assert.equal(await code(workflowsApi.handoff(A, review.id, {}, key())), 'conflict:WORKFLOW_STEP_HANDLED');
    assert.equal(await code(workflowsApi.skip(A, review.id, '')), 'conflict:WORKFLOW_STEP_HANDLED');
    run1 = r!;
    return `card ${s.cardId}`;
  });

  await step('failed step: A retry → Deck refuses (step stays failed); B (view) cannot act; edit share → B retries → card on Q', async () => {
    const notify = stepOf(run1!, 'notify');
    const retryA = await code(workflowsApi.handoff(A, notify.id, {}, key()));
    assert.notEqual(retryA, 'ok');
    assert.equal(stepOf(await workflowsApi.run(A, run1!.id), 'notify').state, 'failed');
    assert.ok(!(await workflowsApi.handoffs(B)).some((h) => h.step.id === notify.id), 'view share: not actionable');
    assert.equal(await code(workflowsApi.handoff(B, notify.id, {}, key())), 'forbidden:ACTION_FORBIDDEN');
    await workhubApi.setObjectShares(A, 'workflow', wfId, [{ principalType: 'user', principalId: UB, role: 'edit' }]);
    assert.ok((await workflowsApi.handoffs(B)).some((h) => h.step.id === notify.id), 'edit share: actionable');
    const r = await workflowsApi.handoff(B, notify.id, {}, key());
    const s = stepOf(r!, 'notify');
    assert.equal(s.state, 'open');
    assert.equal(s.card?.boardId, boardQ);
    run1 = r!;
    return `A retry → ${retryA}; B retry → card ${s.cardId}`;
  });

  await step('B completes both cards → run completed; finishedAt set', async () => {
    await workhubApi.updateTask(B, stepOf(run1!, 'review').cardId!, { done: true });
    await workhubApi.updateTask(B, stepOf(run1!, 'notify').cardId!, { done: true });
    const r = await workflowsApi.run(A, run1!.id);
    assert.equal(r.state, 'completed');
    assert.ok(r.finishedAt);
    assert.equal(stepOf(r, 'review').doneBy?.uid, UB);
    assert.equal(await code(workflowsApi.cancel(A, r.id, r.version)), 'conflict:VERSION_CONFLICT');
    const p = runProgress(r);
    return `${p.done}/${p.total} done`;
  });

  await step('run 2: skip the hand-off (reason) and the failed branch → run completed', async () => {
    const r0 = await workflowsApi.start(A, wfId, { title: `Koşu 2 ${stamp}` }, key());
    await workhubApi.updateTask(A, stepOf(r0!, 'prepare').cardId!, { done: true });
    let r = await workflowsApi.run(A, r0!.id);
    r = (await workflowsApi.skip(A, stepOf(r, 'review').id, 'Gerek kalmadı'))!;
    assert.equal(r.state, 'running');
    r = (await workflowsApi.skip(A, stepOf(r, 'notify').id, ''))!;
    assert.equal(states(r), 'notify:skipped,prepare:done,review:skipped');
    assert.equal(r.state, 'completed');
  });

  await step('run 3: cancel with stale version → 409; cancel → open step skipped, card kept; cancel again → 409', async () => {
    const r0 = (await workflowsApi.start(A, wfId, { title: `Koşu 3 ${stamp}` }, key()))!;
    assert.equal(await code(workflowsApi.cancel(A, r0.id, r0.version + 5)), 'conflict:VERSION_CONFLICT');
    const r = (await workflowsApi.cancel(A, r0.id, r0.version))!;
    assert.equal(r.state, 'cancelled');
    assert.equal(stepOf(r, 'prepare').state, 'skipped');
    const card = await workhubApi.task(A, stepOf(r, 'prepare').cardId!);
    assert.equal(card.done, null, 'card stays in the project');
    assert.equal(await code(workflowsApi.cancel(A, r.id, r.version)), 'conflict:VERSION_CONFLICT');
  });

  await step('bind an existing card: entry = that card (no new card); bound again → 409 WORKFLOW_CARD_BOUND; done card → 409 WORKFLOW_CARD_DONE', async () => {
    const mk = async (title: string) => (await A.request<{ id: number }>(`/ocs/v2.php/apps/workhub/api/v1/projects/${boardP}/tasks`, { method: 'POST', body: { stackId: todoP, title }, headers: { 'Idempotency-Key': key() } })).data!.id;
    const cardId = await mk(`Bağlı kart ${stamp}`);
    const r = (await workflowsApi.start(A, wfId, { cardId }, key()))!;
    assert.equal(stepOf(r, 'prepare').cardId, cardId);
    assert.equal(r.title, `Bağlı kart ${stamp}`, 'run title = card title');
    assert.equal(await code(workflowsApi.start(A, wfId, { cardId }, key())), 'conflict:WORKFLOW_CARD_BOUND');
    const done = await mk(`Biten kart ${stamp}`);
    await workhubApi.updateTask(A, done, { done: true });
    assert.equal(await code(workflowsApi.start(A, wfId, { cardId: done }, key())), 'conflict:WORKFLOW_CARD_DONE');
    return `run ${r.id} (left running for the delete check)`;
  });

  await step('history: runs newest first with states; B (edit) sees them; counts in the list', async () => {
    const runs = await workflowsApi.runs(A, wfId);
    assert.ok(runs.length >= 4);
    assert.ok(runs.every((r, i) => i === 0 || runs[i - 1]!.id > r.id), 'newest first');
    const st = runs.map((r) => r.state);
    assert.ok(st.includes('completed') && st.includes('cancelled') && st.includes('running'));
    assert.equal((await workflowsApi.runs(B, wfId)).length, runs.length);
    const summary = (await workflowsApi.list(A)).workflows.find((w) => w.id === wfId)!;
    assert.equal(summary.runs.completed, 2);
    assert.equal(summary.runs.running, 1);
    return `${runs.length} runs: ${st.join(', ')}`;
  });

  await step('delete: B (edit) → 403; stale-version guard is client side; A deletes → 404, running run cancelled, still readable by its starter', async () => {
    assert.equal(await code(workflowsApi.remove(B, wfId)), 'forbidden:ACTION_FORBIDDEN');
    const running = (await workflowsApi.runs(A, wfId)).find((r) => r.state === 'running')!;
    const del = await workflowsApi.remove(A, wfId);
    assert.equal(del!.deleted, true);
    assert.equal(await code(workflowsApi.get(A, wfId)), 'not_found:RESOURCE_NOT_FOUND');
    const r = await workflowsApi.run(A, running.id);
    assert.equal(r.state, 'cancelled');
    assert.equal(r.workflowTitle, null);
    assert.ok(!(await workflowsApi.list(A)).workflows.some((w) => w.id === wfId));
    assert.ok(!(await workflowsApi.handoffs(A)).some((h) => h.run.workflowId === wfId));
  });

  for (const [name, res] of results) console.log(`${res.startsWith('PASS') ? '✔' : '✖'} ${name}: ${res}`);
  const failed = results.filter(([, r]) => !r.startsWith('PASS')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed) process.exitCode = 1;
}

void main();
