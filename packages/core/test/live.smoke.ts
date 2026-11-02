/**
 * Live smoke test against a real Nextcloud + Talk + Notifications + Workhub server.
 * Not part of `npm test`. Run: `npm run smoke:live -w @workhub-devices/core` with
 *   WH_SERVER, WH_ALLOW_HTTP=1 (local dev only),
 *   WH_A_USER/WH_A_PASS (project member), WH_B_USER/WH_B_PASS (assignee),
 *   WH_C_USER/WH_C_PASS (user without the Projects module), WH_A_REVOKE_PASS (throw-away app password).
 * Passwords must be app passwords. Nothing secret or any message body is printed.
 * Uses no cookies and no requesttoken: proves OCS app-password auth incl. CSRF behaviour for writes.
 */
import assert from 'node:assert/strict';
import {
  OcsClient, OcsError, normalizeServerUrl, startLoginFlow, pollLoginFlow, LoginFlowError, fetchServerCapabilities,
  checkCompatibility, fetchWorkhubBootstrap, listRooms, fetchChat, sendMessage, newReferenceId, mergeTimeline,
  listNotifications, routeForObject, parseServerLink, openTaskFromNotification, workhubApi, addAccount, logout,
  createAccountClient, type SecretStore, type ServerBase, type TalkRoom, type TalkMessage, type InboxNotification,
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
const findNotification = async (c: OcsClient, pred: (n: InboxNotification) => boolean, tries = 10) => {
  for (let i = 0; i < tries; i++) {
    const { items } = await listNotifications(c);
    const hit = items?.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return undefined;
};

async function main() {
  let matrix = '';
  await step('capabilities + compatibility', async () => {
    const caps = await fetchServerCapabilities(A);
    const issues = checkCompatibility(caps);
    matrix = `Nextcloud ${caps.nextcloudVersion}, Talk ${caps.talk.version}, Workhub ${caps.workhub.version} (api ${caps.workhub.apiVersion}), notifications push=[${[...caps.notifications.push].join(',')}]`;
    assert.deepEqual(issues, []);
    return matrix;
  });

  await step('login flow v2: start + validated endpoints + pending poll', async () => {
    const s = await startLoginFlow(base);
    const r = await pollLoginFlow(base, s, { maxDurationMs: 1500, intervalMs: 500 }).then(() => 'granted?', (e) => (e as LoginFlowError).code);
    assert.equal(r, 'expired'); // nobody approved in a browser: server answers 404 until timeout
  });

  await step('workhub per-user gate (member vs restricted)', async () => {
    const a = await fetchWorkhubBootstrap(A);
    const c = await fetchWorkhubBootstrap(C);
    assert.equal(a.modules.projects, true);
    assert.equal(c.modules.projects, false);
    return `backend=${a.backend}`;
  });

  // ---- Talk -----------------------------------------------------------------
  let room: TalkRoom | undefined;
  await step('talk: open 1:1 room A→B', async () => {
    const r = await A.request<TalkRoom>('/ocs/v2.php/apps/spreed/api/v4/room', { method: 'POST', body: { roomType: 1, invite: env('WH_B_USER') } });
    room = r.data ?? undefined;
    assert.ok(room?.token);
  });

  await step('talk: send with referenceId, B receives via history, no duplicate, read marker untouched', async () => {
    const ref = newReferenceId();
    const sent = await sendMessage(A, room!.token, { message: 'GENE-48 smoke', referenceId: ref });
    assert.equal(sent?.referenceId, ref);
    const hist = await fetchChat(B, room!.token, { lookIntoFuture: false, limit: 20 });
    const t = mergeTimeline([{ kind: 'pending', referenceId: ref, text: 'x', state: 'unknown', createdAt: 0 }], [...hist.messages, ...hist.messages]);
    assert.equal(t.filter((i) => i.kind === 'server' && i.message.referenceId === ref).length, 1);
    assert.ok(t.every((i) => i.kind === 'server'));
    // 1:1 rooms appear in the other participant's list once they have a message
    const { rooms } = await listRooms(B);
    const r = rooms.find((x) => x.token === room!.token);
    assert.ok(r, 'room missing from B list');
    assert.ok(r.unreadMessages > 0, 'passive fetch must not mark read');
  });

  await step('talk: long-poll delivers new message to B', async () => {
    const hist = await fetchChat(B, room!.token, { lookIntoFuture: false, limit: 1 });
    const last = hist.messages[0]?.id;
    const poll = fetchChat(B, room!.token, { lookIntoFuture: true, timeout: 20, ...(last ? { lastKnownMessageId: last } : {}) });
    await new Promise((r) => setTimeout(r, 1000));
    const ref = newReferenceId();
    await sendMessage(A, room!.token, { message: 'GENE-48 long-poll', referenceId: ref });
    const got = await poll;
    assert.ok(got.messages.some((m: TalkMessage) => m.referenceId === ref));
  });

  await step('talk: B gets a spreed notification routed to the room', async () => {
    const n = await findNotification(B, (x) => x.app === 'spreed' && x.objectId.startsWith(room!.token));
    assert.ok(n, 'no spreed notification');
    const route = routeForObject(n.app, n.objectType, n.objectId, n.id);
    assert.equal(route.name === 'room' && route.token, room!.token);
    return `object_type=${n.objectType}`;
  });

  // ---- Workhub (reversible writes, no cookie / requesttoken) ----------------
  let boardId = 0;
  let stackId = 0;
  let cardId = 0;
  await step('workhub write: create project + add B as member (Idempotency-Key)', async () => {
    const key = crypto.randomUUID();
    const body = { title: `GENE-48 smoke ${new Date().toISOString()}` };
    const p = await A.request<{ id: number }>(`${WH}/projects`, { method: 'POST', body, headers: { 'Idempotency-Key': key } });
    boardId = p.data!.id;
    // a lost-response retry must resend the identical body with the same key
    const again = await A.request<{ id: number }>(`${WH}/projects`, { method: 'POST', body, headers: { 'Idempotency-Key': key } });
    assert.equal(again.data!.id, boardId, 'idempotent replay returned another project');
    const reused = await A.request(`${WH}/projects`, { method: 'POST', body: { title: 'other' }, headers: { 'Idempotency-Key': key } }).then(() => 'ok', (e) => (e as OcsError).errorCode);
    assert.equal(reused, 'IDEMPOTENCY_KEY_REUSED');
    await A.request(`${WH}/projects/${boardId}/members`, { method: 'POST', body: { type: 'user', participant: env('WH_B_USER'), edit: true, share: false, manage: false }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
    const board = await workhubApi.board(A, boardId);
    stackId = board.project.stacks[0]!.id;
    return `boardId=${boardId}, stacks=${board.project.stacks.length}`;
  });

  await step('workhub write: create task assigned to B, PATCH, read back', async () => {
    const t = await A.request<{ id: number; url: string }>(`${WH}/projects/${boardId}/tasks`, {
      method: 'POST', body: { stackId, title: 'GENE-48 smoke task', assignees: [env('WH_B_USER')], priority: 'normal' }, headers: { 'Idempotency-Key': crypto.randomUUID() },
    });
    cardId = t.data!.id;
    await workhubApi.updateTask(A, cardId, { title: 'GENE-48 smoke task (patched)' });
    const read = await workhubApi.task(A, cardId);
    assert.equal(read.title, 'GENE-48 smoke task (patched)');
    assert.deepEqual(read.assignees.map((x) => x.id), [env('WH_B_USER')]);
    assert.equal(parseServerLink(base, read.url)?.name, 'task');
    return `cardId=${cardId}`;
  });

  let assignment: InboxNotification | undefined;
  await step('workhub: normal assignment notification → task route (not a Talk message)', async () => {
    assignment = await findNotification(B, (x) => x.app === 'workhub' && x.objectType === 'card' && x.objectId === String(cardId));
    assert.ok(assignment, 'no workhub notification');
    assert.deepEqual(routeForObject(assignment.app, assignment.objectType, assignment.objectId), { name: 'task', cardId });
    assert.deepEqual(parseServerLink(base, assignment.link), { name: 'task', cardId });
    const opened = await openTaskFromNotification(B, cardId, true);
    assert.equal(opened.state, 'ok');
    return `link path=${new URL(assignment.link).pathname}`;
  });

  await step('workhub: restricted user C cannot open the task', async () => {
    const r = await openTaskFromNotification(C, cardId, true);
    assert.notEqual(r.state, 'ok');
    return `state=${r.state}`;
  });

  await step('workhub: unassign clears B notification', async () => {
    await workhubApi.updateTask(A, cardId, { assignees: [] });
    const still = await findNotification(B, (x) => x.id === assignment!.id, 2);
    assert.equal(still, undefined);
  });

  await step('workhub: delete task → B sees gone/forbidden', async () => {
    await A.request(`${WH}/tasks/${cardId}`, { method: 'DELETE' });
    const r = await openTaskFromNotification(B, cardId, true);
    assert.ok(r.state === 'gone' || r.state === 'forbidden');
    return `state=${r.state}`;
  });

  await step('logout revokes app password → 401', async () => {
    const mem = new Map<string, string>();
    const store: SecretStore = { get: async (k) => mem.get(k) ?? null, set: async (k, v) => void mem.set(k, v), delete: async (k) => void mem.delete(k) };
    const acc = await addAccount(store, { serverBase: base, loginName: env('WH_A_USER'), appPassword: env('WH_A_REVOKE_PASS') });
    await createAccountClient(acc, store).get('/ocs/v2.php/cloud/user');
    const rep = await logout(acc, store, { wipeLocalData: async () => {} });
    assert.equal(rep.appPasswordRevoked, true);
    const after = await client(env('WH_A_USER'), env('WH_A_REVOKE_PASS')).get('/ocs/v2.php/cloud/user').then(() => 'ok', (e) => (e as OcsError).kind);
    assert.equal(after, 'unauthorized');
  });

  console.log(`server: ${base}\n${matrix}\n`);
  for (const [n, r] of results) console.log(`${r.startsWith('PASS') ? '✔' : '✘'} ${n}: ${r}`);
  if (results.some(([, r]) => r.startsWith('FAIL'))) process.exitCode = 1;
}

main().catch((e) => {
  console.error('smoke aborted:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
