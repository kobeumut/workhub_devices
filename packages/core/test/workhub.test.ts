import test from 'node:test';
import assert from 'node:assert/strict';
import { openTaskFromNotification, workhubApi } from '../src/workhub';
import { OcsClient } from '../src/ocs';
import { normalizeServerUrl } from '../src/serverUrl';
import { headerOf, json, ocs, scriptedFetch } from './helpers';

const client = (f: ReturnType<typeof scriptedFetch>) =>
  new OcsClient({ serverBase: normalizeServerUrl('https://example.com/nc'), getCredentials: async () => ({ loginName: 'a', appPassword: 'b' }), fetch: f });

test('opening a task from a notification always re-fetches with current ACL', async () => {
  const f = scriptedFetch(
    json(200, ocs({ id: 5, title: 'Güncel başlık' })),
    json(403, ocs({ error: 'ACTION_FORBIDDEN' }, 403, 'failure')),
    json(403, ocs({ error: 'PROJECTS_DISABLED' }, 403, 'failure')),
    json(404, ocs({ error: 'RESOURCE_NOT_FOUND' }, 404, 'failure')),
  );
  const c = client(f);
  const ok = await openTaskFromNotification(c, 5, true);
  assert.equal(ok.state === 'ok' && ok.task.title, 'Güncel başlık');
  assert.equal(f.calls[0]!.url, 'https://example.com/nc/ocs/v2.php/apps/workhub/api/v1/tasks/5?format=json');
  assert.deepEqual(await openTaskFromNotification(c, 5, true), { state: 'forbidden' });
  assert.deepEqual(await openTaskFromNotification(c, 5, true), { state: 'feature_off' });
  assert.deepEqual(await openTaskFromNotification(c, 5, true), { state: 'gone' });
  assert.deepEqual(await openTaskFromNotification(c, 5, false), { state: 'feature_off' });
  assert.equal(f.calls.length, 4);
});

test('ids are validated and comment create carries an Idempotency-Key', async () => {
  await assert.rejects(workhubApi.task(client(scriptedFetch()), -1));
  await assert.rejects(workhubApi.task(client(scriptedFetch()), 1.5));
  const f = scriptedFetch(json(201, ocs({ id: 1, message: 'x' })), json(200, ocs({ projects: [{ id: 1 }] })));
  await workhubApi.addComment(client(f), 5, 'x', 'key-1');
  assert.equal(headerOf(f.calls[0], 'Idempotency-Key'), 'key-1');
  assert.equal((await workhubApi.projects(client(f))).length, 1);
  assert.equal(new URL(f.calls[1]!.url).searchParams.get('includeArchived'), '0');
});

test('subtask writes carry expectedText; dependency direction is predecessor → successor', async () => {
  const list = ocs({ cardId: 5, subtasks: [{ index: 0, text: 'a', done: true }], progress: { done: 1, total: 1 } });
  const f = scriptedFetch(json(201, list), json(200, list), json(200, list), json(201, ocs({ id: 9 })), json(200, ocs({ id: 9, deleted: true })));
  const c = client(f);
  assert.equal((await workhubApi.addSubtask(c, 5, 'a'))?.progress.total, 1);
  await workhubApi.updateSubtask(c, 5, 0, 'a', { done: true });
  await workhubApi.deleteSubtask(c, 5, 0, 'a & b');
  await workhubApi.addDependency(c, 3, 5);
  await workhubApi.removeDependency(c, 5, 9);
  const [add, upd, del, dep, rm] = f.calls;
  assert.equal(add!.init.method, 'POST');
  assert.equal(new URL(upd!.url).pathname, '/nc/ocs/v2.php/apps/workhub/api/v1/tasks/5/subtasks/0');
  assert.equal(upd!.init.method, 'PUT');
  assert.deepEqual(JSON.parse(String(upd!.init.body)), { expectedText: 'a', done: true });
  assert.equal(del!.init.method, 'DELETE');
  assert.equal(new URL(del!.url).searchParams.get('expectedText'), 'a & b');
  assert.equal(new URL(dep!.url).pathname, '/nc/ocs/v2.php/apps/workhub/api/v1/tasks/3/dependencies');
  assert.deepEqual(JSON.parse(String(dep!.init.body)), { successorCardId: 5 });
  assert.equal(new URL(rm!.url).pathname, '/nc/ocs/v2.php/apps/workhub/api/v1/tasks/5/dependencies/9');
  await assert.rejects(workhubApi.updateSubtask(c, 5, -1, 'a', { done: true }));
});

test('task form → minimal PATCH; labels keep the priority label; validation', async () => {
  const { buildTaskPatch, taskFormOf } = await import('../src/workhub');
  const labels = [
    { id: 1, title: 'Acil', color: 'f00', priority: 'urgent' as const },
    { id: 2, title: 'UI', color: '00f', priority: null },
    { id: 3, title: 'API', color: '0f0', priority: null },
  ];
  const task = {
    id: 5, boardId: 1, stackId: 1, order: 0, title: 'Eski', labels: [1, 2], priority: 'urgent' as const,
    assignees: [{ type: 'user' as const, id: 'bob', displayName: 'Bob' }, { type: 'group' as const, id: 'staff', displayName: 'Staff' }],
    startDate: null, dueDate: '2026-11-10T00:00:00Z', done: null, archived: false, lastModified: '', url: '', subtasks: { done: 0, total: 0 },
    description: 'açıklama', estimateSec: 5400, subtaskItems: [], predecessors: [], successors: [],
  };
  const form = taskFormOf(task, labels);
  assert.deepEqual(form, { title: 'Eski', description: 'açıklama', priority: 'urgent', startDate: '', dueDate: '2026-11-10', estimateHours: '1.5', labels: [2], assignees: ['bob'] });
  assert.deepEqual(buildTaskPatch(task, labels, form), { patch: {} });
  assert.deepEqual(buildTaskPatch(task, labels, { ...form, title: ' Yeni ', labels: [3], assignees: ['alice'], dueDate: '', estimateHours: '2,25', priority: null }), {
    patch: { title: 'Yeni', priority: null, dueDate: null, estimateSec: 8100, labels: [3, 1], assignees: ['alice'] },
  });
  assert.deepEqual(buildTaskPatch(task, labels, { ...form, title: '  ' }), { error: 'title_empty' });
  assert.deepEqual(buildTaskPatch(task, labels, { ...form, startDate: '2026-02-30' }), { error: 'date_invalid' });
  assert.deepEqual(buildTaskPatch(task, labels, { ...form, startDate: '2026-12-01' }), { error: 'date_range' });
  assert.deepEqual(buildTaskPatch(task, labels, { ...form, estimateHours: '-1' }), { error: 'estimate_invalid' });
  assert.deepEqual(buildTaskPatch(task, labels, { ...form, estimateHours: '' }), { patch: { estimateSec: null } });
});
