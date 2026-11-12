import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertRoomToken, classifySendFailure, fetchChat, lastServerId, mergeRooms, mergeTimeline, newReferenceId,
  reconnectDelay, renderMessageSegments, sendMessage, setPendingState, type ChatItem, type TalkMessage, type TalkRoom,
} from '../src/talk';
import { OcsClient, OcsError } from '../src/ocs';
import { normalizeServerUrl } from '../src/serverUrl';
import { json, ocs, scriptedFetch } from './helpers';

const msg = (id: number, extra: Partial<TalkMessage> = {}): TalkMessage => ({
  id, token: 'abc', actorType: 'users', actorId: 'u', actorDisplayName: 'U', timestamp: id, message: `m${id}`,
  messageParameters: [], systemMessage: '', messageType: 'comment', ...extra,
});
const client = (f: ReturnType<typeof scriptedFetch>) =>
  new OcsClient({ serverBase: normalizeServerUrl('https://example.com'), getCredentials: async () => ({ loginName: 'a', appPassword: 'b' }), fetch: f });

test('timeline merge dedupes overlapping pages and orders by id', () => {
  let t: ChatItem[] = mergeTimeline([], [msg(3), msg(1), msg(2)]);
  t = mergeTimeline(t, [msg(2), msg(3), msg(4)]);
  assert.deepEqual(t.map((i) => (i.kind === 'server' ? i.message.id : -1)), [1, 2, 3, 4]);
  assert.equal(lastServerId(t), 4);
});

test('a lost send is reconciled by referenceId from the poll, not duplicated', () => {
  const ref = 'r'.repeat(64);
  let t: ChatItem[] = mergeTimeline([], [msg(1)]);
  t = [...t, { kind: 'pending', referenceId: ref, text: 'selam', state: 'sending', createdAt: 1 }];
  t = setPendingState(t, ref, classifySendFailure(new OcsError('timeout')));
  assert.equal(t[1]?.kind === 'pending' && t[1].state, 'unknown');
  t = mergeTimeline(t, [msg(2, { referenceId: ref, message: 'selam' })]);
  assert.equal(t.length, 2);
  assert.ok(t.every((i) => i.kind === 'server'));
});

test('send failure classification: only definite rejections offer plain retry', () => {
  assert.equal(classifySendFailure(new OcsError('forbidden', 403)), 'failed');
  assert.equal(classifySendFailure(new OcsError('client', 400)), 'failed');
  assert.equal(classifySendFailure(new OcsError('network')), 'unknown');
  assert.equal(classifySendFailure(new OcsError('server', 503)), 'unknown');
  assert.equal(classifySendFailure(new Error('?')), 'unknown');
});

test('room list: full replaces (removals), delta upserts; favourites first', () => {
  const r = (token: string, lastActivity: number, isFavorite = false) => ({ token, lastActivity, isFavorite }) as TalkRoom;
  const full = mergeRooms([], [r('a', 1), r('b', 5), r('c', 3, true)], 'full');
  assert.deepEqual(full.map((x) => x.token), ['c', 'b', 'a']);
  assert.deepEqual(mergeRooms(full, [r('a', 9)], 'delta').map((x) => x.token), ['c', 'a', 'b']);
  assert.deepEqual(mergeRooms(full, [r('a', 9)], 'full').map((x) => x.token), ['a']);
});

test('fetchChat never moves the read marker passively and handles 304', async () => {
  const f = scriptedFetch(json(200, ocs([msg(5)]), { 'X-Chat-Last-Given': '5' }), json(304, null));
  const c = client(f);
  const r = await fetchChat(c, 'abc', { lookIntoFuture: false, limit: 500 });
  assert.equal(r.lastGiven, 5);
  const q = new URL(f.calls[0]!.url).searchParams;
  assert.equal(q.get('setReadMarker'), '0');
  assert.equal(q.get('lookIntoFuture'), '0');
  assert.equal(q.get('limit'), '200');
  assert.equal(q.get('timeout'), null);
  const r2 = await fetchChat(c, 'abc', { lookIntoFuture: true, lastKnownMessageId: 5, timeout: 120 });
  assert.deepEqual(r2, { messages: [], lastGiven: null, notModified: true });
  assert.equal(new URL(f.calls[1]!.url).searchParams.get('timeout'), '60');
});

test('room tokens are validated before entering a URL path', async () => {
  assert.throws(() => assertRoomToken('../admin'));
  assert.throws(() => assertRoomToken('abc/def'));
  await assert.rejects(sendMessage(client(scriptedFetch()), 'a?b', { message: 'x' }));
  const f = scriptedFetch(json(201, ocs(msg(9))));
  const m = await sendMessage(client(f), 'abc', { message: 'x', referenceId: 'r' });
  assert.equal(m?.id, 9);
  assert.equal(f.calls[0]!.init.body, '{"message":"x","referenceId":"r"}');
});

test('referenceId is 64 hex chars', () => {
  assert.match(newReferenceId(), /^[0-9a-f]{64}$/);
});

test('rich message rendering produces typed segments, never HTML', () => {
  const segs = renderMessageSegments('<b>Hi</b> {mention-user1} see {file} {unknown} {x}', {
    'mention-user1': { type: 'user', id: 'ali', name: 'Ali <script>' },
    file: { type: 'file', id: '12', name: 'rapor.pdf', link: 'javascript:alert(1)' },
    x: { type: 'deck-card', id: '1', name: 'Kart' },
  });
  assert.deepEqual(segs, [
    { type: 'text', text: '<b>Hi</b> ' },
    { type: 'mention', text: '@Ali <script>', mentionType: 'user', id: 'ali' },
    { type: 'text', text: ' see ' },
    { type: 'file', text: 'rapor.pdf', id: '12' },
    { type: 'text', text: ' {unknown} ' },
    { type: 'object', text: 'Kart' },
  ]);
});

test('reconnect backoff is bounded', () => {
  assert.equal(reconnectDelay(0, () => 0), 500);
  assert.equal(reconnectDelay(20, () => 1), 30_000);
});

import { sortRooms } from '../src/talk';
import { presenceTone } from '../src/talkSync';
test('sortRooms puts newest activity first and presenceTone maps colors', () => {
  const r = (t: string, a: number) => ({ token: t, lastActivity: a }) as never;
  assert.deepEqual(sortRooms([r('a', 1), r('c', 3), r('b', 2)]).map((x: { token: string }) => x.token), ['c', 'b', 'a']);
  assert.deepEqual(['online', 'away', 'dnd', 'offline', undefined].map(presenceTone), ['green', 'yellow', 'red', 'gray', 'gray']);
});
