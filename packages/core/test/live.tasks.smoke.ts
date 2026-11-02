/**
 * Live smoke for native task editing (GENE-49): fields, assignee picker set, labels, subtasks
 * with expectedText, dependencies (incl. cycle), and the ACL for a restricted user.
 * Not part of `npm test`. Run: `npm run smoke:tasks -w @workhub-devices/core` with
 *   WH_SERVER, WH_ALLOW_HTTP=1 (local dev only), WH_A_USER/WH_A_PASS (project owner),
 *   WH_B_USER/WH_B_PASS (member), WH_C_USER/WH_C_PASS (no Projects module).
 * Goes through the same Backend-facing API (`workhubApi`) and form diff (`buildTaskPatch`) the UI uses.
 * Prints no secrets; the project it creates is kept (there is no project delete API), its tasks are deleted.
 */
import assert from 'node:assert/strict';
import { OcsClient, OcsError, normalizeServerUrl, workhubApi, buildTaskPatch, taskFormOf, type ServerBase, type TaskDetail } from '../src/index';

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
const WH = '/ocs/v2.php/apps/workhub/api/v1';
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

async function main() {
  let boardId = 0;
  let stackId = 0;
  let t1 = 0;
  let t2 = 0;
  const key = () => ({ 'Idempotency-Key': crypto.randomUUID() });

  await step('setup: project + member B + label + two tasks', async () => {
    boardId = (await A.request<{ id: number }>(`${WH}/projects`, { method: 'POST', body: { title: `GENE-49 edit smoke ${new Date().toISOString()}` }, headers: key() })).data!.id;
    await A.request(`${WH}/projects/${boardId}/members`, { method: 'POST', body: { type: 'user', participant: env('WH_B_USER'), edit: true, share: false, manage: false }, headers: key() });
    const board = await workhubApi.board(A, boardId);
    stackId = board.project.stacks[0]!.id;
    t1 = (await A.request<{ id: number }>(`${WH}/projects/${boardId}/tasks`, { method: 'POST', body: { stackId, title: 'Edit me' }, headers: key() })).data!.id;
    t2 = (await A.request<{ id: number }>(`${WH}/projects/${boardId}/tasks`, { method: 'POST', body: { stackId, title: 'Predecessor' }, headers: key() })).data!.id;
    return `boardId=${boardId}, members=${board.project.members.map((m) => m.uid).join(',')}, labels=${board.project.labels.length}`;
  });

  await step('edit form → PATCH: title, description, priority, dates, estimate, assignees', async () => {
    const board = await workhubApi.board(A, boardId);
    const task = await workhubApi.task(A, t1);
    const form = { ...taskFormOf(task, board.project.labels), title: 'Edited title', description: 'Native açıklama', priority: 'high' as const, startDate: '2026-11-03', dueDate: '2026-11-20', estimateHours: '2,5', assignees: [env('WH_B_USER')] };
    const r = buildTaskPatch(task, board.project.labels, form);
    assert.ok('patch' in r);
    await workhubApi.updateTask(A, t1, r.patch);
    const read = await workhubApi.task(A, t1);
    assert.equal(read.title, 'Edited title');
    assert.equal(read.description.trim(), 'Native açıklama');
    assert.equal(read.priority, 'high');
    assert.equal(read.startDate?.slice(0, 10), '2026-11-03');
    assert.equal(read.dueDate?.slice(0, 10), '2026-11-20');
    assert.equal(read.estimateSec, 9000);
    assert.deepEqual(read.assignees.filter((a) => a.type === 'user').map((a) => a.id), [env('WH_B_USER')]);
    // An unchanged form must produce an empty patch against the server's own read-back.
    const board2 = await workhubApi.board(A, boardId);
    assert.deepEqual(buildTaskPatch(read, board2.project.labels, taskFormOf(read, board2.project.labels)), { patch: {} });
    return `patched fields=${Object.keys(r.patch).join(',')}`;
  });

  await step('labels: full set keeps the priority label', async () => {
    const board = await workhubApi.board(A, boardId);
    const plain = board.project.labels.find((l) => !l.priority);
    if (!plain) return 'skipped — project has no plain label and there is no label-create API';
    const task = await workhubApi.task(A, t1);
    const r = buildTaskPatch(task, board.project.labels, { ...taskFormOf(task, board.project.labels), labels: [plain.id] });
    assert.ok('patch' in r);
    await workhubApi.updateTask(A, t1, r.patch);
    const read = await workhubApi.task(A, t1);
    assert.ok(read.labels.includes(plain.id));
    assert.equal(read.priority, 'high', 'priority label was dropped');
    return `labels=${read.labels.length}`;
  });

  await step('validation errors come back as typed errors', async () => {
    assert.equal(await code(workhubApi.updateTask(A, t1, { startDate: '2026-12-30', dueDate: '2026-12-01' })), 'client:INVALID_DATE_RANGE');
    assert.equal(await code(workhubApi.updateTask(A, t1, { assignees: [env('WH_C_USER')] })), 'client:INVALID_ASSIGNEE');
  });

  await step('subtasks: add, check, rename, stale delete → conflict, delete', async () => {
    await workhubApi.addSubtask(A, t1, 'Birinci');
    let l = await workhubApi.addSubtask(A, t1, 'İkinci');
    assert.deepEqual(l!.subtasks.map((s) => s.text), ['Birinci', 'İkinci']);
    l = await workhubApi.updateSubtask(A, t1, 0, 'Birinci', { done: true });
    assert.equal(l!.progress.done, 1);
    l = await workhubApi.updateSubtask(A, t1, 1, 'İkinci', { text: 'İkinci (yeni)' });
    assert.equal(l!.subtasks[1]!.text, 'İkinci (yeni)');
    const stale = await code(workhubApi.deleteSubtask(A, t1, 1, 'İkinci'));
    assert.notEqual(stale, 'ok', 'stale expectedText must not delete');
    l = await workhubApi.deleteSubtask(A, t1, 1, 'İkinci (yeni)');
    assert.deepEqual(l!.subtasks.map((s) => s.text), ['Birinci']);
    const read: TaskDetail = await workhubApi.task(A, t1);
    assert.equal(read.description.trim(), 'Native açıklama', 'description lost its text');
    assert.deepEqual(read.subtasks, { done: 1, total: 1 });
    return `stale delete → ${stale}`;
  });

  await step('dependencies: add, appears on both sides, cycle → 409, remove', async () => {
    const dep = await workhubApi.addDependency(A, t2, t1);
    let read = await workhubApi.task(A, t1);
    assert.deepEqual(read.predecessors.map((p) => p.id), [t2]);
    assert.deepEqual((await workhubApi.task(A, t2)).successors.map((s) => s.id), [t1]);
    assert.equal(await code(workhubApi.addDependency(A, t1, t2)), 'conflict:DEPENDENCY_CYCLE');
    await workhubApi.removeDependency(A, t1, read.predecessors[0]!.dependencyId);
    read = await workhubApi.task(A, t1);
    assert.equal(read.predecessors.length, 0);
    return `dependencyId=${dep!.id}`;
  });

  await step('member B edits; restricted C is refused', async () => {
    await workhubApi.updateTask(B, t1, { title: 'Edited by B' });
    assert.equal((await workhubApi.task(A, t1)).title, 'Edited by B');
    const c = await code(workhubApi.updateTask(C, t1, { title: 'nope' }));
    assert.ok(c.startsWith('forbidden') || c.startsWith('not_found'), c);
    const cs = await code(workhubApi.addSubtask(C, t1, 'nope'));
    assert.ok(cs.startsWith('forbidden') || cs.startsWith('not_found'), cs);
    return `C patch → ${c}`;
  });

  await step('project counters reflect created/closed tasks', async () => {
    const before = (await workhubApi.projects(A)).find((p) => p.id === boardId)!;
    await workhubApi.updateTask(A, t2, { done: true });
    const after = (await workhubApi.projects(A)).find((p) => p.id === boardId)!;
    assert.equal(after.doneCount, before.doneCount + 1);
    assert.equal(after.openCount, before.openCount - 1);
    return `open ${before.openCount}→${after.openCount}, done ${before.doneCount}→${after.doneCount}`;
  });

  await step('cleanup: delete tasks', async () => {
    for (const id of [t1, t2]) if (id) await A.request(`${WH}/tasks/${id}`, { method: 'DELETE' });
  });

  console.log(`server: ${base}\n`);
  for (const [n, r] of results) console.log(`${r.startsWith('PASS') ? '✔' : '✘'} ${n}: ${r}`);
  if (results.some(([, r]) => r.startsWith('FAIL'))) process.exitCode = 1;
}

main().catch((e) => {
  console.error('smoke aborted:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
