/**
 * Live smoke for native project management + object shares (GENE-61): project create (idempotent),
 * rename, column create/rename, member add (user + group, duplicate → 409), principal search,
 * goal shares GET/PUT, and the permission matrix (edit-only member B, Projects-disabled C).
 * Not part of `npm test`. Run: `npm run smoke:projects -w @workhub-devices/core` with
 *   WH_SERVER, WH_ALLOW_HTTP=1 (local dev only), WH_A_USER/WH_A_PASS (creator),
 *   WH_B_USER/WH_B_PASS (added as edit-only member), WH_C_USER/WH_C_PASS (no Projects module).
 * Optional WH_GROUP (default `staff`). Uses the same `workhubApi` the Backend uses.
 * Prints no secrets. The project it creates stays (there is no project delete API); the goal is deleted.
 */
import assert from 'node:assert/strict';
import { OcsClient, OcsError, goalsApi, normalizeServerUrl, nextStackOrder, upsertShare, workhubApi, type ServerBase } from '../src/index';

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
const GROUP = process.env.WH_GROUP ?? 'staff';
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
  const stamp = new Date().toISOString();
  let boardId = 0;
  let stackId = 0;
  let goalId = 0;

  await step('create project (same Idempotency-Key twice → one project, default columns)', async () => {
    const key = crypto.randomUUID();
    const p1 = await workhubApi.createProject(A, `GENE-61 smoke ${stamp}`, '#336699', key);
    const p2 = await workhubApi.createProject(A, `GENE-61 smoke ${stamp}`, '#336699', key);
    boardId = p1!.id;
    assert.equal(p2!.id, boardId, 'idempotent retry created a second project');
    const mine = (await workhubApi.projects(A)).find((p) => p.id === boardId);
    assert.ok(mine?.manage && mine.share, 'creator must get manage + share');
    const board = await workhubApi.board(A, boardId);
    assert.deepEqual(board.project.stacks.map((s) => s.isDone), [false, false, true]);
    return `boardId=${boardId}, color=${p1!.color}, columns=${board.project.stacks.map((s) => s.title).join('/')}`;
  });

  await step('rename project (manage)', async () => {
    await workhubApi.renameProject(A, boardId, `GENE-61 smoke renamed ${stamp.slice(11, 19)}`);
    const board = await workhubApi.board(A, boardId);
    assert.ok(board.project.board.title.startsWith('GENE-61 smoke renamed'));
    assert.equal(await code(workhubApi.renameProject(A, boardId, 'x'.repeat(101))), 'client:', 'client guard must stop >100 chars before the request');
  });

  await step('column: create at the end, rename', async () => {
    const before = (await workhubApi.board(A, boardId)).project.stacks;
    const order = nextStackOrder(before);
    const st = await workhubApi.createStack(A, boardId, 'İnceleme', order);
    stackId = st!.id;
    assert.equal(st!.order, order);
    await workhubApi.renameStack(A, stackId, 'QA');
    const after = (await workhubApi.board(A, boardId)).project.stacks;
    assert.equal(after.length, before.length + 1);
    assert.equal(after.find((s) => s.id === stackId)?.title, 'QA');
    return `stackId=${stackId}, order=${order}`;
  });

  await step('principals: user and group search; empty query sends nothing', async () => {
    const users = await workhubApi.principals(A, env('WH_B_USER'));
    assert.ok(users.some((p) => p.principalType === 'user' && p.principalId === env('WH_B_USER')));
    const groups = await workhubApi.principals(A, GROUP);
    assert.ok(groups.some((p) => p.principalType === 'group' && p.principalId === GROUP));
    assert.deepEqual(await workhubApi.principals(A, '  '), []);
    return `user hits=${users.length}, group hits=${groups.length}`;
  });

  await step('members: add user B (edit only) + group; duplicate → 409; B sees the project', async () => {
    await workhubApi.addProjectMember(A, boardId, { type: 'user', participant: env('WH_B_USER'), edit: true, share: false, manage: false });
    await workhubApi.addProjectMember(A, boardId, { type: 'group', participant: GROUP, edit: false, share: false, manage: false });
    assert.equal(await code(workhubApi.addProjectMember(A, boardId, { type: 'user', participant: env('WH_B_USER'), edit: true, share: false, manage: false })), 'conflict:PROJECT_MEMBER_EXISTS');
    assert.equal(await code(workhubApi.addProjectMember(A, boardId, { type: 'user', participant: 'no-such-user-gene61', edit: false, share: false, manage: false })), 'client:INVALID_VALUE');
    const b = (await workhubApi.projects(B)).find((p) => p.id === boardId);
    assert.ok(b, 'B must see the project');
    assert.deepEqual([b.edit, b.manage, b.share], [true, false, false]);
    const members = (await workhubApi.board(A, boardId)).project.members.map((m) => m.uid);
    assert.ok(members.includes(env('WH_B_USER')));
    return `members=${members.join(',')}`;
  });

  await step('edit-only member B: rename/column/member writes → 403', async () => {
    assert.equal(await code(workhubApi.renameProject(B, boardId, 'B')), 'forbidden:ACTION_FORBIDDEN');
    assert.equal(await code(workhubApi.createStack(B, boardId, 'B', 9)), 'forbidden:ACTION_FORBIDDEN');
    assert.equal(await code(workhubApi.renameStack(B, stackId, 'B')), 'forbidden:ACTION_FORBIDDEN');
    assert.equal(await code(workhubApi.addProjectMember(B, boardId, { type: 'user', participant: env('WH_C_USER'), edit: false, share: false, manage: false })), 'forbidden:ACTION_FORBIDDEN');
  });

  await step('Projects-disabled C: create/rename → PROJECTS_DISABLED', async () => {
    assert.equal(await code(workhubApi.createProject(C, 'nope', undefined)), 'forbidden:PROJECTS_DISABLED');
    assert.equal(await code(workhubApi.renameProject(C, boardId, 'nope')), 'forbidden:PROJECTS_DISABLED');
  });

  await step('goal shares: empty → set user+group → B reads role → B cannot manage → invalid user 422', async () => {
    goalId = (await A.request<{ id: number }>(`${WH}/goals`, { method: 'POST', body: { title: `GENE-61 share smoke ${stamp}` } })).data!.id;
    const initial = await workhubApi.objectShares(A, 'goal', goalId);
    assert.equal(initial.owner.uid, env('WH_A_USER'));
    assert.deepEqual(initial.shares, []);
    let list = upsertShare([], { principalType: 'user', principalId: env('WH_B_USER'), displayName: '' }, 'view');
    list = upsertShare(list, { principalType: 'group', principalId: GROUP, displayName: GROUP }, 'edit');
    const saved = await workhubApi.setObjectShares(A, 'goal', goalId, list);
    assert.deepEqual(saved!.shares.map((s) => `${s.principalType}:${s.principalId}=${s.role}`).sort(), [`group:${GROUP}=edit`, `user:${env('WH_B_USER')}=view`].sort());
    const bGoal = (await goalsApi.list(B)).find((g) => g.id === goalId);
    assert.ok(bGoal, 'B must see the shared goal');
    assert.equal(bGoal.canManage, false);
    assert.equal(await code(workhubApi.objectShares(B, 'goal', goalId)), 'forbidden:ACTION_FORBIDDEN');
    assert.equal(await code(workhubApi.setObjectShares(B, 'goal', goalId, [])), 'forbidden:ACTION_FORBIDDEN');
    assert.equal(await code(workhubApi.setObjectShares(A, 'goal', goalId, [{ principalType: 'user', principalId: 'no-such-user-gene61', role: 'view' }])), 'client:INVALID_SHARE');
    // Owner in the list is ignored by the server (owner is implicit).
    const withOwner = await workhubApi.setObjectShares(A, 'goal', goalId, [{ principalType: 'user', principalId: env('WH_A_USER'), role: 'view' }]);
    assert.deepEqual(withOwner!.shares, []);
    return `B role=${bGoal.role}`;
  });

  await step('cleanup: delete goal', async () => {
    if (!goalId) return 'nothing to delete';
    const g = await A.get<{ version: number }>(`${WH}/goals/${goalId}`);
    await A.request(`${WH}/goals/${goalId}`, { method: 'DELETE', body: { version: g.version } });
    return `project ${boardId} kept (no delete API)`;
  });

  console.log(`server: ${base}\n`);
  for (const [n, r] of results) console.log(`${r.startsWith('PASS') ? '✔' : '✘'} ${n}: ${r}`);
  if (results.some(([, r]) => r.startsWith('FAIL'))) process.exitCode = 1;
}

main().catch((e) => {
  console.error('smoke aborted:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
