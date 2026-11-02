import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectBackend, dispatchWire, isValidAiRequestInput, type PlainStore } from '../src/backend';
import type { SecretStore } from '../src/accounts';
import { OcsError } from '../src/ocs';
import { aiInputError, aiResultCardId, isAiActive, proposalActions, type AiProposal, type AiRequestInput } from '../src/ai';
import { headerOf, json, ocs, scriptedFetch, type Call } from './helpers';

class Mem implements SecretStore, PlainStore {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
  async deletePrefix(p: string) { for (const k of [...this.m.keys()]) if (k.startsWith(p)) this.m.delete(k); }
}
const BAD = { ok: false, error: { kind: 'client', message: 'invalid arguments' } };
const bootstrap = (ai: boolean) => json(200, ocs({ apiVersion: '1', modules: { projects: true, ai }, permissions: { canViewTeamReport: false } }));
const RID = '6cf8d1ad-62ab-41dc-9506-e3d9b1a28662';
const KEY = '0b0f6c55-1c1c-4f7e-9a51-6a3a1a4b5c6d';

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
const isCode = (code: string) => (e: unknown) => e instanceof OcsError && e.errorCode === code;
const input = (action: AiRequestInput['action'], scope: Partial<AiRequestInput['scope']> = {}, message?: string): AiRequestInput => ({
  action, scope: { cardIds: [], boardIds: [], ...scope }, ...(message !== undefined ? { message } : {}),
});
const detail = (over: Record<string, unknown> = {}) => ({
  requestId: RID, action: 'board_summary', state: 'running', errorCode: null, errorMessage: null, providerConfigVersion: 6, attempt: 1,
  createdAt: '2026-11-02T19:33:01Z', startedAt: '2026-11-02T19:33:02Z', finishedAt: null, pollAfterMs: 1000,
  restricted: false, message: null, result: null, sources: [], boards: [{ boardId: 4, title: 'P' }], truncated: false, omitted: 0, proposal: null, ...over,
});
const proposal = (over: Partial<AiProposal> = {}): AiProposal => ({
  id: 7, requestId: RID, action: 'update_card_draft', state: 'ready', version: 1, createdAt: '', expiresAt: '', resultRef: null,
  restricted: false, stale: false,
  target: { type: 'card', cardId: 50, boardId: 4, boardTitle: 'P', url: 'https://ex.com/apps/workhub/projects/4/cards/50', canEdit: true },
  proposed: { title: 'Yeni başlık' }, current: { title: 'Eski', description: '', due: null }, ...over,
});

test('per-action scope rules mirror AiRequestService::validate', () => {
  assert.equal(aiInputError(input('card_summary', { cardIds: [1, 2] })), null);
  assert.equal(aiInputError(input('card_summary')), 'card_required');
  assert.equal(aiInputError(input('card_summary', { cardIds: [1], boardIds: [4] })), 'no_board_allowed');
  assert.equal(aiInputError(input('card_summary', { cardIds: Array.from({ length: 21 }, (_, i) => i + 1) })), 'too_many_cards');
  assert.equal(aiInputError(input('board_summary', { boardIds: [4] })), null);
  assert.equal(aiInputError(input('board_summary', { boardIds: [4, 5] })), 'one_board');
  assert.equal(aiInputError(input('board_summary', { boardIds: [4], cardIds: [1] })), 'one_board');
  assert.equal(aiInputError(input('question', { boardIds: [4] })), 'message_required');
  assert.equal(aiInputError(input('question', { boardIds: [4] }, '   ')), 'message_required');
  assert.equal(aiInputError(input('question', {}, 'Ne durumda?')), 'scope_required');
  assert.equal(aiInputError(input('question', { cardIds: [1], boardIds: [4] }, 'Ne durumda?')), null);
  assert.equal(aiInputError(input('question', { boardIds: [4] }, 'x'.repeat(4001))), 'message_too_long');
  assert.equal(aiInputError(input('create_card_draft', { boardIds: [4] }, 'Görev yaz')), 'stack_required');
  assert.equal(aiInputError(input('create_card_draft', { boardIds: [4], stackId: 9 }, 'Görev yaz')), null);
  assert.equal(aiInputError(input('create_card_draft', { boardIds: [4], stackId: 9 })), 'message_required');
  assert.equal(aiInputError(input('board_summary', { boardIds: [4], stackId: 9 })), 'stack_not_allowed');
  assert.equal(aiInputError(input('update_card_draft', { cardIds: [1] }, 'Kısalt')), null);
  assert.equal(aiInputError(input('update_card_draft', { cardIds: [1, 2] }, 'Kısalt')), 'one_card');
  assert.equal(aiInputError(input('suggest_checklist', { cardIds: [1] })), null);
  assert.equal(aiInputError(input('suggest_checklist', { cardIds: [1], boardIds: [4] })), 'no_board_allowed');
});

test('proposal actions come only from the fresh preview', () => {
  assert.deepEqual(proposalActions(proposal()), { accept: true, dismiss: true });
  assert.deepEqual(proposalActions(proposal({ stale: true })), { accept: false, dismiss: true });
  assert.deepEqual(proposalActions(proposal({ state: 'stale' })), { accept: false, dismiss: true });
  assert.deepEqual(proposalActions(proposal({ restricted: true, target: null })), { accept: false, dismiss: true });
  assert.deepEqual(proposalActions(proposal({ target: { type: 'stack', boardId: 4, boardTitle: 'P', stackId: 9, stackTitle: 'A', canEdit: false } })), { accept: false, dismiss: true });
  for (const state of ['accepted', 'dismissed', 'expired'] as const) assert.deepEqual(proposalActions(proposal({ state })), { accept: false, dismiss: false });
  assert.equal(aiResultCardId('card:51'), 51);
  assert.equal(aiResultCardId('board:4'), null);
  assert.equal(aiResultCardId(null), null);
  assert.ok(isAiActive('cancel_requested') && !isAiActive('cancelled'));
});

test('AI gate is fail-closed: module off → AI_DISABLED, no /ai request sent', async () => {
  const { b, f, id } = await loggedIn(bootstrap(false));
  await assert.rejects(b.aiStatus(id), isCode('AI_DISABLED'));
  await assert.rejects(b.aiRequests(id), isCode('AI_DISABLED'));
  await assert.rejects(b.aiCreate(id, input('board_summary', { boardIds: [4] }), KEY), isCode('AI_DISABLED'));
  assert.equal(f.calls.filter((c) => c.url.includes('/ai/')).length, 0);
});

test('create sends the canonical body with a UUID Idempotency-Key; invalid scope never reaches the server', async () => {
  const { b, f, id } = await loggedIn(
    bootstrap(true),
    json(202, ocs({ requestId: RID, state: 'queued', pollAfterMs: 1000, providerConfigVersion: 6 }, 202)),
  );
  await assert.rejects(b.aiCreate(id, input('question', { boardIds: [4] }, '  '), KEY), isCode('AI_INVALID_SCOPE'));
  const r = await b.aiCreate(id, input('question', { boardIds: [4], includeComments: true }, '  Ne kaldı?  '), KEY);
  assert.deepEqual(r, { requestId: RID, pollAfterMs: 1000 });
  const call = f.calls.find((c) => c.url.split('?')[0]!.endsWith('/ai/requests'))!;
  assert.equal(call.init.method, 'POST');
  assert.equal(headerOf(call, 'Idempotency-Key'), KEY);
  assert.deepEqual(JSON.parse(String(call.init.body)), { action: 'question', scope: { cardIds: [], boardIds: [4], includeComments: true }, message: 'Ne kaldı?' });
});

test('cancel reads the request first: finished → AI_REQUEST_FINISHED, active → POST cancel', async () => {
  const { b, f, id } = await loggedIn(
    bootstrap(true),
    json(200, ocs(detail({ state: 'failed', errorCode: 'PROVIDER_TIMEOUT', pollAfterMs: null }))),
    json(200, ocs(detail())),
    json(200, ocs({ ...detail({ state: 'cancel_requested' }) })),
  );
  await assert.rejects(b.aiCancel(id, RID), isCode('AI_REQUEST_FINISHED'));
  const r = await b.aiCancel(id, RID.toUpperCase());
  assert.equal(r?.state, 'cancel_requested');
  const posts = f.calls.filter((c) => c.init.method === 'POST' && c.url.includes('/ai/'));
  assert.equal(posts.length, 1);
  assert.ok(posts[0]!.url.split('?')[0]!.endsWith(`/ai/requests/${RID}/cancel`));
});

test('accept gates on the CURRENT preview: stale / not editable / old version / expired never POST', async () => {
  const { b, f, id } = await loggedIn(
    bootstrap(true),
    json(200, ocs(proposal({ stale: true }))),
    json(200, ocs(proposal({ target: { type: 'card', cardId: 50, boardId: 4, boardTitle: 'P', url: '', canEdit: false } }))),
    json(200, ocs(proposal({ version: 2 }))),
    json(200, ocs(proposal({ state: 'expired', version: 1 }))),
    json(200, ocs(proposal({ restricted: true, target: null, proposed: null, current: null }))),
    json(200, ocs(proposal())),
    json(200, ocs({ alreadyApplied: false, resultRef: 'card:50', cardId: 50, url: 'x', proposal: { id: 7, state: 'accepted', version: 2 } })),
  );
  await assert.rejects(b.aiAccept(id, 7, 1, KEY), isCode('SOURCE_CHANGED'));
  await assert.rejects(b.aiAccept(id, 7, 1, KEY), isCode('ACTION_FORBIDDEN'));
  await assert.rejects(b.aiAccept(id, 7, 1, KEY), isCode('VERSION_CONFLICT'));
  await assert.rejects(b.aiAccept(id, 7, 1, KEY), isCode('PROPOSAL_EXPIRED'));
  await assert.rejects(b.aiAccept(id, 7, 1, KEY), (e: unknown) => e instanceof OcsError && e.kind === 'not_found');
  const r = await b.aiAccept(id, 7, 1, KEY);
  assert.equal(r?.cardId, 50);
  const posts = f.calls.filter((c) => c.init.method === 'POST' && c.url.includes('/ai/'));
  assert.equal(posts.length, 1);
  assert.equal(headerOf(posts[0], 'Idempotency-Key'), KEY);
  assert.deepEqual(JSON.parse(String(posts[0]!.init.body)), { version: 1 });
});

test('dismiss allowed for ready and stale, refused for accepted', async () => {
  const { b, f, id } = await loggedIn(
    bootstrap(true),
    json(200, ocs(proposal({ state: 'accepted', version: 2 }))),
    json(200, ocs(proposal({ state: 'stale', version: 2 }))),
    json(200, ocs({ id: 7, state: 'dismissed', version: 3 })),
  );
  await assert.rejects(b.aiDismiss(id, 7, 2), isCode('PROPOSAL_NOT_READY'));
  assert.equal((await b.aiDismiss(id, 7, 2))?.state, 'dismissed');
  assert.equal(f.calls.filter((c) => c.init.method === 'POST' && c.url.includes('/ai/')).length, 1);
});

test('IPC rejects malformed AI arguments before the backend runs', async () => {
  const never = new Proxy({}, { get: () => () => { throw new Error('backend must not be called'); } }) as never;
  const ok = input('board_summary', { boardIds: [4] });
  const cases: Array<[string, unknown[]]> = [
    ['aiCreate', ['acc', ok, 'not-a-uuid-key']],
    ['aiCreate', ['acc', { ...ok, extra: 1 }, KEY]],
    ['aiCreate', ['acc', { action: 'translate', scope: { cardIds: [], boardIds: [4] } }, KEY]],
    ['aiCreate', ['acc', { action: 'board_summary', scope: { cardIds: [], boardIds: [4], threadId: 'x' } }, KEY]],
    ['aiCreate', ['acc', { action: 'board_summary', scope: { cardIds: [], boardIds: [4, 4] } }, KEY]],
    ['aiCreate', ['acc', { action: 'board_summary', scope: { boardIds: [4] } }, KEY]],
    ['aiCreate', ['acc', input('question', { boardIds: [4] }), KEY]],
    ['aiCreate', ['acc', input('question', { boardIds: [4] }, 'x'.repeat(4001)), KEY]],
    ['aiRequest', ['acc', '../../admin/ai/provider']],
    ['aiRequest', ['acc', 12]],
    ['aiCancel', ['acc', `${RID}/x`]],
    ['aiProposal', ['acc', 0]],
    ['aiAccept', ['acc', 7, 1, 'k']],
    ['aiAccept', ['acc', 7, -1, KEY]],
    ['aiDismiss', ['acc', 7]],
    ['aiStatus', ['acc', 'extra']],
  ];
  for (const [m, args] of cases) assert.deepEqual(await dispatchWire(never, m, args), BAD, `${m} ${JSON.stringify(args).slice(0, 80)}`);
  assert.ok(isValidAiRequestInput(input('create_card_draft', { boardIds: [4], stackId: 9 }, 'Taslak')));
  assert.ok(!isValidAiRequestInput(input('create_card_draft', { boardIds: [4] }, 'Taslak')));
});
