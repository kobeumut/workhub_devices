/**
 * Live smoke for the native Requests slice (GENE-51): recipient approve / reject (reason
 * required), manager resolve / convert (project + column) with optimistic `version` (stale →
 * 409 VERSION_CONFLICT), role gates, history events and the report.
 * Not part of `npm test`. Run: `npm run smoke:requests -w @workhub-devices/core` with
 *   WH_SERVER, WH_ALLOW_HTTP=1 (local dev only),
 *   WH_C_USER/WH_C_PASS (requester; their Nextcloud manager must be WH_A_USER),
 *   WH_A_USER/WH_A_PASS (recipient; their manager must be WH_B_USER),
 *   WH_B_USER/WH_B_PASS (manager of A → manages requests addressed to A).
 * Creates three requests and one project per run (Workhub has no request/project delete API).
 * Prints no secrets or request bodies.
 */
import assert from 'node:assert/strict';
import { OcsClient, OcsError, normalizeServerUrl, requestActions, requestsApi, workhubApi, workhubModulesApi, type ServerBase } from '../src/index';

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
  const ids: Record<'resolve' | 'convert' | 'reject', number> = { resolve: 0, convert: 0, reject: 0 };
  let boardId = 0;
  let stackId = 0;
  const create = async (tag: string) => (await workhubModulesApi.createRequest(C, { title: `GENE-51 smoke ${tag} ${stamp}`, description: 'smoke' }, key()))!.id;

  await step('setup: chain C → A → B; three pending requests from C to A', async () => {
    const ctxC = await workhubModulesApi.requestContext(C);
    const ctxA = await workhubModulesApi.requestContext(A);
    assert.equal(ctxC.manager?.uid, env('WH_A_USER'));
    assert.equal(ctxA.manager?.uid, env('WH_B_USER'));
    assert.equal(ctxC.isManager, false);
    for (const k of Object.keys(ids) as Array<keyof typeof ids>) ids[k] = await create(k);
    const r = await requestsApi.get(C, ids.resolve);
    assert.equal(r.state, 'pending');
    assert.equal(r.recipientName.length > 0, true);
    return `ids ${Object.values(ids).join(',')}`;
  });

  await step('flags: only the recipient may respond; nobody manages a pending request', async () => {
    const asA = await requestsApi.get(A, ids.resolve);
    assert.deepEqual(requestActions(asA), { respond: true, resolve: false, convert: false });
    const asC = await requestsApi.get(C, ids.resolve);
    assert.deepEqual(requestActions(asC), { respond: false, resolve: false, convert: false });
    const received = (await requestsApi.list(A, 'received')).items.map((x) => x.id);
    assert.ok(received.includes(ids.resolve), 'A sees it under received');
    // B is not a party of a pending request (consent comes first).
    assert.equal(await code(requestsApi.get(B, ids.resolve)), 'not_found:RESOURCE_NOT_FOUND');
  });

  await step('respond: requester → 404; reject without reason → 422; stale version → 409', async () => {
    const r = await requestsApi.get(A, ids.reject);
    assert.equal(await code(requestsApi.respond(C, ids.reject, r.version, 'approve', null, key())), 'not_found:RESOURCE_NOT_FOUND');
    assert.equal(await code(requestsApi.respond(A, ids.reject, r.version, 'reject', null, key())), 'client:FIELD_REQUIRED');
    assert.equal(await code(requestsApi.respond(A, ids.reject, r.version + 5, 'approve', null, key())), 'conflict:VERSION_CONFLICT');
  });

  await step('respond: reject with reason → rejected, reason visible to requester; terminal', async () => {
    const r = await requestsApi.get(A, ids.reject);
    const out = await requestsApi.respond(A, ids.reject, r.version, 'reject', 'Bütçe yok (smoke)', key());
    assert.equal(out!.state, 'rejected');
    assert.equal(out!.version, r.version + 1);
    const asC = await requestsApi.get(C, ids.reject);
    assert.equal(asC.rejectionReason, 'Bütçe yok (smoke)');
    assert.deepEqual(requestActions(await requestsApi.get(A, ids.reject)), { respond: false, resolve: false, convert: false });
  });

  await step('respond: approve twice with the same key is idempotent → open; manager B now sees it', async () => {
    for (const id of [ids.resolve, ids.convert]) {
      const r = await requestsApi.get(A, id);
      const k = key();
      const first = await requestsApi.respond(A, id, r.version, 'approve', null, k);
      const again = await requestsApi.respond(A, id, r.version, 'approve', null, k);
      assert.equal(first!.state, 'open');
      assert.equal(again!.version, first!.version);
    }
    const asB = await requestsApi.get(B, ids.resolve);
    assert.deepEqual(requestActions(asB), { respond: false, resolve: true, convert: true });
    const team = (await requestsApi.list(B, 'team', 'open')).items.map((x) => x.id);
    assert.ok(team.includes(ids.resolve) && team.includes(ids.convert), 'B sees both under team/open');
    // A is the recipient, not in her own management chain.
    assert.deepEqual(requestActions(await requestsApi.get(A, ids.resolve)), { respond: false, resolve: false, convert: false });
  });

  await step('resolve: requester/recipient → 404; stale version → 409; B resolves with reason', async () => {
    const r = await requestsApi.get(B, ids.resolve);
    assert.equal(await code(requestsApi.resolve(C, ids.resolve, r.version, 'x', key())), 'not_found:RESOURCE_NOT_FOUND');
    assert.equal(await code(requestsApi.resolve(A, ids.resolve, r.version, 'x', key())), 'not_found:RESOURCE_NOT_FOUND');
    assert.equal(await code(requestsApi.resolve(B, ids.resolve, r.version - 1, 'x', key())), 'conflict:VERSION_CONFLICT');
    const out = await requestsApi.resolve(B, ids.resolve, r.version, 'Gerek kalmadı (smoke)', key());
    assert.equal(out!.state, 'resolved');
    assert.ok(out!.resolvedAt);
    // Already resolved: the old version is stale now.
    assert.equal(await code(requestsApi.resolve(B, ids.resolve, r.version, 'x', key())), 'conflict:VERSION_CONFLICT');
  });

  await step('convert: destination checks (no edit → 403, foreign column → 422), then task is created', async () => {
    const p = await workhubApi.createProject(B, `GENE-51 smoke ${stamp}`, undefined, key());
    boardId = p!.id;
    const board = await workhubApi.board(B, boardId);
    stackId = board.project.stacks[0]!.id;
    const r = await requestsApi.get(B, ids.convert);
    // A cannot edit B's new project and is not a manager of the request anyway.
    assert.equal(await code(requestsApi.convert(A, ids.convert, r.version, boardId, stackId, key())), 'not_found:RESOURCE_NOT_FOUND');
    const other = (await workhubApi.projects(B)).find((x) => x.id !== boardId && x.edit && !x.archived);
    if (other) {
      const foreign = (await workhubApi.board(B, other.id)).project.stacks[0]!.id;
      assert.equal(await code(requestsApi.convert(B, ids.convert, r.version, boardId, foreign, key())), 'client:INVALID_STACK');
    }
    assert.equal(await code(requestsApi.convert(B, ids.convert, r.version + 3, boardId, stackId, key())), 'conflict:VERSION_CONFLICT');
    const out = await requestsApi.convert(B, ids.convert, r.version, boardId, stackId, key());
    assert.equal(out!.state, 'converted');
    assert.equal(out!.taskState, 'open');
    assert.equal(out!.card?.boardId, boardId);
    assert.equal(out!.card?.stackId, stackId);
    const tasks = (await workhubApi.board(B, boardId)).tasks.filter((t) => t.id === out!.card!.id);
    assert.equal(tasks.length, 1, 'card exists on the board');
    // Requester cannot read B's project → linked card is restricted for C.
    const asC = await requestsApi.get(C, ids.convert);
    assert.equal(asC.state, 'converted');
    assert.equal(asC.card === null && asC.cardRestricted, true);
    return `card ${out!.card!.id} in board ${boardId}`;
  });

  await step('history: created → approved → resolved/converted events, newest first', async () => {
    const h1 = (await requestsApi.history(B, ids.resolve)).items.map((e) => e.action);
    assert.deepEqual(h1, ['request.resolved', 'request.approved', 'request.created']);
    const h2 = (await requestsApi.history(C, ids.convert)).items.map((e) => e.action);
    assert.equal(h2[0], 'request.converted');
    const h3 = (await requestsApi.history(C, ids.reject)).items;
    assert.equal(h3[0]!.action, 'request.rejected');
    assert.equal(h3[0]!.reason, 'Bütçe yok (smoke)');
    assert.equal(await code(requestsApi.history(B, ids.reject)), 'not_found:RESOURCE_NOT_FOUND', 'B is not a party of a rejected request');
  });

  await step('report: B team view counts the converted/resolved requests; C has no team rows', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const rb = await requestsApi.report(B, { scope: 'team', type: 'request', state: 'any', from: today, to: today });
    const rowIds = rb.items.map((x) => x.id);
    assert.ok(rowIds.includes(ids.resolve) && rowIds.includes(ids.convert));
    assert.equal(rb.items.find((x) => x.id === ids.convert)!.state, 'converted');
    assert.equal(rb.total, rb.items.length);
    assert.equal(rb.byType.request, rb.items.length);
    const rc = await requestsApi.report(C, { scope: 'team', type: 'request', state: 'any', from: today, to: today });
    assert.equal(rc.items.length, 0);
    const mine = await requestsApi.report(C, { scope: 'mine', type: 'request', state: 'any', from: today, to: today });
    assert.ok([ids.resolve, ids.convert, ids.reject].every((id) => mine.items.some((x) => x.id === id)));
    assert.equal(await code(requestsApi.report(C, { scope: 'mine', type: 'request', state: 'any', from: '2025-01-01', to: today })), 'client:RANGE_TOO_LARGE');
    return `team total=${rb.total}, byState=${JSON.stringify(rb.byState)}`;
  });

  for (const [n, r] of results) console.log(`${r.startsWith('PASS') ? '✔' : '✖'} ${n}: ${r}`);
  const failed = results.filter(([, r]) => !r.startsWith('PASS')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

void main();

