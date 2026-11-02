import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectBackend, dispatchWire, isValidCheckin, isValidGoalPatch, isValidTargetInput, isValidTargetPatch, type PlainStore } from '../src/backend';
import type { SecretStore } from '../src/accounts';
import { OcsClient, OcsError } from '../src/ocs';
import { cardSetWithout, goalActions, goalPercent, goalsApi, normalizeGoalDecimal, type GoalDetail, type GoalTarget } from '../src/workhub';
import { headerOf, json, ocs, scriptedFetch, type Call } from './helpers';

class Mem implements SecretStore, PlainStore {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
  async deletePrefix(p: string) { for (const k of [...this.m.keys()]) if (k.startsWith(p)) this.m.delete(k); }
}

const KEY = '0f8b6c1e-3a52-4c9e-9a51-2b1c0d7e8f90';
const BAD = { ok: false, error: { kind: 'client', message: 'invalid arguments' } };
const bootstrap = (goals: boolean) => json(200, ocs({ apiVersion: '1', modules: { goals }, permissions: { canViewTeamReport: false } }));

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

const taskTarget = (over: Partial<GoalTarget> = {}): GoalTarget => ({
  id: 3, goalId: 11, type: 'task', title: 'Deck cards', version: 4, weight: 1, progressBp: 0, state: 'ok', scopeMode: 'frozen', doneCount: 0, totalCount: 2, missingCount: null,
  cards: [
    { id: 4, title: 'A', boardId: 1, boardTitle: 'P', stackTitle: 'To Do', done: null, archived: false, url: '' },
    { id: 9, title: 'B', boardId: 1, boardTitle: 'P', stackTitle: 'To Do', done: null, archived: false, url: '' },
  ],
  ...over,
});
const goal = (over: Partial<GoalDetail> = {}): GoalDetail => ({
  id: 11, title: 'Q4', dueDate: null, state: 'active', owner: { uid: 'ali', displayName: 'Ali' }, role: 'manage', canEdit: true, canManage: true, version: 2,
  updatedAt: '2026-11-02T18:00:00Z', progressBp: 4167, progressState: 'ok', stateNote: null, calculatedAt: null, description: '', zone: 'UTC', createdAt: '2026-11-02T18:00:00Z',
  targets: [
    { id: 1, goalId: 11, type: 'currency', title: 'Ciro', version: 2, weight: 1, progressBp: 2501, state: 'ok', scale: 2, currencyCode: 'TRY', start: '0.00', target: '1000.50', current: '250.25' },
    { id: 2, goalId: 11, type: 'boolean', title: 'Lansman', version: 1, weight: 1, progressBp: 0, state: 'ok', booleanValue: false },
    taskTarget(),
  ],
  ...over,
});

test('decimal normalization follows the server format (comma allowed, scale enforced)', () => {
  assert.equal(normalizeGoalDecimal('1250,50', 2), '1250.5');
  assert.equal(normalizeGoalDecimal(' -3 ', 0), '-3');
  assert.equal(normalizeGoalDecimal('10.000', 0), '10', 'trailing zeros are not extra precision');
  assert.equal(normalizeGoalDecimal('1.25', 1), null, 'too many fraction digits');
  assert.equal(normalizeGoalDecimal('1.2345', 9), '1.2345', 'scale clamped to server max 4');
  assert.equal(normalizeGoalDecimal('1.23456', 9), null);
  for (const bad of ['', '1e3', '1.250,5', '+1', '1 000', 'abc', '.5']) assert.equal(normalizeGoalDecimal(bad, 2), null, bad);
  assert.equal(goalPercent(4167), 42);
  assert.equal(goalPercent(null), null);
});

test('goal actions come only from server role flags and lifecycle', () => {
  const owner = goalActions({ canEdit: true, canManage: true, state: 'active' });
  assert.equal(owner.targets && owner.checkin && owner.linkCards && owner.transfer && owner.remove && owner.archive, true);
  assert.equal(owner.reactivate, false);
  const archived = goalActions({ canEdit: true, canManage: true, state: 'archived' });
  assert.deepEqual([archived.targets, archived.checkin, archived.linkCards, archived.archive, archived.reactivate], [false, false, false, false, true]);
  const editor = goalActions({ canEdit: true, canManage: false, state: 'active' });
  assert.deepEqual([editor.targets, editor.transfer, editor.remove, editor.share], [true, false, false, false]);
  const viewer = goalActions({ canEdit: false, canManage: false, state: 'active' });
  assert.ok(Object.values(viewer).every((v) => v === false), 'viewer gets nothing');
  assert.deepEqual(cardSetWithout(taskTarget(), 4), [9]);
});

test('goals API: paths, bodies, Idempotency-Key on check-in', async () => {
  const g = ocs(goal());
  const t = ocs(taskTarget());
  const f = scriptedFetch(
    json(200, ocs({ items: [] })), json(200, g), json(201, g), json(200, g), json(200, ocs({ id: 11, deleted: true })), json(200, g),
    json(201, t), json(200, t), json(200, ocs({ id: 3, deleted: true })), json(201, ocs({ checkin: {}, target: {} })), json(200, ocs({ items: [] })),
    json(200, t), json(200, ocs({ items: [] })), json(200, g),
  );
  const c = new OcsClient({ serverBase: 'https://ex.com' as never, getCredentials: async () => ({ loginName: 'u', appPassword: 'p' }), fetch: f });
  await goalsApi.list(c, { owner: 'me', state: 'archived' });
  await goalsApi.get(c, 11);
  await goalsApi.create(c, { title: 'Q4', dueDate: '2026-12-31' });
  await goalsApi.update(c, 11, { version: 2, state: 'archived' });
  await goalsApi.remove(c, 11, 3);
  await goalsApi.transfer(c, 11, 2, 'bob');
  await goalsApi.addTarget(c, 11, { type: 'currency', title: 'Ciro', start: '0', target: '1000.5', currencyCode: 'TRY' });
  await goalsApi.updateTarget(c, 11, 1, { version: 2, target: '2000' });
  await goalsApi.removeTarget(c, 11, 1, 3);
  await goalsApi.checkin(c, 11, 1, { version: 2, mode: 'delta', value: '10', note: 'n' }, KEY);
  await goalsApi.checkins(c, 11, 1);
  await goalsApi.setCards(c, 11, 3, 4, [9]);
  await goalsApi.cardGoals(c, 4);
  await goalsApi.linkCard(c, 4, 11);
  const W = 'https://ex.com/ocs/v2.php/apps/workhub/api/v1';
  assert.deepEqual(f.calls.map((x) => `${x.init.method} ${x.url.replace(W, '').replace('?format=json&', '?').replace('?format=json', '')}`), [
    'GET /goals?owner=me&state=archived', 'GET /goals/11', 'POST /goals', 'PATCH /goals/11', 'DELETE /goals/11', 'POST /goals/11/transfer',
    'POST /goals/11/targets', 'PATCH /goals/11/targets/1', 'DELETE /goals/11/targets/1', 'POST /goals/11/targets/1/checkins', 'GET /goals/11/targets/1/checkins',
    'PUT /goals/11/targets/3/cards', 'GET /cards/4/goals', 'POST /cards/4/goals',
  ]);
  const body = (i: number) => JSON.parse(String(f.calls[i]!.init.body));
  assert.deepEqual(body(4), { version: 3 });
  assert.deepEqual(body(5), { version: 2, newOwnerUid: 'bob' });
  assert.deepEqual(body(9), { version: 2, mode: 'delta', value: '10', note: 'n' });
  assert.equal(headerOf(f.calls[9], 'Idempotency-Key'), KEY);
  assert.deepEqual(body(11), { version: 4, cardIds: [9] });
  assert.deepEqual(body(13), { goalId: 11 });
  await assert.rejects(goalsApi.setCards(c, 11, 3, 4, [0]), (e: unknown) => e instanceof OcsError && e.kind === 'client');
});

test('backend gate: goals module off → 403 before any goal call', async () => {
  const { b, f, id } = await loggedIn(bootstrap(false));
  await assert.rejects(b.goals(id), (e: unknown) => e instanceof OcsError && e.errorCode === 'GOALS_DISABLED');
  await assert.rejects(b.cardGoals(id, 4), (e: unknown) => e instanceof OcsError && e.errorCode === 'GOALS_DISABLED');
  assert.equal(f.calls.length, 3, 'only login + bootstrap (cached)');
});

test('backend role gate: manage/edit/archived checked on a FRESH detail; writes never sent when refused', async () => {
  const editor = goal({ role: 'edit', canManage: false });
  const { b, f, id } = await loggedIn(
    bootstrap(true),
    json(200, ocs(editor)), // transfer → refused
    json(200, ocs(editor)), // delete → refused
    json(200, ocs(goal({ role: 'view', canEdit: false, canManage: false }))), // check-in → refused
    json(200, ocs(goal({ state: 'archived' }))), // add target → archived
    json(200, ocs(goal({ state: 'archived' }))), // reactivate → allowed on archived
    json(200, ocs(goal())),
    json(200, ocs(goal())), // check-in on task target → refused locally
  );
  await assert.rejects(b.goalTransfer(id, 11, 2, 'bob'), (e: unknown) => e instanceof OcsError && e.errorCode === 'GOAL_MANAGE_REQUIRED');
  await assert.rejects(b.goalDelete(id, 11, 2), (e: unknown) => e instanceof OcsError && e.errorCode === 'GOAL_MANAGE_REQUIRED');
  await assert.rejects(b.goalCheckin(id, 11, 1, { version: 2, mode: 'delta', value: '1' }, KEY), (e: unknown) => e instanceof OcsError && e.errorCode === 'GOAL_EDIT_REQUIRED');
  await assert.rejects(b.goalTargetAdd(id, 11, { type: 'boolean', title: 'x' }), (e: unknown) => e instanceof OcsError && e.errorCode === 'GOAL_ARCHIVED');
  const re = await b.goalUpdate(id, 11, { version: 2, state: 'active' });
  assert.equal(re?.id, 11);
  await assert.rejects(b.goalCheckin(id, 11, 3, { version: 4, value: true }, KEY), (e: unknown) => e instanceof OcsError && e.errorCode === 'TARGET_NOT_MANUAL');
  const writes = f.calls.filter((x) => x.init.method !== 'GET').map((x) => `${x.init.method} ${x.url.replace(/^.*\/api\/v1/, '').replace(/\?.*$/, '')}`);
  assert.deepEqual(writes.slice(2), ['PATCH /goals/11'], 'only the allowed write reached the server');
});

test('unlink a card: uses the task target\'s current version and removes only that card', async () => {
  const { b, f, id } = await loggedIn(bootstrap(true), json(200, ocs(goal())), json(200, ocs(taskTarget({ version: 5, cards: [] }))), json(200, ocs(goal())));
  await b.cardUnlinkGoal(id, 4, 11, 3);
  const put = f.calls.at(-1)!;
  assert.match(put.url, /\/goals\/11\/targets\/3\/cards/);
  assert.equal(put.init.method, 'PUT');
  assert.deepEqual(JSON.parse(String(put.init.body)), { version: 4, cardIds: [9] });
  await assert.rejects(b.cardUnlinkGoal(id, 77, 11, 3), (e: unknown) => e instanceof OcsError && e.kind === 'not_found', 'card not in the set');
});

test('IPC validation: goal inputs are exact, typed and server-shaped', async () => {
  const b = createDirectBackend({ secrets: new Mem(), plain: new Mem(), fetch: scriptedFetch() });
  assert.equal(isValidTargetInput({ type: 'currency', title: 'Ciro', start: '0', target: '10.5', currencyCode: 'TRY' }), true);
  assert.equal(isValidTargetInput({ type: 'currency', title: 'Ciro', start: '0', target: '10.5' }), false, 'currency needs a code');
  assert.equal(isValidTargetInput({ type: 'number', title: 'N', start: '0', target: '5', currencyCode: 'TRY' }), false, 'code only on currency');
  assert.equal(isValidTargetInput({ type: 'number', title: 'N', start: '5', target: '5' }), false, 'empty range');
  assert.equal(isValidTargetInput({ type: 'number', title: 'N', start: '0', target: '1e3' }), false);
  assert.equal(isValidTargetInput({ type: 'number', title: 'N', start: '0', target: '5', scale: 5 }), false);
  assert.equal(isValidTargetInput({ type: 'boolean', title: 'B', start: '0' }), false);
  assert.equal(isValidTargetInput({ type: 'task', title: 'T' }), true);
  assert.equal(isValidTargetInput({ type: 'formula', title: 'T' }), false);
  assert.equal(isValidTargetPatch({ version: 1 }), false, 'nothing to change');
  assert.equal(isValidTargetPatch({ version: 1, weight: 2 }), false, 'weight is not editable');
  assert.equal(isValidGoalPatch({ version: 1, state: 'deleted' }), false);
  assert.equal(isValidGoalPatch({ version: 1, dueDate: null }), true);
  assert.equal(isValidGoalPatch({ version: 1, owner: 'x' }), false, 'owner changes only via transfer');
  assert.equal(isValidCheckin({ version: 1, value: true }), true);
  assert.equal(isValidCheckin({ version: 1, mode: 'delta', value: true }), false, 'boolean takes no mode');
  assert.equal(isValidCheckin({ version: 1, mode: 'delta', value: 3 }), false, 'decimals travel as strings');
  assert.equal(isValidCheckin({ version: 1, mode: 'replace', value: '3' }), false);
  assert.deepEqual(await dispatchWire(b, 'goalSetCards', ['acc', 11, 3, 4, [9, 9]]), BAD, 'duplicate ids');
  assert.deepEqual(await dispatchWire(b, 'goalCheckin', ['acc', 11, 1, { version: 1, value: true }, 'not a key']), BAD);
  assert.deepEqual(await dispatchWire(b, 'goalTransfer', ['acc', 11, 1, ' ']), BAD);
  assert.deepEqual(await dispatchWire(b, 'goals', ['acc', { owner: 'everyone', state: 'any' }]), BAD);
  assert.deepEqual(await dispatchWire(b, 'goalCreate', ['acc', { title: ' ' }]), BAD);
  assert.deepEqual(await dispatchWire(b, 'cardUnlinkGoal', ['acc', 4, 11]), BAD);
  const ok = await dispatchWire(b, 'goalCreate', ['acc', { title: 'Q4', dueDate: '2026-12-31' }]);
  assert.equal(ok.ok === false && ok.error.kind, 'unauthorized');
});
