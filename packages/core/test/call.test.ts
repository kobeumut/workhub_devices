import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALL_FLAG, callCapabilitiesOf, callGate, joinFlags, parseExternalFrame, parseInternalPull, parseSignalingSettings, signalingWebSocketUrl,
  startExternalSignaling, startInternalSignaling, type CallRoomGate, type WebSocketLike,
} from '../src/call';
import { createDirectBackend, dispatchWire, isValidPeerMessage, type PlainStore } from '../src/backend';
import { accountIdFor, scopedKey, type SecretStore } from '../src/accounts';
import { OcsClient, OcsError, type FetchLike } from '../src/ocs';
import { normalizeServerUrl } from '../src/serverUrl';
import { json, ocs } from './helpers';

const FEATURES = ['audio', 'video', 'signaling-v3', 'call-notification-state-api', 'silent-call', 'conversation-v4', 'chat-v2'];
const CAPS = callCapabilitiesOf(FEATURES, { enabled: true });
const ALL_PERMS = 2 | 4 | 16 | 32 | 64 | 128;
const room = (extra: Partial<CallRoomGate> = {}): CallRoomGate => ({ type: 2, readOnly: 0, participantType: 3, permissions: ALL_PERMS, canStartCall: true, hasCall: false, lobbyState: 0, ...extra });

test('call capabilities: config.call.enabled=false and missing features hide calls (fail closed)', () => {
  assert.equal(callCapabilitiesOf(FEATURES, { enabled: false }).enabled, false);
  assert.equal(callCapabilitiesOf([], undefined).enabled, false);
  assert.equal(callGate(room(), callCapabilitiesOf(FEATURES, { enabled: false })).reason, 'server_disabled');
  assert.equal(callGate(room(), callCapabilitiesOf(['audio', 'video'], { enabled: true })).reason, 'feature_missing');
  const ok = callGate(room(), CAPS);
  assert.deepEqual(ok, { available: true, reason: null, hasCall: false, canJoin: true, audio: true, video: true });
});

test('call gate: room type, read-only, lobby, start vs join permission, publish bits', () => {
  assert.equal(callGate(room({ type: 6 }), CAPS).reason, 'room_type'); // note to self
  assert.equal(callGate(room({ type: 4 }), CAPS).reason, 'room_type'); // changelog
  assert.equal(callGate(room({ type: 1 }), CAPS).available, true); // one-to-one
  assert.equal(callGate(room({ readOnly: 1 }), CAPS).reason, 'read_only');
  assert.equal(callGate(room({ lobbyState: 1 }), CAPS).reason, 'lobby');
  assert.equal(callGate(room({ lobbyState: 1, participantType: 1 }), CAPS).available, true); // moderator
  assert.equal(callGate(room({ lobbyState: 1, permissions: ALL_PERMS | 8 }), CAPS).available, true); // lobby ignore
  // no call running: needs canStartCall; running: needs CALL_JOIN
  assert.equal(callGate(room({ canStartCall: false }), CAPS).reason, 'no_permission');
  assert.equal(callGate(room({ canStartCall: false, hasCall: true }), CAPS).canJoin, true);
  assert.equal(callGate(room({ hasCall: true, permissions: ALL_PERMS & ~4 }), CAPS).reason, 'no_permission');
  { const { permissions: _p, ...noPerms } = room(); const g = callGate(noPerms, CAPS); assert.deepEqual([g.audio, g.video, callGate({ ...noPerms, hasCall: true }, CAPS).canJoin], [false, false, false]); }
  const noVideo = callGate(room({ permissions: ALL_PERMS & ~32 }), CAPS);
  assert.equal(noVideo.video, false);
  assert.equal(noVideo.audio, true);
  assert.equal(joinFlags(noVideo, { audio: true, video: true }), CALL_FLAG.inCall | CALL_FLAG.withAudio);
  assert.equal(joinFlags({ audio: true, video: true }, { audio: false, video: true }), CALL_FLAG.inCall | CALL_FLAG.withVideo);
});

test('signaling settings: internal/external, ICE servers validated, TURN keeps credentials', () => {
  const internal = parseSignalingSettings({
    signalingMode: 'internal', server: '', ticket: 't',
    stunservers: [{ urls: ['stun:stun.nextcloud.com:443'] }, { urls: ['http://evil'] }],
    turnservers: [{ urls: ['turn:turn.example.com:3478?transport=udp', 'javascript:x'], username: 'u', credential: 'c' }],
  });
  assert.equal(internal.mode, 'internal');
  assert.equal(internal.server, null);
  assert.deepEqual(internal.iceServers, [
    { urls: ['stun:stun.nextcloud.com:443'] },
    { urls: ['turn:turn.example.com:3478?transport=udp'], username: 'u', credential: 'c' },
  ]);
  const ext = parseSignalingSettings({ signalingMode: 'external', server: 'https://sig.example.com/standalone-signaling/', helloAuthParams: { '1.0': { userid: 'alice', ticket: 'tk' }, '2.0': { token: 'jwt' } } });
  assert.equal(ext.mode, 'external');
  assert.deepEqual(ext.helloV2, { token: 'jwt' });
  assert.deepEqual(ext.helloV1, { userid: 'alice', ticket: 'tk' });
  assert.equal(signalingWebSocketUrl(ext.server!), 'wss://sig.example.com/standalone-signaling/spreed');
  assert.equal(signalingWebSocketUrl('http://h:8080/spreed'), 'ws://h:8080/spreed');
  // external mode without a usable server URL falls back to internal
  assert.equal(parseSignalingSettings({ signalingMode: 'external', server: 'javascript:alert(1)' }).mode, 'internal');
});

test('internal pull + HPB frames normalise to the same events', () => {
  const ev = parseInternalPull([
    { type: 'usersInRoom', data: [{ userId: 'alice', sessionId: 'aaa', inCall: 7, lastPing: 1 }, { userId: '', sessionId: 'bad session' }] },
    { type: 'message', data: JSON.stringify({ from: 'bbb', to: 'aaa', type: 'offer', roomType: 'video', payload: { type: 'offer', sdp: 'v=0' } }) },
    { type: 'message', data: '{broken' },
  ]);
  assert.deepEqual(ev, [
    { type: 'participants', full: true, users: [{ sessionId: 'aaa', userId: 'alice', inCall: 7 }] },
    { type: 'message', from: 'bbb', data: { from: 'bbb', to: 'aaa', type: 'offer', roomType: 'video', payload: { type: 'offer', sdp: 'v=0' } } },
  ]);
  assert.deepEqual(parseExternalFrame({ type: 'event', event: { target: 'participants', type: 'update', update: { roomid: 'r', users: [{ sessionId: 's1', inCall: 3, userId: 'bob' }] } } }), [
    { type: 'participants', full: false, users: [{ sessionId: 's1', userId: 'bob', inCall: 3 }] },
  ]);
  assert.deepEqual(parseExternalFrame({ type: 'event', event: { target: 'participants', type: 'update', update: { all: true, incall: 0 } } }), [{ type: 'ended' }]);
  assert.deepEqual(parseExternalFrame({ type: 'event', event: { target: 'room', type: 'leave', leave: ['s1'] } }), [{ type: 'left', sessionIds: ['s1'] }]);
  assert.deepEqual(parseExternalFrame({ type: 'event', event: { target: 'room', type: 'join', join: [{ sessionid: 's2', userid: 'carol', user: { displayname: 'Carol' } }] } }), [
    { type: 'participants', full: false, users: [{ sessionId: 's2', userId: 'carol', inCall: 0, displayName: 'Carol' }] },
  ]);
  assert.deepEqual(parseExternalFrame({ type: 'message', message: { sender: { type: 'session', sessionid: 's3' }, data: { type: 'answer', payload: { sdp: 'x' } } } }), [
    { type: 'message', from: 's3', data: { type: 'answer', payload: { sdp: 'x' } } },
  ]);
  assert.deepEqual(parseExternalFrame({ type: 'bye', bye: {} }), [{ type: 'lost', reason: 'kicked' }]);
});

// ---- transports ----

interface Req { method: string; url: string; body: unknown }
/** Router fetch: the long-poll GET waits for scripted pull results; everything else answers immediately. */
function routerFetch(handlers: { pull: Array<Response | 'hang'>; other?: (r: Req) => Response }) {
  const reqs: Req[] = [];
  const fn: FetchLike = async (url, init) => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    reqs.push({ method, url, body });
    if (method === 'GET' && /\/signaling\/(?!settings)[a-z0-9]+\?/.test(url)) {
      const next = handlers.pull.shift() ?? 'hang';
      if (next === 'hang') {
        return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      return next;
    }
    if (handlers.other) return handlers.other({ method, url, body });
    if (url.includes('/participants/active') && method === 'POST') return json(200, ocs({ sessionId: 'sess-self' }));
    return json(200, ocs([]));
  };
  return { fn, reqs };
}
const clientWith = (fetch: FetchLike) =>
  new OcsClient({ serverBase: normalizeServerUrl('https://cloud.example.com'), getCredentials: async () => ({ loginName: 'alice', appPassword: 'pw' }), fetch });
const noSleep = async () => undefined;

test('internal signaling: joins the room, long-polls events, batches sends like the web client, leaves on close', async () => {
  const { fn, reqs } = routerFetch({
    pull: [json(200, ocs([{ type: 'usersInRoom', data: [{ userId: 'bob', sessionId: 'sess-bob', inCall: 3 }] }]))],
  });
  const sig = await startInternalSignaling(clientWith(fn), 'room1234', { batchMs: 0, sleep: noSleep });
  assert.equal(sig.sessionId, 'sess-self');
  assert.equal(sig.mode, 'internal');
  const ev = await sig.next(1000);
  assert.deepEqual(ev, [{ type: 'participants', full: true, users: [{ sessionId: 'sess-bob', userId: 'bob', inCall: 3 }] }]);
  await Promise.all([
    sig.send('sess-bob', { type: 'candidate', roomType: 'video', payload: { candidate: { candidate: 'c1' } } }),
    sig.send('sess-bob', { type: 'candidate', roomType: 'video', payload: { candidate: { candidate: 'c2' } } }),
  ]);
  const posts = reqs.filter((r) => r.method === 'POST' && /\/signaling\/room1234\?/.test(r.url));
  assert.equal(posts.length, 1, 'two messages, one POST');
  const messages = JSON.parse((posts[0]!.body as { messages: string }).messages) as Array<{ ev: string; fn: string; sessionId: string }>;
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.ev, 'message');
  assert.equal(messages[0]!.sessionId, 'sess-self');
  assert.deepEqual(JSON.parse(messages[0]!.fn), { type: 'candidate', roomType: 'video', payload: { candidate: { candidate: 'c1' } }, to: 'sess-bob' });
  await sig.close();
  assert.ok(reqs.some((r) => r.method === 'DELETE' && r.url.includes('/room/room1234/participants/active')));
  assert.deepEqual(await sig.next(10), []);
});

test('internal signaling: 404 → session lost, 409 → joined elsewhere; network errors retry with a hint', async () => {
  const lost = await startInternalSignaling(clientWith(routerFetch({ pull: [json(404, ocs(null, 404, 'failure'))] }).fn), 'room1234', { sleep: noSleep });
  assert.deepEqual(await lost.next(1000), [{ type: 'lost', reason: 'session' }]);
  await lost.close();
  const conflict = await startInternalSignaling(clientWith(routerFetch({ pull: [json(409, ocs(null, 409, 'failure'))] }).fn), 'room1234', { sleep: noSleep });
  assert.deepEqual(await conflict.next(1000), [{ type: 'lost', reason: 'conflict' }]);
  await conflict.close();
  const flaky = await startInternalSignaling(clientWith(routerFetch({ pull: [json(503, {}), json(200, ocs([]))] }).fn), 'room1234', { sleep: noSleep });
  const seen = [...(await flaky.next(1000)), ...(await flaky.next(50))];
  assert.deepEqual(seen, [{ type: 'network', ok: false }, { type: 'network', ok: true }]);
  await flaky.close();
});

class FakeSocket implements WebSocketLike {
  static last: FakeSocket;
  readyState = 0;
  sent: Array<Record<string, any>> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string, private readonly reply: (m: Record<string, any>, s: FakeSocket) => void) {
    FakeSocket.last = this;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 0);
  }
  send(data: string) {
    const m = JSON.parse(data) as Record<string, any>;
    this.sent.push(m);
    setTimeout(() => this.reply(m, this), 0);
  }
  close() {
    this.readyState = 3;
  }
  push(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

test('external signaling (HPB): hello v2 → Nextcloud session → room; messages and events flow', async () => {
  const { fn, reqs } = routerFetch({ pull: [] });
  const settings = parseSignalingSettings({ signalingMode: 'external', server: 'https://sig.example.com', helloAuthParams: { '2.0': { token: 'jwt' } } });
  const sig = await startExternalSignaling(clientWith(fn), 'room1234', settings, {
    webSocket: (url) => new FakeSocket(url, (m, s) => {
      if (m.type === 'hello') s.push({ id: m.id, type: 'hello', hello: { sessionid: 'sig-self', resumeid: 'r1', server: { features: ['mcu'] } } });
      if (m.type === 'room') s.push({ id: m.id, type: 'room', room: { roomid: 'room1234' } });
    }),
  });
  const sock = FakeSocket.last;
  assert.equal(sock.url, 'wss://sig.example.com/spreed');
  assert.deepEqual(sock.sent[0]!.hello, { version: '2.0', auth: { url: 'https://cloud.example.com/ocs/v2.php/apps/spreed/api/v3/signaling/backend', params: { token: 'jwt' } } });
  assert.deepEqual(sock.sent[1]!.room, { roomid: 'room1234', sessionid: 'sess-self' }, 'room join carries the NEXTCLOUD session');
  assert.equal(sig.sessionId, 'sig-self');
  assert.equal(sig.mcu, true);
  assert.ok(reqs.some((r) => r.method === 'POST' && r.url.includes('/participants/active')));
  await sig.send('sig-bob', { type: 'requestoffer', roomType: 'video' });
  assert.deepEqual(sock.sent[2], { type: 'message', message: { recipient: { type: 'session', sessionid: 'sig-bob' }, data: { type: 'requestoffer', roomType: 'video', to: 'sig-bob' } } });
  sock.push({ type: 'event', event: { target: 'participants', type: 'update', update: { users: [{ sessionId: 'sig-bob', inCall: 7, userId: 'bob' }] } } });
  sock.push({ type: 'error', error: { code: 'no_such_session' } });
  assert.deepEqual(await sig.next(100), [
    { type: 'participants', full: false, users: [{ sessionId: 'sig-bob', userId: 'bob', inCall: 7 }] },
    { type: 'lost', reason: 'session' },
  ]);
  await sig.close();
  assert.equal(sock.sent.at(-1)!.type, 'bye');
});

test('external signaling: a failed hello does not leave a Nextcloud session behind', async () => {
  const { fn, reqs } = routerFetch({ pull: [] });
  const settings = parseSignalingSettings({ signalingMode: 'external', server: 'https://sig.example.com', helloAuthParams: { '1.0': { userid: 'alice', ticket: 't' } } });
  await assert.rejects(
    startExternalSignaling(clientWith(fn), 'room1234', settings, {
      webSocket: (url) => new FakeSocket(url, (m, s) => s.push({ id: m.id, type: 'error', error: { code: 'invalid_token', message: 'x' } })),
    }),
    (e: unknown) => e instanceof OcsError && e.errorCode === 'invalid_token',
  );
  assert.equal(FakeSocket.last.sent[0]!.hello.version, '1.0');
  assert.equal(reqs.length, 0);
});

// ---- backend gates + wire ----

function memStores(): { secrets: SecretStore; plain: PlainStore } {
  const m = new Map<string, string>();
  return {
    secrets: { get: async (k) => m.get(`s:${k}`) ?? null, set: async (k, v) => void m.set(`s:${k}`, v), delete: async (k) => void m.delete(`s:${k}`) },
    plain: {
      get: async (k) => m.get(`p:${k}`) ?? null, set: async (k, v) => void m.set(`p:${k}`, v), delete: async (k) => void m.delete(`p:${k}`),
      deletePrefix: async (p) => { for (const k of [...m.keys()]) if (k.startsWith(`p:${p}`)) m.delete(k); },
    },
  };
}

async function backendWith(roomDto: Record<string, unknown>, callConfig: Record<string, unknown> = { enabled: true }) {
  const stores = memStores();
  const serverBase = normalizeServerUrl('https://cloud.example.com');
  const accId = accountIdFor(serverBase, 'alice');
  await stores.plain.set('accounts:v1', JSON.stringify([{ id: accId, serverBase, loginName: 'alice' }]));
  await stores.secrets.set(scopedKey(accId, 'app-password'), 'pw');
  const { fn, reqs } = routerFetch({
    pull: [json(200, ocs([{ type: 'usersInRoom', data: [{ userId: 'alice', sessionId: 'sess-self', inCall: 3 }] }]))],
    other: (r) => {
      if (r.url.includes('/cloud/capabilities')) return json(200, ocs({ version: { major: 32 }, capabilities: { spreed: { features: FEATURES, config: { call: callConfig } } } }));
      if (r.url.includes('/signaling/settings')) return json(200, ocs({ signalingMode: 'internal', stunservers: [{ urls: ['stun:s:3478'] }], turnservers: [] }));
      if (r.url.includes('/participants/active') && r.method === 'POST') return json(200, ocs({ sessionId: 'sess-self' }));
      if (/\/api\/v4\/room\/room1234\?/.test(r.url)) return json(200, ocs({ token: 'room1234', ...roomDto }));
      if (r.url.includes('/notification-state')) return json(201, ocs(null, 201));
      return json(200, ocs([]));
    },
  });
  const backend = createDirectBackend({ ...stores, fetch: fn });
  const id = (await backend.listAccounts())[0]!.id;
  return { backend, reqs, id };
}

test('backend callJoin: fails closed on the fresh room gate and server capability', async () => {
  const noStart = await backendWith({ type: 2, readOnly: 0, participantType: 3, permissions: ALL_PERMS, canStartCall: false, hasCall: false });
  await assert.rejects(noStart.backend.callJoin(noStart.id, 'room1234', { audio: true, video: true }, false), (e: unknown) => e instanceof OcsError && e.errorCode === 'CALL_NO_PERMISSION');
  assert.ok(!noStart.reqs.some((r) => r.url.includes('/api/v4/call/')), 'no call request sent');
  const disabled = await backendWith({ type: 2, readOnly: 0, permissions: ALL_PERMS, canStartCall: true }, { enabled: false });
  await assert.rejects(disabled.backend.callJoin(disabled.id, 'room1234', { audio: true, video: false }, false), (e: unknown) => e instanceof OcsError && e.errorCode === 'CALL_SERVER_DISABLED');
  const session = await disabled.backend.session(disabled.id);
  assert.equal(session.talkCall.enabled, false);
});

test('backend call lifecycle: join with permitted flags, events, send, leave', async () => {
  const { backend, reqs, id } = await backendWith({ type: 1, readOnly: 0, participantType: 1, permissions: ALL_PERMS & ~32, canStartCall: true, hasCall: false });
  const j = await backend.callJoin(id, 'room1234', { audio: true, video: true }, false);
  assert.equal(j.mode, 'mesh');
  assert.equal(j.sessionId, 'sess-self');
  assert.equal(j.flags, CALL_FLAG.inCall | CALL_FLAG.withAudio, 'video dropped: no publish-video permission');
  assert.deepEqual(j.iceServers, [{ urls: ['stun:s:3478'] }]);
  const join = reqs.find((r) => r.method === 'POST' && r.url.includes('/api/v4/call/room1234'));
  assert.deepEqual(join?.body, { flags: 3 });
  const ev = await backend.callEvents(j.callId, 1000);
  assert.equal(ev[0]?.type, 'participants');
  await backend.callSend(j.callId, 'sess-bob', { type: 'mute', roomType: 'video', payload: { name: 'audio' } });
  assert.equal(await backend.callRinging(id, 'room1234'), false);
  await backend.callLeave(j.callId, false);
  assert.ok(reqs.some((r) => r.method === 'DELETE' && r.url.includes('/api/v4/call/room1234')));
  assert.ok(reqs.some((r) => r.method === 'DELETE' && r.url.includes('/participants/active')));
  await assert.rejects(backend.callEvents(j.callId, 10), (e: unknown) => e instanceof OcsError && e.errorCode === 'CALL_NOT_FOUND');
});

test('wire: call arguments are validated (renderer cannot send arbitrary signaling)', async () => {
  assert.equal(isValidPeerMessage({ type: 'offer', roomType: 'video', sid: '123', payload: { type: 'offer', sdp: 'v=0' } }), true);
  assert.equal(isValidPeerMessage({ type: 'control', payload: {} }), false);
  assert.equal(isValidPeerMessage({ type: 'offer', to: 'someone-else', payload: {} }), false, 'no extra keys (to is set by main)');
  assert.equal(isValidPeerMessage({ type: 'candidate', payload: 'x' }), false);
  assert.equal(isValidPeerMessage({ type: 'offer', payload: { sdp: 'x'.repeat(300_000) } }), false);
  const fake = {} as never;
  for (const [m, args] of [
    ['callJoin', ['acc', 'room1234', { audio: true }, false]],
    ['callJoin', ['acc', '../x', { audio: true, video: true }, false]],
    ['callEvents', ['call-x-1', 60_000]],
    ['callSend', ['not a call id', 's', { type: 'offer' }]],
    ['callLeave', ['call-abc-1']],
  ] as const) {
    assert.deepEqual(await dispatchWire(fake, m, args), { ok: false, error: { kind: 'client', message: 'invalid arguments' } }, m);
  }
});
