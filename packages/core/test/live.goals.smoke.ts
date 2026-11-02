/**
 * Live smoke for the native Goals slice (GENE-52): goal create/edit/archive/delete with the
 * goal `version`, number/currency/boolean/task targets (CRUD, server decimal format), manual
 * check-ins (delta/absolute/boolean, Idempotency-Key replay, stale target → 409), history,
 * linking a card from the task side and unlinking it via the card set, ACL role gates
 * (view/edit shares, card readability) and ownership transfer.
 * Not part of `npm test`. Run: `npm run smoke:goals -w @workhub-devices/core` with
 *   WH_SERVER, WH_ALLOW_HTTP=1 (local dev only), WH_A_USER/WH_A_PASS (owner),
 *   WH_B_USER/WH_B_PASS (share target, then new owner), WH_C_USER/WH_C_PASS (outsider).
 * Creates one project + card per run (Workhub has no project delete API); the goal is deleted.
 * Prints no secrets.
 */
import assert from 'node:assert/strict';
import { OcsClient, OcsError, goalsApi, normalizeServerUrl, workhubApi, type GoalDetail, type ServerBase, type Task } from '../src/index';

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

async function main() {
  let goalId = 0;
  let cardId = 0;
  const ids = { num: 0, cur: 0, bool: 0, task: 0 };
  const detail = (c: OcsClient = A) => goalsApi.get(c, goalId);
  const target = (g: GoalDetail, id: number) => g.targets.find((t) => t.id === id)!;

  await step('goal: create, edit header with version, stale version → 409', async () => {
    const g = await goalsApi.create(A, { title: `GENE-52 smoke ${stamp}`, description: 'smoke', dueDate: '2026-12-31' });
    goalId = g!.id;
    assert.equal(g!.canManage, true);
    assert.equal(g!.progressState, 'not_calculable');
    const e = await goalsApi.update(A, goalId, { version: g!.version, title: `GENE-52 smoke ${stamp} ✓`, dueDate: null });
    assert.equal(e!.version, g!.version + 1);
    assert.equal(e!.dueDate, null);
    assert.equal(await code(goalsApi.update(A, goalId, { version: g!.version, title: 'x' })), 'conflict:VERSION_CONFLICT');
    assert.equal(await code(goalsApi.create(A, { title: 'x', dueDate: '2026-02-30' })), 'client:INVALID_DATE');
    return `goal ${goalId}`;
  });

  await step('targets: number/currency/boolean CRUD; empty range and wrong-type fields → 422', async () => {
    ids.num = (await goalsApi.addTarget(A, goalId, { type: 'number', title: 'Müşteri', start: '0', target: '20' }))!.id;
    const cur = await goalsApi.addTarget(A, goalId, { type: 'currency', title: 'Ciro', start: '0', target: '1000.5', currencyCode: 'TRY' });
    ids.cur = cur!.id;
    assert.equal(cur!.scale, 2);
    assert.equal(cur!.target, '1000.50');
    ids.bool = (await goalsApi.addTarget(A, goalId, { type: 'boolean', title: 'Lansman' }))!.id;
    assert.equal(await code(goalsApi.addTarget(A, goalId, { type: 'number', title: 'x', start: '5', target: '5' })), 'client:INVALID_TARGET_RANGE');
    assert.equal(await code(goalsApi.addTarget(A, goalId, { type: 'number', title: 'x', start: '0', target: '1', currencyCode: 'TRY' })), 'client:INVALID_FIELD');
    const u = await goalsApi.updateTarget(A, goalId, ids.cur, { version: cur!.version, title: 'Ciro (TL)', target: '2000' });
    assert.equal(u!.target, '2000.00');
    assert.equal(u!.version, cur!.version + 1);
    assert.equal(await code(goalsApi.updateTarget(A, goalId, ids.bool, { version: 1, target: '3' })), 'client:INVALID_FIELD');
    const tmp = await goalsApi.addTarget(A, goalId, { type: 'boolean', title: 'silinecek' });
    await goalsApi.removeTarget(A, goalId, tmp!.id, tmp!.version);
    assert.equal((await detail()).targets.length, 3);
  });

  await step('check-in: delta replay with same key applies once; absolute; boolean; stale → 409; history', async () => {
    let g = await detail();
    const v = target(g, ids.cur).version;
    const k = key();
    const first = await goalsApi.checkin(A, goalId, ids.cur, { version: v, mode: 'delta', value: '500.25', note: 'ilk' }, k);
    const again = await goalsApi.checkin(A, goalId, ids.cur, { version: v, mode: 'delta', value: '500.25', note: 'ilk' }, k);
    assert.equal(again!.checkin.id, first!.checkin.id);
    assert.equal(first!.target.current, '500.25');
    assert.equal(await code(goalsApi.checkin(A, goalId, ids.cur, { version: v, mode: 'absolute', value: '1' }, key())), 'conflict:VERSION_CONFLICT');
    await goalsApi.checkin(A, goalId, ids.num, { version: target(g, ids.num).version, mode: 'absolute', value: '5' }, key());
    await goalsApi.checkin(A, goalId, ids.bool, { version: target(g, ids.bool).version, value: true }, key());
    g = await detail();
    assert.equal(target(g, ids.cur).current, '500.25');
    assert.equal(target(g, ids.num).current, '5');
    assert.equal(target(g, ids.bool).booleanValue, true);
    const h = await goalsApi.checkins(A, goalId, ids.cur);
    assert.equal(h.length, 1, 'replay did not add a second check-in');
    assert.equal(h[0]!.note, 'ilk');
    assert.equal(await code(goalsApi.checkin(A, goalId, ids.cur, { version: first!.target.version, mode: 'delta', value: '1.234' }, key())), 'client:INVALID_DECIMAL');
    return `progress ${g.progressBp} bp`;
  });

  await step('card link from the task side: task target is created; card lists the goal; outsider → 404', async () => {
    const p = await workhubApi.createProject(A, `GENE-52 smoke ${stamp}`, undefined, key());
    const board = await workhubApi.board(A, p!.id);
    const r = await A.request<Task>(`/ocs/v2.php/apps/workhub/api/v1/projects/${p!.id}/tasks`, { method: 'POST', body: { stackId: board.project.stacks[0]!.id, title: 'GENE-52 bağlı kart' }, headers: { 'Idempotency-Key': key() } });
    cardId = r.data!.id;
    const g = await goalsApi.linkCard(A, cardId, goalId);
    const t = g!.targets.find((x) => x.type === 'task')!;
    ids.task = t.id;
    assert.deepEqual(t.cards!.map((c) => c.id), [cardId]);
    // Linking twice is a no-op.
    const again = await goalsApi.linkCard(A, cardId, goalId);
    assert.equal(again!.targets.find((x) => x.id === ids.task)!.cards!.length, 1);
    const linked = await goalsApi.cardGoals(A, cardId);
    assert.deepEqual(linked.map((x) => [x.id, x.linkedTargets.map((l) => l.id)]), [[goalId, [ids.task]]]);
    assert.equal(await code(goalsApi.cardGoals(C, cardId)), 'not_found:RESOURCE_NOT_FOUND');
    assert.equal(await code(goalsApi.checkin(A, goalId, ids.task, { version: t.version, value: true }, key())), 'client:TARGET_NOT_MANUAL');
    return `card ${cardId}`;
  });

  await step('role gates: view share cannot write; edit share can check in but not transfer/delete', async () => {
    await workhubApi.setObjectShares(A, 'goal', goalId, [{ principalType: 'user', principalId: env('WH_B_USER'), role: 'view' }]);
    const asB = await detail(B);
    assert.deepEqual([asB.role, asB.canEdit, asB.canManage], ['view', false, false]);
    assert.equal(await code(goalsApi.update(B, goalId, { version: asB.version, title: 'x' })), 'forbidden:ACTION_FORBIDDEN');
    assert.equal(await code(goalsApi.checkin(B, goalId, ids.num, { version: target(asB, ids.num).version, mode: 'delta', value: '1' }, key())), 'forbidden:ACTION_FORBIDDEN');
    await workhubApi.setObjectShares(A, 'goal', goalId, [{ principalType: 'user', principalId: env('WH_B_USER'), role: 'edit' }]);
    const asB2 = await detail(B);
    assert.equal(asB2.canEdit, true);
    const ci = await goalsApi.checkin(B, goalId, ids.num, { version: target(asB2, ids.num).version, mode: 'delta', value: '1' }, key());
    assert.equal(ci!.target.current, '6');
    assert.equal(await code(goalsApi.transfer(B, goalId, asB2.version, env('WH_B_USER'))), 'forbidden:ACTION_FORBIDDEN');
    assert.equal(await code(goalsApi.remove(B, goalId, asB2.version)), 'forbidden:ACTION_FORBIDDEN');
    // B cannot read A's project: the linked card is hidden from B and B cannot drop it from the set.
    const tb = target(asB2, ids.task);
    assert.equal((tb.cards ?? []).length, 0);
    assert.equal(await code(goalsApi.setCards(B, goalId, ids.task, tb.version, [])), 'client:CARDS_NOT_READABLE');
    // Re-linking a card that is already in the set is a server no-op (nothing disclosed: B's view still hides it).
    const relinked = await goalsApi.linkCard(B, cardId, goalId);
    assert.equal((relinked!.targets.find((x) => x.id === ids.task)!.cards ?? []).length, 0);
    // An outsider has no goal access at all.
    assert.equal(await code(goalsApi.linkCard(C, cardId, goalId)), 'not_found:RESOURCE_NOT_FOUND');
  });

  await step('unlink from the task side: card set without the card; card no longer lists the goal', async () => {
    const t = target(await detail(), ids.task);
    const out = await goalsApi.setCards(A, goalId, ids.task, t.version, (t.cards ?? []).map((c) => c.id).filter((id) => id !== cardId));
    assert.equal(out!.cards!.length, 0);
    assert.deepEqual(await goalsApi.cardGoals(A, cardId), []);
    assert.equal(await code(goalsApi.setCards(A, goalId, ids.task, t.version, [])), 'conflict:VERSION_CONFLICT');
  });

  await step('archive blocks target/check-in writes (409 GOAL_ARCHIVED); reactivate restores', async () => {
    let g = await detail();
    g = (await goalsApi.update(A, goalId, { version: g.version, state: 'archived' }))!;
    assert.equal(g.state, 'archived');
    assert.equal(await code(goalsApi.addTarget(A, goalId, { type: 'boolean', title: 'x' })), 'conflict:GOAL_ARCHIVED');
    assert.equal(await code(goalsApi.checkin(A, goalId, ids.bool, { version: target(g, ids.bool).version, value: false }, key())), 'conflict:GOAL_ARCHIVED');
    assert.ok((await goalsApi.list(A, { owner: 'me', state: 'archived' })).some((x) => x.id === goalId));
    g = (await goalsApi.update(A, goalId, { version: g.version, state: 'active' }))!;
    assert.equal(g.state, 'active');
  });

  await step('transfer: unknown/self owner → 422; A → B; A keeps manage; B now owns and may delete', async () => {
    let g = await detail();
    assert.equal(await code(goalsApi.transfer(A, goalId, g.version, 'no-such-user-gene52')), 'client:INVALID_OWNER');
    assert.equal(await code(goalsApi.transfer(A, goalId, g.version, env('WH_A_USER'))), 'client:INVALID_OWNER');
    assert.equal(await code(goalsApi.transfer(A, goalId, g.version + 9, env('WH_B_USER'))), 'conflict:VERSION_CONFLICT');
    g = (await goalsApi.transfer(A, goalId, g.version, env('WH_B_USER')))!;
    assert.equal(g.owner.uid, env('WH_B_USER'));
    const asA = await detail(A);
    assert.deepEqual([asA.role, asA.canManage], ['manage', true]);
    const asB = await detail(B);
    assert.deepEqual([asB.role, asB.canManage], ['manage', true]);
    assert.ok((await goalsApi.list(B, { owner: 'me', state: 'active' })).some((x) => x.id === goalId));
    assert.ok((await goalsApi.list(A, { owner: 'shared', state: 'active' })).some((x) => x.id === goalId));
  });

  await step('delete: stale version → 409; B deletes; goal is gone for both', async () => {
    const g = await detail(B);
    assert.equal(await code(goalsApi.remove(B, goalId, g.version - 1)), 'conflict:VERSION_CONFLICT');
    const out = await goalsApi.remove(B, goalId, g.version);
    assert.equal(out!.deleted, true);
    assert.equal(await code(detail(A)), 'not_found:RESOURCE_NOT_FOUND');
    assert.equal(await code(detail(B)), 'not_found:RESOURCE_NOT_FOUND');
  });

  for (const [n, r] of results) console.log(`${r.startsWith('PASS') ? '✔' : '✖'} ${n}: ${r}`);
  const failed = results.filter(([, r]) => !r.startsWith('PASS')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

void main();
