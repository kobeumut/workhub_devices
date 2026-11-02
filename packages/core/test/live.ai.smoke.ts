/**
 * Live smoke for the native AI slice (GENE-56): per-user module gate, status/quota, per-action
 * scope validation (server rules), request lifecycle queued → running → terminal with a
 * server-translated error, idempotent create, cancel, owner-only reads (others 404) and the
 * proposal endpoints' guards.
 * Not part of `npm test`. Run: `npm run smoke:ai -w @workhub-devices/core` with
 *   WH_SERVER, WH_ALLOW_HTTP=1 (local dev only),
 *   WH_A_USER/WH_A_PASS (AI module on), WH_B_USER/WH_B_PASS (AI on, NOT a member of the new project),
 *   WH_C_USER/WH_C_PASS (AI module off for this user).
 * Dev server: the provider endpoint is not reachable from the containers (host firewall), so
 * requests end `failed` with a PROVIDER_* code; a successful answer / draft cannot be produced
 * here (see docs/test-evidence.md). Creates one project per run. Prints no secrets or AI content.
 */
import assert from 'node:assert/strict';
import { OcsClient, OcsError, aiApi, isAiActive, normalizeServerUrl, workhubApi, type AiRequestDetail, type ServerBase } from '../src/index';

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
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof OcsError ? `${e.status ?? e.kind}:${e.errorCode ?? ''}` : 'error'));
const key = () => crypto.randomUUID();
const stamp = new Date().toISOString().slice(0, 16);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const API = '/ocs/v2.php/apps/workhub/api/v1';

/** Polls like the app does (server `pollAfterMs`) until the request leaves the active states. */
async function settle(c: OcsClient, id: string, maxMs = 90_000): Promise<{ last: AiRequestDetail; seen: string[] }> {
  const seen: string[] = [];
  const until = Date.now() + maxMs;
  for (;;) {
    const d = await aiApi.get(c, id);
    if (seen[seen.length - 1] !== d.state) seen.push(d.state);
    if (!isAiActive(d.state)) return { last: d, seen };
    if (Date.now() > until) throw new Error(`still ${d.state} after ${maxMs} ms`);
    await sleep(Math.max(500, d.pollAfterMs ?? 1000));
  }
}

async function main() {
  let boardId = 0;
  let otherBoard = 0;
  let stackId = 0;
  let cardId = 0;
  let summaryId = '';

  await step('gate + status: A/B module on, provider enabled+configured, quota; C → 403 AI_DISABLED', async () => {
    const s = await aiApi.status(A);
    assert.equal(s.module, true);
    assert.equal(s.enabled, true);
    assert.equal(s.configured, true);
    assert.equal(s.quota.remainingToday, Math.max(0, s.quota.dailyLimit - s.quota.usedToday));
    assert.ok(s.quota.maxConcurrent >= 1);
    assert.equal((await aiApi.status(B)).module, true);
    assert.equal(await code(aiApi.status(C)), '403:AI_DISABLED');
    assert.equal(await code(aiApi.list(C)), '403:AI_DISABLED');
    return `quota ${s.quota.usedToday}/${s.quota.dailyLimit}, in flight ${s.quota.inFlight}/${s.quota.maxConcurrent}`;
  });

  await step('setup: A creates two projects and a task', async () => {
    boardId = (await workhubApi.createProject(A, `GENE-56 AI smoke ${stamp}`, undefined, key()))!.id;
    otherBoard = (await workhubApi.createProject(A, `GENE-56 AI other ${stamp}`, undefined, key()))!.id;
    const board = await workhubApi.board(A, boardId);
    stackId = board.project.stacks[0]!.id;
    const t = await A.request<{ id: number }>(`${API}/projects/${boardId}/tasks`, { method: 'POST', body: { stackId, title: 'AI smoke görevi' }, headers: { 'Idempotency-Key': key() } });
    cardId = t.data!.id;
    return `board ${boardId}, card ${cardId}`;
  });

  await step('validation (server): missing message, two boards, foreign column, non-UUID key, unknown action', async () => {
    assert.equal(await code(aiApi.create(A, { action: 'question', scope: { cardIds: [], boardIds: [boardId] } }, key())), '422:FIELD_REQUIRED');
    assert.equal(await code(aiApi.create(A, { action: 'board_summary', scope: { cardIds: [], boardIds: [boardId, otherBoard] } }, key())), '422:INVALID_SCOPE');
    assert.equal(await code(aiApi.create(A, { action: 'suggest_checklist', scope: { cardIds: [cardId], boardIds: [boardId] } }, key())), '422:INVALID_SCOPE');
    const foreign = (await workhubApi.board(A, otherBoard)).project.stacks[0]!.id;
    assert.equal(await code(aiApi.create(A, { action: 'create_card_draft', scope: { cardIds: [], boardIds: [boardId], stackId: foreign }, message: 'x' }, key())), '422:INVALID_STACK');
    assert.equal(await code(aiApi.create(A, { action: 'board_summary', scope: { cardIds: [], boardIds: [boardId] } }, 'not-a-uuid')), '422:INVALID_IDEMPOTENCY_KEY');
    assert.equal(await code(A.request(`${API}/ai/requests`, { method: 'POST', body: { action: 'translate', scope: { boardIds: [boardId] } } })), '422:INVALID_VALUE');
  });

  await step('source ACL: B (not a member) asking about A\'s card / board → 404, nothing created', async () => {
    const before = (await aiApi.list(B)).length;
    assert.equal(await code(aiApi.create(B, { action: 'card_summary', scope: { cardIds: [cardId], boardIds: [] } }, key())), '404:RESOURCE_NOT_FOUND');
    assert.equal(await code(aiApi.create(B, { action: 'board_summary', scope: { cardIds: [], boardIds: [boardId] } }, key())), '404:RESOURCE_NOT_FOUND');
    assert.equal((await aiApi.list(B)).length, before);
  });

  await step('lifecycle: board summary 202 queued → worker → terminal with a translated error; idempotent create', async () => {
    const k = key();
    const body = { action: 'board_summary' as const, scope: { cardIds: [], boardIds: [boardId] } };
    const r = (await aiApi.create(A, body, k))!;
    assert.equal(r.state, 'queued');
    assert.ok(r.pollAfterMs > 0);
    summaryId = r.requestId;
    const again = (await aiApi.create(A, body, k))!;
    assert.equal(again.requestId, summaryId, 'same Idempotency-Key → same request');
    const { last, seen } = await settle(A, summaryId);
    assert.equal(last.restricted, false);
    assert.deepEqual(last.boards.map((b) => b.boardId), [boardId]);
    assert.equal(last.pollAfterMs, null);
    if (last.state === 'succeeded') {
      assert.equal(typeof last.result, 'string');
      return `${seen.join(' → ')} (provider reachable)`;
    }
    assert.equal(last.state, 'failed');
    assert.match(String(last.errorCode), /^PROVIDER_|^ENDPOINT_/);
    assert.ok((last.errorMessage ?? '').length > 0, 'server explains the error');
    assert.equal(last.result, null);
    assert.equal(last.proposal, null);
    return `${seen.join(' → ')}; ${last.errorCode}, attempt ${last.attempt}`;
  });

  await step('owner only: list has content-free metadata; B GET/cancel → 404', async () => {
    const row = (await aiApi.list(A)).find((x) => x.requestId === summaryId);
    assert.ok(row, 'listed');
    assert.equal(row!.boardCount, 1);
    assert.equal(row!.cardCount, 0);
    assert.ok(!('result' in row!) && !('message' in row!));
    assert.equal(await code(aiApi.get(B, summaryId)), '404:RESOURCE_NOT_FOUND');
    assert.equal(await code(aiApi.cancel(B, summaryId)), '404:RESOURCE_NOT_FOUND');
  });

  await step('cancel: new request cancelled while queued/running → cancelled; cancelling again changes nothing', async () => {
    const r = (await aiApi.create(A, { action: 'card_summary', scope: { cardIds: [cardId], boardIds: [] } }, key()))!;
    const c1 = (await aiApi.cancel(A, r.requestId))!;
    assert.ok(['cancelled', 'cancel_requested', 'failed'].includes(c1.state), c1.state);
    const { last, seen } = await settle(A, r.requestId);
    if (c1.state !== 'failed') {
      assert.equal(last.state, 'cancelled');
      assert.equal(last.errorCode, 'CANCELLED');
    }
    const c2 = (await aiApi.cancel(A, r.requestId))!;
    assert.equal(c2.state, last.state);
    return `cancel → ${c1.state}; ${seen.join(' → ')}`;
  });

  await step('proposals: unknown / foreign id → 404; accept without Idempotency-Key → 422; dismiss without version → 422', async () => {
    assert.equal(await code(aiApi.proposal(A, 999999)), '404:RESOURCE_NOT_FOUND');
    assert.equal(await code(A.request(`${API}/ai/proposals/999999/accept`, { method: 'POST', body: { version: 1 } })), '422:IDEMPOTENCY_KEY_REQUIRED');
    assert.equal(await code(aiApi.accept(A, 999999, 1, key())), '404:RESOURCE_NOT_FOUND');
    assert.equal(await code(A.request(`${API}/ai/proposals/999999/dismiss`, { method: 'POST', body: {} })), '422:FIELD_REQUIRED');
    assert.equal(await code(aiApi.dismiss(A, 999999, 1)), '404:RESOURCE_NOT_FOUND');
  });

  for (const [n, r] of results) console.log(`${r.startsWith('PASS') ? '✔' : '✖'} ${n}: ${r}`);
  const failed = results.filter(([, r]) => !r.startsWith('PASS')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

void main();
