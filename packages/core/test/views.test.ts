import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectBackend, dispatchWire, isValidActivityFilter, isValidWorkloadQuery, type PlainStore } from '../src/backend';
import type { SecretStore } from '../src/accounts';
import { OcsError } from '../src/ocs';
import {
  ganttBar, ganttSchedule, linkViolated, mergeActivity, workloadLoad, workloadWeek, addDays, daysBetween,
  type ActivityEvent, type GanttDependency, type GanttTask,
} from '../src/workhub';
import { isValidLocalDate } from '../src/workhub';
import { json, ocs, scriptedFetch, type Call } from './helpers';

class Mem implements SecretStore, PlainStore {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
  async deletePrefix(p: string) { for (const k of [...this.m.keys()]) if (k.startsWith(p)) this.m.delete(k); }
}
const BAD = { ok: false, error: { kind: 'client', message: 'invalid arguments' } };
const bootstrap = (projects: boolean) => json(200, ocs({ apiVersion: '1', modules: { projects }, permissions: { canViewTeamReport: false } }));

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

const task = (id: number, over: Partial<GanttTask> = {}): GanttTask => ({
  id, boardId: 1, stackId: 1, order: id, title: `T${id}`, labels: [], priority: null, assignees: [], startDate: null, dueDate: null, done: null,
  archived: false, lastModified: '', url: '', subtasks: { done: 0, total: 0 }, estimateSec: null, dependsOn: [], ...over,
});
const dep = (id: number, predecessorId: number, successorId: number, over: Partial<GanttDependency> = {}): GanttDependency => ({ id, predecessorId, successorId, type: 'finish_to_start', lagDays: 0, ...over });
const utcDay = (iso: string) => iso.slice(0, 10);

test('day math is calendar-exact across months and DST', () => {
  assert.equal(isValidLocalDate('2026-02-30'), false, 'impossible day is refused, not thrown');
  assert.equal(isValidLocalDate('2028-02-29'), true);
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-03-29', 1), '2026-03-30');
  assert.equal(daysBetween('2026-02-27', '2026-03-01'), 2);
  assert.deepEqual(workloadWeek('2026-11-04'), { from: '2026-11-02', to: '2026-11-08' }, 'Wednesday → Monday week');
  assert.deepEqual(workloadWeek('2026-11-02'), { from: '2026-11-02', to: '2026-11-08' });
  assert.deepEqual(workloadWeek('2026-11-08'), { from: '2026-11-02', to: '2026-11-08' }, 'Sunday belongs to the week before');
  assert.deepEqual(workloadWeek('2026-11-04', 7), { from: '2026-11-01', to: '2026-11-07' }, 'Sunday week start');
});

test('gantt schedule: bars, milestones, unscheduled, clamped start, range, archived hidden', () => {
  const s = ganttSchedule({
    tasks: [
      task(1, { startDate: '2026-11-02T00:00:00Z', dueDate: '2026-11-05T00:00:00Z' }),
      task(2, { dueDate: '2026-11-10T00:00:00Z' }),
      task(3, { startDate: '2026-11-20T00:00:00Z', dueDate: '2026-11-12T00:00:00Z' }),
      task(4),
      task(5, { done: '2026-11-01T00:00:00Z' }),
      task(6, { dueDate: '2026-12-01T00:00:00Z', archived: true }),
      task(7, { startDate: '2026-10-20T00:00:00Z', dueDate: '2026-10-25T00:00:00Z' }),
    ],
    dependencies: [],
  }, '2026-11-03', utcDay);
  assert.deepEqual(s.rows.map((r) => r.task.id), [7, 1, 2, 3]);
  const [r7, r1, r2, r3] = s.rows;
  assert.equal(r1!.days, 4);
  assert.equal(r2!.milestone, true);
  assert.equal(r2!.days, 1);
  assert.equal(r3!.start, '2026-11-12', 'start after due is clamped to due');
  assert.equal(r7!.overdue, true);
  assert.equal(r1!.overdue, false);
  assert.deepEqual(s.unscheduled.map((r) => r.task.id), [4], 'done task without dates is not listed as unscheduled');
  assert.deepEqual(s.range, { start: '2026-10-20', end: '2026-11-12', days: 24 });
  assert.deepEqual(ganttBar(r1!, s.range!), { left: 13 / 24, width: 4 / 24 });
  assert.equal(ganttBar({ start: null, end: null }, s.range!), null);
  assert.equal(ganttSchedule({ tasks: [task(1)], dependencies: [] }, '2026-11-03', utcDay).range, null);
});

test('dependency rules per type and lag; open predecessor blocks; unknown ends ignored', () => {
  const a = { start: '2026-11-02', end: '2026-11-05' };
  assert.equal(linkViolated(dep(1, 1, 2), a, { start: '2026-11-06', end: '2026-11-07' }), false, 'FS: next day is fine');
  assert.equal(linkViolated(dep(1, 1, 2), a, { start: '2026-11-05', end: '2026-11-07' }), true, 'FS: same day overlaps');
  assert.equal(linkViolated(dep(1, 1, 2, { lagDays: 2 }), a, { start: '2026-11-07', end: '2026-11-09' }), true, 'FS + 2 days lag');
  assert.equal(linkViolated(dep(1, 1, 2, { lagDays: 2 }), a, { start: '2026-11-08', end: '2026-11-09' }), false);
  assert.equal(linkViolated(dep(1, 1, 2, { type: 'start_to_start' }), a, { start: '2026-11-02', end: '2026-11-02' }), false);
  assert.equal(linkViolated(dep(1, 1, 2, { type: 'start_to_start', lagDays: 1 }), a, { start: '2026-11-02', end: '2026-11-09' }), true);
  assert.equal(linkViolated(dep(1, 1, 2, { type: 'finish_to_finish' }), a, { start: '2026-11-01', end: '2026-11-04' }), true);
  assert.equal(linkViolated(dep(1, 1, 2), a, { start: null, end: null }), false);

  const s = ganttSchedule({
    tasks: [
      task(1, { startDate: '2026-11-02T00:00:00Z', dueDate: '2026-11-05T00:00:00Z' }),
      task(2, { startDate: '2026-11-04T00:00:00Z', dueDate: '2026-11-08T00:00:00Z' }),
      task(3, { done: '2026-11-01T00:00:00Z', dueDate: '2026-11-01T00:00:00Z' }),
      task(4),
    ],
    dependencies: [dep(10, 1, 2), dep(11, 3, 4), dep(12, 99, 4)],
  }, '2026-11-03', utcDay);
  const row = (id: number) => [...s.rows, ...s.unscheduled].find((r) => r.task.id === id)!;
  assert.equal(s.violations, 1);
  assert.equal(row(2).blocked, true);
  assert.equal(row(2).waitsFor[0]!.violated, true);
  assert.deepEqual(row(1).blocks.map((l) => l.other.id), [2]);
  assert.equal(row(4).blocked, false, 'done predecessor no longer blocks; unknown predecessor is skipped');
  assert.equal(row(4).waitsFor.length, 1);
});

test('activity pages merge without duplicates; workload cell states', () => {
  const e = (id: string): ActivityEvent => ({ id, type: 'status', kind: 'card_create', actor: null, card: null, data: {}, occurredAt: '' });
  assert.deepEqual(mergeActivity([e('a'), e('b')], [e('b'), e('c')]).map((x) => x.id), ['a', 'b', 'c']);
  assert.equal(workloadLoad({ plannedSec: 0, capacitySec: 0 }), 'off');
  assert.equal(workloadLoad({ plannedSec: 60, capacitySec: 0 }), 'over', 'work planned on a day off');
  assert.equal(workloadLoad({ plannedSec: 0, capacitySec: 28800 }), 'free');
  assert.equal(workloadLoad({ plannedSec: 3600, capacitySec: 28800 }), 'ok');
  assert.equal(workloadLoad({ plannedSec: 24480, capacitySec: 28800 }), 'full', '85%');
  assert.equal(workloadLoad({ plannedSec: 28800, capacitySec: 28800 }), 'full');
  assert.equal(workloadLoad({ plannedSec: 28801, capacitySec: 28800 }), 'over');
});

test('IPC validation: activity filter, cursor and workload query are strict', async () => {
  assert.equal(isValidActivityFilter({ type: 'all' }), true);
  assert.equal(isValidActivityFilter({ type: 'comments', actor: 'bob', from: '2026-11-01', to: '2026-11-02', q: 'x' }), true);
  for (const bad of [{}, { type: 'update' }, { type: 'all', extra: 1 }, { type: 'all', from: '2026-11-03', to: '2026-11-02' }, { type: 'all', from: '2026-1-1' }, { type: 'all', from: '2026-13-01' }, { type: 'all', to: '2026-02-30' }, { type: 'all', q: 'x'.repeat(201) }, { type: 'all', actor: '' }]) {
    assert.equal(isValidActivityFilter(bad), false, JSON.stringify(bad));
  }
  assert.equal(isValidWorkloadQuery({ from: '2026-11-02', to: '2026-11-08' }), true);
  assert.equal(isValidWorkloadQuery({ from: '2026-11-02', to: '2026-11-08', boardIds: [1, 2], members: ['alice'] }), true);
  for (const bad of [
    { from: '2026-11-02' }, { from: '2026-11-09', to: '2026-11-08' }, { from: '2026-02-29', to: '2026-03-01' }, { from: '2026-01-01', to: '2026-06-01' },
    { from: '2026-11-02', to: '2026-11-08', boardIds: [1, 1] }, { from: '2026-11-02', to: '2026-11-08', boardIds: [0] },
    { from: '2026-11-02', to: '2026-11-08', members: ['a,b'] }, { from: '2026-11-02', to: '2026-11-08', zone: 'UTC' },
  ]) assert.equal(isValidWorkloadQuery(bad), false, JSON.stringify(bad));

  const backend = { projectGantt: async () => 'ok', projectActivity: async () => 'ok', workload: async () => 'ok' } as never;
  const acc = 'acc-1234567890abcdef';
  assert.deepEqual(await dispatchWire(backend, 'projectActivity', [acc, 1, { type: 'all' }, 'MTc5MzY0MzcwMQ==']), { ok: true, value: 'ok' });
  assert.deepEqual(await dispatchWire(backend, 'projectActivity', [acc, 1, { type: 'all' }, null]), { ok: true, value: 'ok' });
  assert.deepEqual(await dispatchWire(backend, 'projectActivity', [acc, 1, { type: 'all' }, '../x']), BAD);
  assert.deepEqual(await dispatchWire(backend, 'projectActivity', [acc, 1, { type: 'all' }]), BAD);
  assert.deepEqual(await dispatchWire(backend, 'projectGantt', [acc, -1]), BAD);
  assert.deepEqual(await dispatchWire(backend, 'workload', [acc, { from: '2026-11-02', to: '2026-11-08' }]), { ok: true, value: 'ok' });
  assert.deepEqual(await dispatchWire(backend, 'workload', [acc, { from: '2026-11-02', to: '2027-11-08' }]), BAD);
});

test('backend: projects gate fails closed; requests carry the exact server query', async () => {
  const off = await loggedIn(bootstrap(false));
  await assert.rejects(off.b.workload(off.id, { from: '2026-11-02', to: '2026-11-08' }), (e: unknown) => e instanceof OcsError && e.errorCode === 'PROJECTS_DISABLED');
  assert.equal(off.f.calls.length, 3, 'no workload request when the module is off');

  const { b, f, id } = await loggedIn(
    bootstrap(true),
    json(200, ocs({ events: [], nextCursor: null, sources: { deck: true, time: false, goals: false } })),
    json(200, ocs({ members: [] })),
    json(200, ocs({ project: {}, tasks: [], dependencies: [] })),
  );
  await b.projectActivity(id, 4, { type: 'comments', actor: 'bob', q: '  hata  ' }, 'MTc5MzY0MzcwMQ==');
  const a = new URL(f.calls[3]!.url);
  assert.equal(a.pathname, '/ocs/v2.php/apps/workhub/api/v1/projects/4/views/activity');
  assert.deepEqual(Object.fromEntries(a.searchParams), { format: 'json', type: 'comments', actor: 'bob', q: 'hata', cursor: 'MTc5MzY0MzcwMQ==', limit: '30' });
  await b.workload(id, { from: '2026-11-02', to: '2026-11-08', boardIds: [3, 4], members: ['alice', 'bob'] });
  const w = new URL(f.calls[4]!.url);
  assert.equal(w.pathname, '/ocs/v2.php/apps/workhub/api/v1/workload');
  assert.deepEqual(Object.fromEntries(w.searchParams), { format: 'json', from: '2026-11-02', to: '2026-11-08', boardIds: '3,4', members: 'alice,bob' });
  await b.projectGantt(id, 4);
  assert.match(f.calls[5]!.url, /\/projects\/4\/views\/gantt\?format=json$/);
});
