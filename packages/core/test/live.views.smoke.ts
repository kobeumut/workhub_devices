/**
 * Live smoke for the project views slice (GENE-53): Gantt payload (dates, dependencies with
 * type/lag) through the client scheduler, the activity stream (type filters, cursor paging
 * without duplicates, invalid cursor), and the workload matrix (estimate spread over work days,
 * board restriction, range limits), plus the access rules (non-member 404, module off 403).
 * Not part of `npm test`. Run: `npm run smoke:views -w @workhub-devices/core` with
 *   WH_SERVER, WH_ALLOW_HTTP=1 (local dev only), WH_A_USER/WH_A_PASS (project owner),
 *   WH_B_USER/WH_B_PASS (not a member), WH_C_USER/WH_C_PASS (Projects module off).
 * Creates one project + three cards per run (Workhub has no project delete API). Prints no secrets.
 */
import assert from 'node:assert/strict';
import {
  OcsClient, OcsError, addDays, ganttSchedule, normalizeServerUrl, projectViewsApi, workhubApi, workloadWeek, deviceDay,
  type ActivityEvent, type ServerBase,
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
const H = 3600;
// Events of one second always stay on one page (server rule); spread them so paging is exercised.
const tick = () => new Promise((r) => setTimeout(r, 1100));

async function main() {
  // Next week (Mon…Sun) in the device zone; the dev server reports in Europe/Istanbul, same as here.
  const week = workloadWeek(addDays(deviceDay(new Date().toISOString()), 7));
  const [mon, tue, wed, fri] = [week.from, addDays(week.from, 1), addDays(week.from, 2), addDays(week.from, 4)];
  let boardId = 0;
  const ids = { t1: 0, t2: 0, t3: 0 };
  const me = env('WH_A_USER');

  await step('setup: project + 3 tasks (dated, estimated, assigned) + finish→start dependency', async () => {
    const p = await workhubApi.createProject(A, `GENE-53 smoke ${stamp}`, undefined, key());
    boardId = p!.id;
    const board = await workhubApi.board(A, boardId);
    const stack = board.project.stacks.slice().sort((a, b) => a.order - b.order)[0]!.id;
    const create = async (title: string) => (await A.request<{ id: number }>(`/ocs/v2.php/apps/workhub/api/v1/projects/${boardId}/tasks`, { method: 'POST', body: { stackId: stack, title }, headers: { 'Idempotency-Key': key() } })).data!.id;
    ids.t1 = await create('Tasarım');
    await tick();
    ids.t2 = await create('Uygulama');
    await tick();
    ids.t3 = await create('Tarihsiz iş');
    await tick();
    await workhubApi.updateTask(A, ids.t1, { startDate: mon, dueDate: wed, estimateSec: 6 * H, assignees: [me] });
    await tick();
    await workhubApi.updateTask(A, ids.t2, { startDate: tue, dueDate: fri, estimateSec: 4 * H, assignees: [me] });
    await workhubApi.addDependency(A, ids.t1, ids.t2);
    await tick();
    await workhubApi.addSubtask(A, ids.t2, 'Kod incelemesi');
    return `project ${boardId}, week ${week.from}`;
  });

  await step('gantt: payload carries dates + dependency; client schedule finds the overlap', async () => {
    const g = await projectViewsApi.gantt(A, boardId);
    assert.equal(g.project.board.id, boardId);
    const t2 = g.tasks.find((t) => t.id === ids.t2)!;
    assert.deepEqual(t2.dependsOn, [ids.t1]);
    assert.equal(t2.estimateSec, 4 * H);
    const d = g.dependencies.find((x) => x.successorId === ids.t2)!;
    assert.deepEqual([d.predecessorId, d.type, d.lagDays], [ids.t1, 'finish_to_start', 0]);
    const s = ganttSchedule(g, mon);
    assert.deepEqual(s.rows.map((r) => r.task.id), [ids.t1, ids.t2]);
    assert.deepEqual([s.rows[0]!.start, s.rows[0]!.end, s.rows[0]!.days], [mon, wed, 3]);
    assert.deepEqual(s.unscheduled.map((r) => r.task.id), [ids.t3]);
    assert.equal(s.violations, 1, 'Uygulama starts before Tasarım ends');
    assert.equal(s.rows[1]!.blocked, true);
    assert.deepEqual(s.range, { start: mon, end: fri, days: 5 });
    return `${s.rows.length} scheduled, ${s.unscheduled.length} unscheduled, ${s.violations} violation`;
  });

  await step('activity: newest first, cursor paging without duplicates, type filters, bad cursor → 422', async () => {
    const all: ActivityEvent[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await projectViewsApi.activity(A, boardId, { type: 'all' }, cursor, 2);
      all.push(...page.events);
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 50);
    assert.equal(cursor, null, 'stream ends');
    assert.ok(pages > 1, 'more than one page');
    assert.equal(new Set(all.map((e) => e.id)).size, all.length, 'no event repeated across pages');
    const times = all.map((e) => Date.parse(e.occurredAt));
    assert.ok(times.every((t, i) => i === 0 || t <= times[i - 1]!), 'newest first');
    const one = await projectViewsApi.activity(A, boardId, { type: 'all' }, null, 100);
    assert.deepEqual(one.events.map((e) => e.id).sort(), all.map((e) => e.id).sort(), 'paged = single page');
    assert.ok(all.some((e) => e.kind === 'card_create' && e.card?.id === ids.t3));
    const sub = await projectViewsApi.activity(A, boardId, { type: 'subtasks' });
    assert.ok(sub.events.length >= 1 && sub.events.every((e) => e.type === 'subtasks'));
    assert.equal(sub.events[0]!.kind, 'task.subtask.add');
    const status = await projectViewsApi.activity(A, boardId, { type: 'status' });
    assert.ok(status.events.every((e) => e.type === 'status'));
    const q = await projectViewsApi.activity(A, boardId, { type: 'all', q: 'tarihsiz' });
    assert.ok(q.events.length >= 1 && q.events.every((e) => e.card?.id === ids.t3));
    assert.equal(await code(projectViewsApi.activity(A, boardId, { type: 'all' }, 'bm90LWEtbnVtYmVy')), 'client:INVALID_CURSOR');
    assert.equal(await code(projectViewsApi.activity(A, boardId, { type: 'all', from: 'yesterday-ish' })), 'client:INVALID_DATE');
    // Server note: `from=2026-13-01` is accepted (month overflow) — the client IPC validator refuses non-calendar days.
    return `${all.length} events in ${pages} pages; sources ${JSON.stringify(one.sources)}`;
  });

  await step('workload: estimates spread over work days, board restriction, totals', async () => {
    const m = await projectViewsApi.workload(A, { from: week.from, to: week.to, boardIds: [boardId] });
    assert.deepEqual(m.boards.map((b) => b.id), [boardId]);
    assert.equal(m.days.length, 7);
    const row = m.members.find((x) => x.uid === me)!;
    const day = (d: string) => row.days.find((x) => x.date === d)!;
    assert.equal(day(mon).plannedSec, 2 * H, 'Tasarım 6 h over Mon–Wed');
    assert.equal(day(tue).plannedSec, 2 * H + 1 * H, 'plus Uygulama 4 h over Tue–Fri');
    assert.equal(day(fri).plannedSec, 1 * H);
    assert.equal(day(addDays(week.from, 5)).capacitySec, 0, 'Saturday is not a work day');
    assert.equal(row.plannedSec, 10 * H);
    assert.equal(row.taskCount, 2);
    assert.deepEqual(row.unscheduled, [], 'the undated task is not assigned');
    assert.ok(m.tasks[String(ids.t1)]?.title === 'Tasarım');
    assert.ok(typeof row.actualSec === 'number', 'own time is visible');
    return `planned ${row.plannedSec / H} h / capacity ${row.capacitySec / H} h`;
  });

  await step('workload: invalid and too long ranges → 422', async () => {
    assert.equal(await code(projectViewsApi.workload(A, { from: week.to, to: week.from })), 'client:INVALID_DATE_RANGE');
    assert.equal(await code(projectViewsApi.workload(A, { from: week.from, to: addDays(week.from, 120) })), 'client:RANGE_TOO_LARGE');
  });

  await step('access: non-member gets 404 on views; module-off user 403; workload hides foreign boards', async () => {
    assert.equal(await code(projectViewsApi.gantt(B, boardId)), 'not_found:RESOURCE_NOT_FOUND');
    assert.equal(await code(projectViewsApi.activity(B, boardId, { type: 'all' })), 'not_found:RESOURCE_NOT_FOUND');
    const mb = await projectViewsApi.workload(B, { from: week.from, to: week.to, boardIds: [boardId] });
    assert.deepEqual([mb.boards.length, mb.members.length], [0, 0]);
    const c = await code(projectViewsApi.workload(C, { from: week.from, to: week.to }));
    assert.match(c, /^forbidden:/);
    return `outsider: ${c}`;
  });

  for (const [n, r] of results) console.log(`${r.startsWith('PASS') ? '✔' : '✖'} ${n}: ${r}`);
  const failed = results.filter(([, r]) => !r.startsWith('PASS')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

void main();
