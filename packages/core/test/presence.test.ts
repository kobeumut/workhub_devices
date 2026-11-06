import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectBackend, dispatchWire, type PlainStore } from '../src/backend';
import type { SecretStore } from '../src/accounts';
import { OcsError } from '../src/ocs';
import { parseServerCapabilities } from '../src/capabilities';
import { talkRoomApi } from '../src/talk';
import { json, ocs, scriptedFetch } from './helpers';

class Mem implements SecretStore, PlainStore {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
  async deletePrefix(p: string) { for (const k of this.m.keys()) if (k.startsWith(p)) this.m.delete(k); }
}
const caps = (enabled = true, features = ['chat-read-marker', 'chat-keep-notifications']) => ({
  version: { major: 35 }, capabilities: { user_status: { enabled }, spreed: { features } },
});
async function setup(...responses: Parameters<typeof scriptedFetch>) {
  const f = scriptedFetch(
    json(200, { login: 'https://ex.com/index.php/login/v2/flow/x', poll: { token: 't', endpoint: 'https://ex.com/index.php/login/v2/poll' } }),
    json(200, { server: 'https://ex.com', loginName: 'alice', appPassword: 'test-only' }),
    ...responses,
  );
  const b = createDirectBackend({ secrets: new Mem(), plain: new Mem(), fetch: f });
  const { flowId } = await b.beginLogin('ex.com');
  const a = await b.completeLogin(flowId);
  return { b, a, f };
}

test('user-status capability is explicit and fail closed', () => {
  assert.equal(parseServerCapabilities({}).userStatus, false);
  assert.equal(parseServerCapabilities(caps(false)).userStatus, false);
  assert.equal(parseServerCapabilities(caps()).userStatus, true);
});

test('heartbeat uses activity endpoint, accepts 200/204, never writes persistent status or offline', async () => {
  const { b, a, f } = await setup(json(200, ocs(caps())), new Response(null, { status: 204 }), json(200, ocs({ status: 'dnd' })));
  assert.equal(await b.heartbeat(a.id), true);
  assert.equal(await b.heartbeat(a.id), true);
  for (const c of f.calls.slice(3)) {
    assert.ok(c.url.includes('/apps/user_status/api/v1/heartbeat'));
    assert.equal(c.init.method, 'PUT');
    assert.deepEqual(JSON.parse(String(c.init.body)), { status: 'online' });
  }
  assert.equal(f.calls.length, 5);
});

test('unsupported presence makes no heartbeat write, 404 downgrades, auth failure is surfaced', async () => {
  const off = await setup(json(200, ocs(caps(false))));
  assert.equal(await off.b.heartbeat(off.a.id), false); assert.equal(off.f.calls.length, 3);
  const missing = await setup(json(200, ocs(caps())), json(404, ocs([])));
  assert.equal(await missing.b.heartbeat(missing.a.id), false);
  const denied = await setup(json(200, ocs(caps())), json(401, ocs([])));
  await assert.rejects(denied.b.heartbeat(denied.a.id), (e: unknown) => e instanceof OcsError && e.kind === 'unauthorized');
});

test('wire heartbeat rejects extra status/foreign arguments; account authorization still applies', async () => {
  const b = createDirectBackend({ secrets: new Mem(), plain: new Mem(), fetch: scriptedFetch() });
  const bad = { ok: false, error: { kind: 'client', message: 'invalid arguments' } };
  for (const args of [[], ['acc', 'offline'], [null], [{ accountId: 'acc' }]]) assert.deepEqual(await dispatchWire(b, 'heartbeat', args), bad);
  const valid = await dispatchWire(b, 'heartbeat', ['missing']);
  assert.equal(valid.ok === false && valid.error.kind, 'unauthorized');
});

test('passive chat does not read notifications or update presence; explicit read is capability gated', async () => {
  const { b, a, f } = await setup(json(200, ocs(caps())), json(200, ocs([])), json(200, ocs([])));
  await b.chat(a.id, 'abc', { lookIntoFuture: false });
  const url = new URL(f.calls[3]!.url);
  assert.equal(url.searchParams.get('setReadMarker'), '0');
  assert.equal(url.searchParams.get('markNotificationsAsRead'), '0');
  assert.equal(url.searchParams.get('noStatusUpdate'), '1');
  await b.markRead(a.id, 'abc', 17);
  assert.deepEqual(JSON.parse(String(f.calls[4]!.init.body)), { lastReadMessage: 17 });
  const off = await setup(json(200, ocs(caps(true, []))), json(200, ocs([])));
  await off.b.chat(off.a.id, 'abc', { lookIntoFuture: false });
  assert.equal(new URL(off.f.calls[3]!.url).searchParams.has('markNotificationsAsRead'), false);
  await assert.rejects(off.b.markRead(off.a.id, 'abc', 1), (e: unknown) => e instanceof OcsError && e.errorCode === 'TALK_FEATURE_MISSING');
  assert.equal(off.f.calls.length, 4);
});

test('read writes serialize across view lifetimes and never lower a confirmed room marker', async () => {
  let started!: () => void; let release!: (r: Response) => void;
  const begun = new Promise<void>((r) => { started = r; });
  const pending = new Promise<Response>((r) => { release = r; });
  const { b, a, f } = await setup(json(200, ocs(caps())), () => { started(); return pending; }, json(200, ocs([])));
  const oldView = b.markRead(a.id, 'abc', 100);
  await begun;
  const resumedView = b.markRead(a.id, 'abc', 101);
  const oldHistory = b.markRead(a.id, 'abc', 99);
  await Promise.resolve(); assert.equal(f.calls.length, 4);
  release(json(200, ocs([])));
  await Promise.all([oldView, resumedView, oldHistory]);
  await b.markRead(a.id, 'abc', 1);
  assert.deepEqual(f.calls.slice(3).map((c) => JSON.parse(String(c.init.body)).lastReadMessage), [100, 101]);
});

test('participant status is requested and missing status is not synthesized from lastPing', async () => {
  const { OcsClient } = await import('../src/ocs');
  const f = scriptedFetch(json(200, ocs([
    { attendeeId: 1, actorType: 'users', actorId: 'bob', participantType: 3, status: 'online' },
    { attendeeId: 2, actorType: 'users', actorId: 'carol', participantType: 3, lastPing: Date.now() },
  ])));
  const client = new OcsClient({ serverBase: 'https://ex.com' as never, getCredentials: async () => ({ loginName: 'a', appPassword: 'test' }), fetch: f });
  const participants = await talkRoomApi.participants(client, 'abc');
  assert.equal(new URL(f.calls[0]!.url).searchParams.get('includeStatus'), '1');
  assert.equal(participants[0]!.status, 'online'); assert.equal(participants[1]!.status, undefined);
});
