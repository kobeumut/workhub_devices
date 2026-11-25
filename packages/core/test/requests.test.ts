import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectBackend, createWireBackend, dispatchWire, isValidReportFilters, type PlainStore } from '../src/backend';
import type { SecretStore } from '../src/accounts';
import { OcsClient, OcsError } from '../src/ocs';
import { loadPendingRequestApprovals, requestActions, requestReportStatus, requestsApi, type RequestListState, type RequestScope, type WorkRequest } from '../src/workhub';
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
const bootstrap = (requests: boolean) => json(200, ocs({ apiVersion: '1', modules: { requests }, permissions: { canViewTeamReport: false } }));

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

const req = (over: Partial<WorkRequest> = {}): WorkRequest => ({
  id: 5, version: 2, title: 'Yeni laptop', description: '', requesterUid: 'carol', requesterName: 'Carol', recipientUid: 'alice', recipientName: 'Alice', managerName: 'Bob',
  canManage: false, canRespond: false, rejectionReason: null, respondedAt: null, state: 'pending', taskState: null, createdAt: '2026-11-02T10:00:00+00:00',
  convertedAt: null, resolvedAt: null, taskClosedAt: null, checkedAt: null, card: null, cardRestricted: false, ...over,
});

test('request actions fail closed without exact row flags; recipient conversion and Talk cooldowns are independent', () => {
  const actions = (over: Partial<WorkRequest>, now?: number) => Object.entries(requestActions(req(over), now)).filter(([, allowed]) => allowed).map(([name]) => name);
  assert.deepEqual(actions({ canManage: true, state: 'open' }), [], 'legacy management is not a grant');
  assert.deepEqual(actions({ canRespond: true, canConvert: true, state: 'pending' }), ['respond', 'convert']);
  assert.deepEqual(actions({ canResolve: true, canDecide: true, canCancel: true }), ['resolve', 'decide', 'cancel']);
  const at = '2026-11-04T10:00:00Z';
  const reminder = { canRemind: true, canRemindManagers: true, remindAvailableAt: null, remindManagersAvailableAt: at } as const;
  assert.deepEqual(actions(reminder), [], 'list without Talk detail cannot remind');
  assert.deepEqual(actions({ ...reminder, talkAvailable: true }, Date.parse(at) - 1), ['remind']);
  assert.deepEqual(actions({ ...reminder, talkAvailable: true }, Date.parse(at)), ['remind', 'remindManagers']);
  assert.deepEqual(actions({ canRemind: true, talkAvailable: true }), [], 'unknown cooldown is not ready');
});

test('pending approvals retain each server-filtered cursor, including pages with no actionable rows', async () => {
  const calls: Array<[RequestScope, RequestListState, number | null]> = [];
  const load = async (scope: RequestScope, state: RequestListState, before: number | null) => {
    calls.push([scope, state, before]);
    if (scope === 'received') return { items: [req({ canRespond: true })], nextCursor: null };
    if (state === 'open' && before === null) return { items: [req({ id: 8, canManage: true, canDecide: true })], nextCursor: 7 };
    if (state === 'converted' && before === null) return { items: [req({ id: 6, canDecide: true, awaitingYou: true }), req({ id: 10, awaitingYou: true })], nextCursor: 3 };
    return { items: [req({ id: 2, canDecide: true, awaitingYou: true })], nextCursor: null };
  };
  const first = await loadPendingRequestApprovals(load, null);
  assert.deepEqual(first.items.map((row) => row.id), [5, 6]);
  assert.deepEqual(first.nextCursor, { open: 7, converted: 3 });
  const next = await loadPendingRequestApprovals(load, first.nextCursor);
  assert.deepEqual(next.items.map((row) => row.id), [2]);
  assert.equal(next.nextCursor, null);
  assert.deepEqual(calls, [['received', 'pending', null], ['team', 'open', null], ['team', 'converted', null], ['team', 'open', 7], ['team', 'converted', 3]]);
});

test('report status distinguishes a converted request awaiting management from timesheet status', () => {
  assert.equal(requestReportStatus({ type: 'request', state: 'converted', managerState: 'waiting' }), 'manager_waiting');
  assert.equal(requestReportStatus({ type: 'request', state: 'open', managerState: 'approved' }), 'manager_approved');
  assert.equal(requestReportStatus({ type: 'timesheet', state: 'pending', managerState: null }), 'pending');
});

test('requests API: paths, bodies, Idempotency-Key, cursors, report query', async () => {
  const r = ocs(req());
  const f = scriptedFetch(
    json(200, ocs({ items: [], nextCursor: null })), json(200, r), json(200, ocs({ items: [], nextCursor: 3 })),
    json(200, r), json(200, r), json(200, r), json(200, r),
    json(200, ocs({ items: [], total: 0, byType: { request: 0, timesheet: 0 }, byState: {} })),
  );
  const c = new OcsClient({ serverBase: 'https://ex.com' as never, getCredentials: async () => ({ loginName: 'u', appPassword: 'p' }), fetch: f });
  await requestsApi.list(c, 'team', 'open', 40);
  await requestsApi.get(c, 5);
  await requestsApi.history(c, 5, 9);
  await requestsApi.respond(c, 5, 2, 'approve', null, KEY);
  await requestsApi.respond(c, 5, 2, 'reject', 'Bütçe yok', KEY);
  await requestsApi.resolve(c, 5, 3, 'Gerek kalmadı', KEY);
  await requestsApi.convert(c, 5, 3, 11, 12, KEY);
  await requestsApi.report(c, { scope: 'team', type: 'request', state: 'any', from: '2026-10-01', to: '2026-11-02' });
  const W = 'https://ex.com/ocs/v2.php/apps/workhub/api/v1/requests';
  assert.deepEqual(f.calls.map((x) => `${x.init.method} ${x.url.replace(W, '')}`), [
    'GET ?format=json&scope=team&state=open&before=40', 'GET /5?format=json', 'GET /5/history?format=json&before=9',
    'POST /5/respond?format=json', 'POST /5/respond?format=json', 'POST /5/resolve?format=json', 'POST /5/convert?format=json',
    'GET /report?format=json&scope=team&type=request&state=any&from=2026-10-01&to=2026-11-02',
  ]);
  assert.deepEqual(JSON.parse(String(f.calls[3]!.init.body)), { version: 2, decision: 'approve' });
  assert.deepEqual(JSON.parse(String(f.calls[4]!.init.body)), { version: 2, decision: 'reject', reason: 'Bütçe yok' });
  assert.deepEqual(JSON.parse(String(f.calls[5]!.init.body)), { version: 3, reason: 'Gerek kalmadı' });
  assert.deepEqual(JSON.parse(String(f.calls[6]!.init.body)), { version: 3, boardId: 11, stackId: 12 });
  for (const i of [3, 4, 5, 6]) assert.equal(headerOf(f.calls[i], 'Idempotency-Key'), KEY);
  await assert.rejects(requestsApi.convert(c, 5, 3, 0, 12, KEY), (e: unknown) => e instanceof OcsError && e.kind === 'client');
});

test('new request endpoints preserve inbox counts, decision bodies, and report filters through IPC', async () => {
  const r = json(200, ocs(req()));
  const inbox = { items: [], total: 27, canSeeAll: true, reviewer: true };
  const report = { items: [], total: 0, scope: 'team', approval: 'approved', person: 'ali', people: [{ uid: 'ali', displayName: 'Ali' }], reviewer: true };
  const { b, f, id } = await loggedIn(bootstrap(true), json(200, ocs(inbox)), r.clone(), r.clone(), r.clone(), r, json(200, ocs(report)), json(200, ocs({ items: report.people })));
  assert.deepEqual(await dispatchWire(b, 'requestInbox', [id, 10]), { ok: true, value: inbox });
  for (const [method, args] of [
    ['requestDecide', [id, 5, 2, 'reject', ' Neden ', KEY]], ['requestCancel', [id, 5, 2, null, KEY]],
    ['requestRemind', [id, 5, 2, KEY]], ['requestRemindManagers', [id, 5, 2, KEY]],
  ] as const) assert.equal((await dispatchWire(b, method, [...args])).ok, true);
  const filters = { scope: 'team', type: 'all', state: 'any', from: '2026-10-01', to: '2026-11-02', person: 'ali', approval: 'approved' };
  assert.deepEqual(await dispatchWire(b, 'requestReport', [id, filters]), { ok: true, value: report });
  const renderer = createWireBackend((method, args) => dispatchWire(b, method, args));
  assert.deepEqual(await renderer.requestPeople(id), report.people);
  const calls = f.calls.slice(3);
  assert.deepEqual(calls.map((x) => new URL(x.url).pathname.split('/requests').at(-1)), ['/inbox', '/5/approval', '/5/cancel', '/5/remind', '/5/remind-managers', '/report', '/people']);
  assert.equal(calls[6]!.init.method, 'GET');
  assert.equal(new URL(calls[0]!.url).searchParams.get('limit'), '10');
  assert.deepEqual(calls.slice(1, 5).map((x) => JSON.parse(String(x.init.body))), [{ version: 2, decision: 'reject', reason: 'Neden' }, { version: 2 }, { version: 2 }, { version: 2 }]);
  for (const call of calls.slice(1, 5)) assert.equal(headerOf(call, 'Idempotency-Key'), KEY);
  assert.deepEqual(Object.fromEntries(new URL(calls[5]!.url).searchParams), { format: 'json', ...filters });
});

test('requests API: 409 VERSION_CONFLICT surfaces as a conflict the UI can refresh on', async () => {
  const f = scriptedFetch(json(409, ocs({ error: 'VERSION_CONFLICT', message: 'The request changed or was already handled; reload and try again.' }, 409, 'failure')));
  const c = new OcsClient({ serverBase: 'https://ex.com' as never, getCredentials: async () => ({ loginName: 'u', appPassword: 'p' }), fetch: f });
  await assert.rejects(requestsApi.resolve(c, 5, 1, 'x', KEY), (e: unknown) => e instanceof OcsError && e.kind === 'conflict');
});

test('backend gate: module disabled stops calls, but recipient conversion and server row permissions need no global manager preflight', async () => {
  {
    const { b, f, id } = await loggedIn(bootstrap(false));
    await assert.rejects(b.requestDetail(id, 5), (e: unknown) => e instanceof OcsError && e.errorCode === 'REQUESTS_DISABLED');
    await assert.rejects(b.requestPeople(id), (e: unknown) => e instanceof OcsError && e.errorCode === 'REQUESTS_DISABLED');
    assert.equal(f.calls.length, 3, 'only login + bootstrap');
  }
  {
    const { b, f, id } = await loggedIn(bootstrap(true), json(200, ocs(req({ state: 'converted' }))), json(404, ocs({ error: 'RESOURCE_NOT_FOUND' }, 404, 'failure')));
    await assert.rejects(b.requestDecide(id, 5, 2, 'reject', '  ', KEY), (e: unknown) => e instanceof OcsError && e.errorCode === 'REASON_REQUIRED');
    const r = await b.requestConvert(id, 5, 3, 11, 12, KEY);
    assert.equal(r?.state, 'converted');
    assert.match(f.calls.at(-1)!.url, /\/requests\/5\/convert/);
    await assert.rejects(b.requestResolve(id, 5, 3, 'neden', KEY), (e: unknown) => e instanceof OcsError && e.errorCode === 'RESOURCE_NOT_FOUND');
    assert.ok(!f.calls.some((x) => x.url.includes('/requests/context')));
  }
});

test('IPC validation: request actions and report filters', async () => {
  const b = createDirectBackend({ secrets: new Mem(), plain: new Mem(), fetch: scriptedFetch() });
  const filters = { scope: 'team', type: 'request', state: 'any', from: '2026-10-01', to: '2026-11-02' };
  assert.equal(isValidReportFilters(filters), true);
  assert.equal(isValidReportFilters({ ...filters, scope: 'everyone' }), false);
  assert.equal(isValidReportFilters({ ...filters, state: 'deleted' }), false);
  assert.equal(isValidReportFilters({ ...filters, person: 'alice', approval: 'waiting', state: 'withdrawn' }), true);
  assert.equal(isValidReportFilters({ ...filters, person: 4 }), false);
  assert.equal(isValidReportFilters({ ...filters, approval: 'open' }), false);
  assert.deepEqual(await dispatchWire(b, 'requestPage', ['acc', 'team', 'all', null]), BAD);
  assert.deepEqual(await dispatchWire(b, 'requestPage', ['acc', 'received', 'pending', 0]), BAD);
  assert.deepEqual(await dispatchWire(b, 'requestInbox', ['acc', 51]), BAD);
  assert.deepEqual(await dispatchWire(b, 'requestDecide', ['acc', 5, 2, 'reject', ' ', KEY]), BAD);
  assert.deepEqual(await dispatchWire(b, 'requestCancel', ['acc', 5, 2, 'x'.repeat(2001), KEY]), BAD);
  assert.deepEqual(await dispatchWire(b, 'requestRemind', ['acc', 5, -1, KEY]), BAD);
  assert.equal(isValidReportFilters({ ...filters, extra: 1 }), false, 'unknown field');
  assert.equal(isValidReportFilters({ ...filters, from: '2025-01-01' }), false, 'over 366 days');
  assert.deepEqual(await dispatchWire(b, 'requestRespond', ['acc', 5, 2, 'reject', '', KEY]), BAD, 'reject reason required');
  assert.deepEqual(await dispatchWire(b, 'requestRespond', ['acc', 5, 2, 'delete', null, KEY]), BAD);
  assert.deepEqual(await dispatchWire(b, 'requestResolve', ['acc', 5, 2, ' ', KEY]), BAD, 'resolve reason required');
  assert.deepEqual(await dispatchWire(b, 'requestConvert', ['acc', 5, 2, 0, 3, KEY]), BAD);
  assert.deepEqual(await dispatchWire(b, 'requestConvert', ['acc', 5, -1, 1, 3, KEY]), BAD, 'negative version');
  assert.deepEqual(await dispatchWire(b, 'requestHistory', ['acc', 5, 'x']), BAD);
  assert.deepEqual(await dispatchWire(b, 'requestReport', ['acc', { ...filters, to: '2026-09-01' }]), BAD);
  assert.deepEqual(await dispatchWire(b, 'requestPeople', ['acc', 'extra']), BAD);
  const people = await dispatchWire(b, 'requestPeople', ['acc']);
  assert.equal(people.ok === false && people.error.kind, 'unauthorized', 'valid call reaches the account check');
  const ok = await dispatchWire(b, 'requestConvert', ['acc', 5, 2, 1, 3, KEY]);
  assert.equal(ok.ok === false && ok.error.kind, 'unauthorized');
});
