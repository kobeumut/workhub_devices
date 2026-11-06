import test from 'node:test';
import assert from 'node:assert/strict';
import { presenceLabel, readMarker, unreadTotal, watchTalk } from '../src/talkSync';
import type { RoomListResult, TalkRoom } from '../src/talk';
import { OcsError } from '../src/ocs';

const room = (token: string, unreadMessages: number) => ({ token, unreadMessages }) as TalkRoom;
const page = (...rooms: TalkRoom[]): RoomListResult => ({ rooms, modifiedBefore: 1, talkHash: null });
const fail = (e: unknown) => { throw e; };
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test('server snapshots reconcile reads, other rooms, own messages and duplicate events without arithmetic', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const snapshots = [page(room('one', 1), room('two', 4)), page(room('one', 1), room('two', 4)), page(room('one', 0), room('two', 4)), page(room('one', 0))];
  const totals: number[] = [];
  const s = watchTalk({ rooms: async () => snapshots.shift()!, heartbeat: async () => false,
    onRooms: (rs) => totals.push(unreadTotal(rs)), onError: fail, onPresenceError: (e) => { if (e) fail(e); } });
  t.after(s.stop);
  await flush();
  for (let n = 0; n < 3; n++) { t.mock.timers.tick(5000); await flush(); }
  assert.deepEqual(totals, [5, 5, 4, 0]);
  assert.equal(unreadTotal([room('bad', -1), room('nan', NaN), room('good', 2)]), 2);
});

test('refresh during an in-flight snapshot serializes and discards stale unread response', async (t) => {
  const old = deferred<RoomListResult>();
  const totals: number[] = [];
  let calls = 0;
  const s = watchTalk({ rooms: () => ++calls === 1 ? old.promise : Promise.resolve(page(room('a', 0))),
    heartbeat: async () => false, onRooms: (rs) => totals.push(unreadTotal(rs)), onError: fail, onPresenceError: (e) => { if (e) fail(e); } });
  t.after(s.stop);
  s.refresh(); s.refresh();
  assert.equal(calls, 1);
  old.resolve(page(room('a', 3)));
  await flush();
  assert.equal(calls, 2);
  assert.deepEqual(totals, [0]);
});

test('background/account switch/log out fences late results and stops heartbeats; resume starts immediately', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred<RoomListResult>();
  const seen: number[] = [];
  let beats = 0;
  let requests = 0;
  const old = watchTalk({ rooms: () => { requests++; return pending.promise; }, heartbeat: async () => { beats++; return true; },
    onRooms: () => fail('stale account'), onError: fail, onPresenceError: (e) => { if (e) fail(e); } });
  old.stop();
  pending.resolve(page(room('old', 20)));
  await flush();
  t.mock.timers.tick(120_000); await flush();
  assert.equal(requests, 1); assert.equal(beats, 1);
  const resumed = watchTalk({ rooms: async () => page(room('new', 2)), heartbeat: async () => { beats++; return true; },
    onRooms: (rs) => seen.push(unreadTotal(rs)), onError: fail, onPresenceError: (e) => { if (e) fail(e); } });
  t.after(resumed.stop);
  await flush();
  assert.deepEqual(seen, [2]);
  assert.equal(beats, 2);
  t.mock.timers.tick(60_000); await flush();
  assert.equal(beats, 3);
});

test('network failure keeps loop alive for reconciliation without inventing presence', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempt = 0;
  let errors = 0;
  const totals: number[] = [];
  const s = watchTalk({ rooms: async () => { if (!attempt++) throw new Error('offline'); return page(room('r', 3)); },
    heartbeat: async () => false, onRooms: (rs) => totals.push(unreadTotal(rs)), onError: () => { errors++; }, onPresenceError: (e) => { if (e) fail(e); } });
  t.after(s.stop);
  await flush(); t.mock.timers.tick(5000); await flush();
  assert.equal(errors, 1); assert.deepEqual(totals, [3]);
  assert.equal(presenceLabel(undefined), 'Durum bilinmiyor');
  assert.equal(presenceLabel('future-status'), 'Durum bilinmiyor');
  assert.equal(presenceLabel('invisible'), 'Çevrimdışı');
  assert.equal(presenceLabel('dnd'), 'Rahatsız etmeyin');
  assert.equal(presenceLabel('online'), 'Çevrimiçi');
});

test('room and activity retries honor server Retry-After and clear recovered presence errors', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let rooms = 0; let beats = 0;
  const errors: unknown[] = [];
  const s = watchTalk({ rooms: async () => { if (!rooms++) throw new OcsError('rate_limited', 429, 'wait', 120_000); return page(); },
    heartbeat: async () => { if (!beats++) throw new OcsError('rate_limited', 429, 'wait', 120_000); return true; },
    onRooms: () => {}, onError: () => {}, onPresenceError: (e) => errors.push(e) });
  t.after(s.stop);
  await flush();
  s.refresh(); s.refresh(); await flush();
  t.mock.timers.tick(119_999); await flush();
  assert.equal(rooms, 1); assert.equal(beats, 1);
  t.mock.timers.tick(1); await flush();
  assert.equal(rooms, 2); assert.equal(beats, 2);
  assert.equal(errors.length, 2); assert.equal(errors[1], undefined);
});

test('visible read markers are monotonic, coalesced and retried on failure; stopped marker is inert', async () => {
  const sent: number[] = [];
  const pending = deferred<void>();
  let reads = 0;
  const m = readMarker(async (id) => { sent.push(id); if (id === 5) await pending.promise; }, () => { reads++; }, fail);
  m.read(0); m.read(5); m.read(5); m.read(9); m.read(3);
  assert.deepEqual(sent, [5]);
  pending.resolve(); await flush();
  assert.deepEqual(sent, [5, 9]); assert.equal(reads, 2);
  m.read(9); m.stop(); m.read(10); await flush();
  assert.deepEqual(sent, [5, 9]);
  let tries = 0;
  const retry = readMarker(async () => { if (!tries++) throw new Error('network'); }, () => { reads++; }, () => {});
  retry.read(12); await flush(); retry.read(12); await flush();
  assert.equal(tries, 2); assert.equal(reads, 3); retry.stop();
});

test('repeated visible read attempts respect Retry-After before retrying', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  let calls = 0;
  const m = readMarker(async () => { if (!calls++) throw new OcsError('rate_limited', 429, 'wait', 120_000); }, () => {}, () => {});
  t.after(m.stop);
  m.read(5); await flush(); m.read(9); await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(120_000); m.read(9); await flush();
  assert.equal(calls, 2);
});

test('stopping while a read is in flight prevents queued writes and late callbacks', async () => {
  const pending = deferred<void>();
  const sent: number[] = [];
  const m = readMarker(async (id) => { sent.push(id); await pending.promise; }, () => fail('late read'), fail);
  m.read(1); m.read(2); m.stop(); pending.resolve(); await flush();
  assert.deepEqual(sent, [1]);
});
