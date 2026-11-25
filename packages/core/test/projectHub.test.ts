import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchWire, type Backend } from '../src/backend';
import { OcsClient, OcsError } from '../src/ocs';
import { normalizeServerUrl } from '../src/serverUrl';
import { canWriteTaskComment, projectWritePermissions, workhubApi } from '../src/workhub';
import { json, ocs, scriptedFetch } from './helpers';

const client = (fetch: ReturnType<typeof scriptedFetch>) => new OcsClient({
  serverBase: normalizeServerUrl('https://example.com/nc'), getCredentials: async () => ({ loginName: 'a', appPassword: 'b' }), fetch,
});

test('project hub uses cross-project assignments and optional attention badges independently', async () => {
  const assignments = {
    boards: [{ id: 7, title: 'A', color: 'ffffff' }, { id: 9, title: 'B', color: '000000' }],
    tasks: [7, 9].map((boardId) => ({ id: boardId + 2, boardId, title: 'Task', dueDate: null, done: null, priority: 'high' })), truncated: true,
  };
  const summary = { overdue: 3, overdueByProject: { 7: 3 }, approvals: { requests: 1, timesheets: 2, total: 3 }, total: 6 };
  const f = scriptedFetch(
    json(200, ocs(assignments)),
    json(200, ocs(summary)),
    json(503, ocs({ error: 'BRIDGE_DEGRADED' }, 503, 'failure')),
    json(200, ocs({ projects: [{ id: 7, reviewer: true, edit: false }] })),
    json(200, ocs({ ...summary, overdueByProject: [] })),
  );
  const c = client(f);
  assert.deepEqual(await workhubApi.assignedTasks(c, 'all'), assignments);
  assert.deepEqual(await workhubApi.badges(c, false), summary);
  await assert.rejects(workhubApi.badges(c, true), (e) => e instanceof OcsError && e.errorCode === 'BRIDGE_DEGRADED');
  assert.equal((await workhubApi.projects(c))[0]?.reviewer, true);
  await assert.rejects(workhubApi.badges(c, false), (e) => e instanceof OcsError && e.kind === 'server');
  const base = '/nc/ocs/v2.php/apps/workhub/api/v1';
  assert.deepEqual(f.calls.map(({url}) => new URL(url).pathname), [base + '/assignments', base + '/badges', base + '/badges', base + '/projects', base + '/badges']);
  const query = (i: number) => new URL(f.calls[i]!.url).searchParams;
  assert.equal(query(0).get('status'), 'all');
  assert.equal(query(0).has('members'), false, 'server defaults to the viewer');
  assert.equal(query(1).has('fresh'), false);
  assert.equal(query(2).get('fresh'), '1');
});

test('reviewer-readable projects never confer writes; direct grants remain independent', () => {
  const permissions = { read: true, edit: true, manage: true, share: true };
  const denied = { edit: false, manage: false, share: false };
  assert.deepEqual(projectWritePermissions({ reviewer: true, permissions }), denied);
  assert.deepEqual(projectWritePermissions({ permissions: { ...permissions, read: false } }), denied);
  assert.deepEqual(projectWritePermissions(), denied);
  assert.equal(canWriteTaskComment({ permissions: { ...permissions, edit: false } }, {}), true);
  assert.equal(canWriteTaskComment({ permissions }, { canComment: false }), false);
  assert.equal(canWriteTaskComment(undefined, { canComment: true }), false);
  assert.deepEqual(projectWritePermissions({ permissions: { ...permissions, edit: false, share: false } }), { ...denied, manage: true });
});

test('personal project, column ordering and direct shares use Workhub endpoints', async () => {
  const rights = { edit: true, share: false, manage: false };
  const shares = { owner: null, shares: [{ id: 6, type: 'group', participant: 'team', displayName: 'Team', ...rights }] };
  const f = scriptedFetch(...[{ id: 5 }, shares, { id: 6 }, { id: 6, deleted: true }, { stacks: [] }].map((data) => json(200, ocs(data))));
  const c = client(f);
  assert.deepEqual(await workhubApi.personalProject(c), { id: 5 });
  assert.deepEqual(await workhubApi.projectMembers(c, 5), shares);
  await workhubApi.updateProjectMember(c, 5, 6, rights);
  await workhubApi.removeProjectMember(c, 5, 6);
  await workhubApi.reorderProjectStacks(c, 5, [8, 7]);
  assert.deepEqual(f.calls.map(({url, init}) => [init.method, new URL(url).pathname.split('/api/v1')[1]]), [
    ['POST', '/projects/personal'], ['GET', '/projects/5/members'], ['PATCH', '/projects/5/members/6'], ['DELETE', '/projects/5/members/6'], ['PUT', '/projects/5/stacks/order'],
  ]);
  assert.deepEqual(JSON.parse(String(f.calls[2]!.init.body)), rights);
  assert.deepEqual(JSON.parse(String(f.calls[4]!.init.body)), { stackIds: [8, 7] });
});

test('project hub IPC accepts only typed, scoped calls', async () => {
  const cases = [
    ['assignedTasks', ['acc', 'done'], ['acc', 'archived']],
    ['timeSubmission', ['acc', 5], ['acc', 0]],
    ['workhubBadges', ['acc', true], ['acc', 1]],
    ['personalProject', ['acc'], ['acc', 'other']],
    ['projectMembers', ['acc', 5], ['acc', -5]],
    ['updateProjectMember', ['acc', 5, 7, { edit: true, share: false, manage: false }], ['acc', 5, 7, { edit: true, share: false, manage: false, extra: true }]],
    ['removeProjectMember', ['acc', 5, 7], ['acc', 5, '7']],
    ['reorderProjectStacks', ['acc', 5, [7, 8]], ['acc', 5, [7, 7]]],
  ] as const;
  const backend = Object.fromEntries(cases.map(([key]) => [key, (...args: unknown[]) => args])) as unknown as Backend;
  for (const [method, valid, invalid] of cases) {
    assert.deepEqual(await dispatchWire(backend, method, [...valid]), { ok: true, value: valid });
    assert.deepEqual(await dispatchWire(backend, method, [...invalid]), { ok: false, error: { kind: 'client', message: 'invalid arguments' } });
  }
});
