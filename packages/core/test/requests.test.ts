import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectBackend, dispatchWire, isValidReportFilters, type PlainStore } from '../src/backend';
import type { SecretStore } from '../src/accounts';
import { OcsClient, OcsError } from '../src/ocs';
import { requestActions, requestsApi, type WorkRequest } from '../src/workhub';
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
const context = (isManager: boolean) => json(200, ocs({ uid: 'ali', manager: null, managers: [], isManager }));

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
  id: 5, version: 2, title: 'Yeni laptop', description: '', requesterUid: 'carol', requesterName: 'Carol', recipientName: 'Alice', managerName: 'Bob',
  canManage: false, canRespond: false, rejectionReason: null, respondedAt: null, state: 'pending', taskState: null, createdAt: '2026-11-02T10:00:00+00:00',
  convertedAt: null, resolvedAt: null, taskClosedAt: null, checkedAt: null, card: null, cardRestricted: false, ...over,
});

test('request actions come only from server flags and the state machine', () => {
  assert.deepEqual(requestActions(req({ canRespond: true })), { respond: true, resolve: false, convert: false });
  assert.deepEqual(requestActions(req({ canRespond: true, state: 'open' })), { respond: false, resolve: false, convert: false }, 'respond only while pending');
  assert.deepEqual(requestActions(req({ canManage: true, state: 'open' })), { respond: false, resolve: true, convert: true });
  for (const state of ['pending', 'rejected', 'converted', 'resolved'] as const) {
    assert.deepEqual(requestActions(req({ canManage: true, state })), { respond: false, resolve: false, convert: false }, state);
  }
  assert.deepEqual(requestActions(req({ state: 'open' })), { respond: false, resolve: false, convert: false }, 'non-manager sees nothing');
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

test('requests API: 409 VERSION_CONFLICT surfaces as a conflict the UI can refresh on', async () => {
  const f = scriptedFetch(json(409, ocs({ error: 'VERSION_CONFLICT', message: 'The request changed or was already handled; reload and try again.' }, 409, 'failure')));
  const c = new OcsClient({ serverBase: 'https://ex.com' as never, getCredentials: async () => ({ loginName: 'u', appPassword: 'p' }), fetch: f });
  await assert.rejects(requestsApi.resolve(c, 5, 1, 'x', KEY), (e: unknown) => e instanceof OcsError && e.kind === 'conflict');
});

test('backend gate: requests off → 403 without API call; resolve/convert need isManager; reasons required', async () => {
  {
    const { b, f, id } = await loggedIn(bootstrap(false));
    await assert.rejects(b.requestDetail(id, 5), (e: unknown) => e instanceof OcsError && e.errorCode === 'REQUESTS_DISABLED');
    assert.equal(f.calls.length, 3, 'only login + bootstrap');
  }
  {
    const { b, f, id } = await loggedIn(bootstrap(true), context(false), json(200, ocs(req({ canRespond: true }))));
    await assert.rejects(b.requestResolve(id, 5, 2, 'neden', KEY), (e: unknown) => e instanceof OcsError && e.errorCode === 'REQUEST_MANAGER_REQUIRED');
    await assert.rejects(b.requestConvert(id, 5, 2, 1, 2, KEY), (e: unknown) => e instanceof OcsError && e.errorCode === 'REQUEST_MANAGER_REQUIRED');
    assert.equal(f.calls.filter((x) => x.url.includes('/requests/context')).length, 1, 'context cached');
    await assert.rejects(b.requestRespond(id, 5, 2, 'reject', '  ', KEY), (e: unknown) => e instanceof OcsError && e.errorCode === 'REASON_REQUIRED');
    // The recipient may still respond: the server decides who the recipient is.
    const r = await b.requestRespond(id, 5, 2, 'approve', ' ', KEY);
    assert.equal(r?.id, 5);
    assert.deepEqual(JSON.parse(String(f.calls.at(-1)!.init.body)), { version: 2, decision: 'approve' });
    assert.ok(!f.calls.some((x) => /\/(resolve|convert)/.test(x.url)), 'manager writes never sent');
  }
  {
    const { b, f, id } = await loggedIn(bootstrap(true), context(true), json(200, ocs(req({ state: 'converted' }))));
    const r = await b.requestConvert(id, 5, 3, 11, 12, KEY);
    assert.equal(r?.state, 'converted');
    assert.match(f.calls.at(-1)!.url, /\/requests\/5\/convert/);
  }
});

test('IPC validation: request actions and report filters', async () => {
  const b = createDirectBackend({ secrets: new Mem(), plain: new Mem(), fetch: scriptedFetch() });
  const filters = { scope: 'team', type: 'request', state: 'any', from: '2026-10-01', to: '2026-11-02' };
  assert.equal(isValidReportFilters(filters), true);
  assert.equal(isValidReportFilters({ ...filters, scope: 'everyone' }), false);
  assert.equal(isValidReportFilters({ ...filters, state: 'deleted' }), false);
  assert.equal(isValidReportFilters({ ...filters, extra: 1 }), false, 'unknown field');
  assert.equal(isValidReportFilters({ ...filters, from: '2025-01-01' }), false, 'over 366 days');
  assert.deepEqual(await dispatchWire(b, 'requestRespond', ['acc', 5, 2, 'reject', '', KEY]), BAD, 'reject reason required');
  assert.deepEqual(await dispatchWire(b, 'requestRespond', ['acc', 5, 2, 'delete', null, KEY]), BAD);
  assert.deepEqual(await dispatchWire(b, 'requestResolve', ['acc', 5, 2, ' ', KEY]), BAD, 'resolve reason required');
  assert.deepEqual(await dispatchWire(b, 'requestConvert', ['acc', 5, 2, 0, 3, KEY]), BAD);
  assert.deepEqual(await dispatchWire(b, 'requestConvert', ['acc', 5, -1, 1, 3, KEY]), BAD, 'negative version');
  assert.deepEqual(await dispatchWire(b, 'requestHistory', ['acc', 5, 'x']), BAD);
  assert.deepEqual(await dispatchWire(b, 'requestReport', ['acc', { ...filters, to: '2026-09-01' }]), BAD);
  const ok = await dispatchWire(b, 'requestConvert', ['acc', 5, 2, 1, 3, KEY]);
  assert.equal(ok.ok === false && ok.error.kind, 'unauthorized');
});
