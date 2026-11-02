import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeMentionQuery, addReaction, deleteMessage, editMessage, editableText, insertMention, isHiddenSystemMessage, isReaction, mentionText, mentionsSelf,
  mergeTimeline, messageActions, reactionSummary, removeReaction, roomActions, searchMessages, talkFeaturesOf, talkRoomApi, withReactions,
  type ChatItem, type RoomGate, type TalkMessage,
} from '../src/talk';
import { createDirectBackend, dispatchWire, type PlainStore } from '../src/backend';
import type { SecretStore } from '../src/accounts';
import { OcsClient, OcsError } from '../src/ocs';
import { normalizeServerUrl } from '../src/serverUrl';
import { json, ocs, scriptedFetch } from './helpers';

const msg = (id: number, extra: Partial<TalkMessage> = {}): TalkMessage => ({
  id, token: 'abcd', actorType: 'users', actorId: 'alice', actorDisplayName: 'Alice', timestamp: 1000, message: `m${id}`,
  messageParameters: [], systemMessage: '', messageType: 'comment', ...extra,
});
const client = (f: ReturnType<typeof scriptedFetch>) =>
  new OcsClient({ serverBase: normalizeServerUrl('https://example.com'), getCredentials: async () => ({ loginName: 'a', appPassword: 'b' }), fetch: f });
const ALL = talkFeaturesOf(['chat-replies', 'edit-messages', 'delete-messages', 'delete-messages-unlimited', 'reactions', 'react-permission', 'chat-v2', 'unified-search', 'room-description']);
const group = (extra: Partial<RoomGate> = {}): RoomGate => ({ type: 2, readOnly: 0, participantType: 3, permissions: 128 | 256, canDeleteConversation: false, canLeaveConversation: true, ...extra });
const alice = { actorType: 'users', actorId: 'alice' };
const bob = { actorType: 'users', actorId: 'bob' };

test('features: every action is capability-gated (missing feature → hidden)', () => {
  const none = talkFeaturesOf([]);
  const a = messageActions(msg(1), group(), alice, none, 1001);
  assert.deepEqual(a, { reply: false, edit: false, delete: false, react: false });
  assert.deepEqual(messageActions(msg(1), group(), alice, ALL, 1001), { reply: true, edit: true, delete: true, react: true });
  assert.equal(roomActions(group({ participantType: 1 }), none).describe, false);
  assert.equal(roomActions(group({ participantType: 1 }), ALL).describe, true);
});

test('message rules mirror ChatController: owner or moderator (not 1:1), edit ≤ 24 h, delete ≤ 6 h without unlimited', () => {
  // other user's message: plain member cannot, moderator can (group), not in one-to-one
  assert.equal(messageActions(msg(1), group(), bob, ALL, 1001).edit, false);
  assert.equal(messageActions(msg(1), group({ participantType: 2 }), bob, ALL, 1001).delete, true);
  assert.equal(messageActions(msg(1), group({ type: 1, participantType: 1 }), bob, ALL, 1001).delete, false);
  // age
  assert.equal(messageActions(msg(1), group(), alice, ALL, 1000 + 86400).edit, false);
  assert.equal(messageActions(msg(1), group({ type: 6 }), alice, ALL, 1000 + 86400 * 30).edit, true);
  const limited = talkFeaturesOf(['delete-messages']);
  assert.equal(messageActions(msg(1), group(), alice, limited, 1000 + 6 * 3600).delete, false);
  assert.equal(messageActions(msg(1), group(), alice, ALL, 1000 + 365 * 86400).delete, true);
  // system / deleted / read-only / no chat permission / file-only edit
  assert.equal(messageActions(msg(1, { systemMessage: 'user_added' }), group(), alice, ALL, 1001).reply, false);
  assert.equal(messageActions(msg(1, { messageType: 'comment_deleted' }), group(), alice, ALL, 1001).delete, false);
  assert.deepEqual(messageActions(msg(1), group({ readOnly: 1 }), alice, ALL, 1001), { reply: false, edit: false, delete: false, react: false });
  assert.equal(messageActions(msg(1), group({ permissions: 256 }), alice, ALL, 1001).edit, false);
  assert.equal(messageActions(msg(1), group({ permissions: 256 }), alice, ALL, 1001).react, true);
  assert.equal(messageActions(msg(1, { message: '{file}' }), group(), alice, ALL, 1001).edit, false);
  assert.equal(messageActions(msg(1, { isReplyable: false }), group(), alice, ALL, 1001).reply, false);
  // permissions missing → fail closed
  assert.equal(messageActions(msg(1), group({ permissions: undefined as never }), alice, ALL, 1001).reply, false);
  // reactions without react-permission feature use the chat bit
  assert.equal(messageActions(msg(1), group({ permissions: 128 }), alice, talkFeaturesOf(['reactions']), 1001).react, true);
});

test('room actions: management only for moderators of group/public rooms; leave/delete from server flags', () => {
  assert.equal(roomActions(group(), ALL).rename, false);
  assert.equal(roomActions(group({ participantType: 2 }), ALL).manageParticipants, true);
  assert.equal(roomActions(group({ type: 1, participantType: 1 }), ALL).rename, false);
  assert.equal(roomActions(group({ canDeleteConversation: true }), ALL).delete, true);
  assert.equal(roomActions(group({ canLeaveConversation: undefined as never }), ALL).leave, false);
});

test('edit/delete/reaction updates from the feed replace the message and its quotes; carriers are hidden', () => {
  let t: ChatItem[] = mergeTimeline([], [msg(10, { reactions: [] }), msg(11, { parent: msg(10) })]);
  const edited = msg(10, { message: 'yeni', lastEditTimestamp: 2000, reactions: { '👍': 1 } });
  t = mergeTimeline(t, [msg(12, { systemMessage: 'message_edited', messageType: 'system', parent: edited })]);
  const byId = (id: number) => t.map((i) => (i.kind === 'server' ? i.message : null)).find((m) => m?.id === id)!;
  assert.equal(byId(10).message, 'yeni');
  assert.equal(byId(10).lastEditTimestamp, 2000);
  assert.deepEqual(byId(10).reactionsSelf, []);
  assert.equal((byId(11).parent as TalkMessage).message, 'yeni');
  assert.equal(isHiddenSystemMessage(byId(12)), true);
  t = mergeTimeline(t, [msg(13, { systemMessage: 'reaction', messageType: 'system', parent: { ...edited, reactions: { '👍': 2 }, reactionsSelf: ['👍'] } })]);
  assert.deepEqual(reactionSummary(byId(10)), [{ emoji: '👍', count: 2, self: true }]);
  t = mergeTimeline(t, [msg(14, { systemMessage: 'message_deleted', messageType: 'system', parent: msg(10, { messageType: 'comment_deleted', message: 'Message deleted by you' }) })]);
  assert.equal(byId(10).messageType, 'comment_deleted');
  assert.deepEqual(byId(11).parent, { id: 10, deleted: true });
  // an update for a message outside the loaded window is ignored (no phantom insert)
  t = mergeTimeline(t, [msg(15, { systemMessage: 'message_edited', messageType: 'system', parent: msg(3) })]);
  assert.equal(t.some((i) => i.kind === 'server' && i.message.id === 3), false);
});

test('withReactions computes counts and own flags from the server map', () => {
  const m = withReactions(msg(1), { '👍': [{ ...alice, actorDisplayName: 'A', timestamp: 1 }, { ...bob, actorDisplayName: 'B', timestamp: 2 }], '🎉': [] }, bob);
  assert.deepEqual(m.reactions, { '👍': 2 });
  assert.deepEqual(m.reactionsSelf, ['👍']);
});

test('reaction validation rejects text, whitespace and control characters', () => {
  assert.equal(isReaction('👍'), true);
  assert.equal(isReaction('❤️'), true);
  assert.equal(isReaction('ok'), false);
  assert.equal(isReaction('👍 '), false);
  assert.equal(isReaction(''), false);
  assert.equal(isReaction('x'.repeat(40)), false);
});

test('mention composer: active query, insertion and quoting', () => {
  assert.deepEqual(activeMentionQuery('selam @al', 9), { start: 6, query: 'al' });
  assert.equal(activeMentionQuery('mail@host', 9), null);
  assert.deepEqual(activeMentionQuery('@', 1), { start: 0, query: '' });
  const r = insertMention('selam @al nasılsın', { start: 6, query: 'al' }, 'alice');
  assert.equal(r.text, 'selam @alice  nasılsın');
  assert.equal(r.caret, 13);
  assert.equal(mentionText('john doe'), '@"john doe"');
  assert.equal(mentionText('federated_user/a@b.c'), '@"federated_user/a@b.c"');
  assert.equal(mentionText('all'), '@all');
  assert.equal(mentionsSelf(msg(1, { messageParameters: { 'mention-user1': { type: 'user', id: 'bob', name: 'Bob' } } }), 'bob'), true);
  assert.equal(mentionsSelf(msg(1, { messageParameters: { 'mention-call1': { type: 'call', id: 'abcd', name: 'Oda' } } }), 'bob'), true);
  assert.equal(mentionsSelf(msg(1), 'bob'), false);
  // edit box: placeholders back to mention text
  assert.equal(editableText(msg(1, {
    message: 'hi {mention-user1} {mention-call1} {mention-group1} {x}',
    messageParameters: { 'mention-user1': { type: 'user', id: 'john doe', name: 'John', 'mention-id': 'john doe' }, 'mention-call1': { type: 'call', id: 'abcd', name: 'Oda' }, 'mention-group1': { type: 'user-group', id: 'staff', name: 'Staff', 'mention-id': 'group/staff' } },
  })), 'hi @"john doe" @all @"group/staff" {x}');
});

test('API: edit PUT / delete DELETE / reaction POST+DELETE(query) on the documented routes', async () => {
  const sys = (s: string) => ocs({ ...msg(9, { systemMessage: s, messageType: 'system' }), parent: msg(5) });
  const f = scriptedFetch(json(200, sys('message_edited')), json(200, sys('message_deleted')), json(201, ocs({ '👍': [{ ...bob, actorDisplayName: 'B', timestamp: 1 }] })), json(200, ocs([])));
  const c = client(f);
  assert.equal((await editMessage(c, 'abcd', 5, 'x')).systemMessage, 'message_edited');
  assert.equal((await deleteMessage(c, 'abcd', 5)).systemMessage, 'message_deleted');
  assert.equal((await addReaction(c, 'abcd', 5, '👍'))['👍']!.length, 1);
  assert.deepEqual(await removeReaction(c, 'abcd', 5, '👍'), {});
  assert.deepEqual(f.calls.map((x) => `${x.init.method} ${new URL(x.url).pathname}`), [
    'PUT /ocs/v2.php/apps/spreed/api/v1/chat/abcd/5',
    'DELETE /ocs/v2.php/apps/spreed/api/v1/chat/abcd/5',
    'POST /ocs/v2.php/apps/spreed/api/v1/reaction/abcd/5',
    'DELETE /ocs/v2.php/apps/spreed/api/v1/reaction/abcd/5',
  ]);
  assert.equal(new URL(f.calls[3]!.url).searchParams.get('reaction'), '👍');
  await assert.rejects(() => addReaction(c, 'abcd', 5, 'yes'), (e: unknown) => e instanceof OcsError && e.kind === 'client');
});

test('search: unified search provider with conversation filter; bad entries dropped; cursor ends', async () => {
  const entry = (token: string, id: string) => ({ title: 'Alice in Oda', subline: '…merhaba…', attributes: { conversation: token, messageId: id, actorId: 'alice', timestamp: '5' } });
  const f = scriptedFetch(
    json(200, ocs({ isPaginated: true, cursor: 2, entries: [entry('abcd', '7'), entry('../x', '8')] })),
    json(200, ocs({ isPaginated: true, cursor: 4, entries: [entry('abcd', '1')] })),
  );
  const c = client(f);
  const p = await searchMessages(c, { term: ' merhaba ', token: 'abcd', limit: 2 });
  assert.deepEqual(p.hits.map((h) => h.messageId), [7]);
  assert.equal(p.cursor, 2);
  const q = new URL(f.calls[0]!.url);
  assert.equal(q.pathname, '/ocs/v2.php/search/providers/talk-message/search');
  assert.equal(q.searchParams.get('conversation'), 'abcd');
  assert.equal(q.searchParams.get('term'), 'merhaba');
  assert.equal((await searchMessages(c, { term: 'x', cursor: 2, limit: 2 })).cursor, null);
  await assert.rejects(() => searchMessages(c, { term: '  ' }));
});

test('room management routes', async () => {
  const f = scriptedFetch(...Array.from({ length: 6 }, () => json(200, ocs([]))));
  const c = client(f);
  await talkRoomApi.rename(c, 'abcd', ' Yeni ad ');
  await talkRoomApi.describe(c, 'abcd', 'açıklama');
  await talkRoomApi.removeAttendee(c, 'abcd', 7);
  await talkRoomApi.setModerator(c, 'abcd', 7, true);
  await talkRoomApi.setModerator(c, 'abcd', 7, false);
  await talkRoomApi.leave(c, 'abcd');
  assert.deepEqual(f.calls.map((x) => `${x.init.method} ${new URL(x.url).pathname}`), [
    'PUT /ocs/v2.php/apps/spreed/api/v4/room/abcd',
    'PUT /ocs/v2.php/apps/spreed/api/v4/room/abcd/description',
    'DELETE /ocs/v2.php/apps/spreed/api/v4/room/abcd/attendees',
    'POST /ocs/v2.php/apps/spreed/api/v4/room/abcd/moderators',
    'DELETE /ocs/v2.php/apps/spreed/api/v4/room/abcd/moderators',
    'DELETE /ocs/v2.php/apps/spreed/api/v4/room/abcd/participants/self',
  ]);
  assert.equal(JSON.parse(String(f.calls[0]!.init.body)).roomName, 'Yeni ad');
});

class Mem implements SecretStore, PlainStore {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
  async deletePrefix(p: string) { for (const k of [...this.m.keys()]) if (k.startsWith(p)) this.m.delete(k); }
}

async function loggedIn(...rest: Response[]) {
  const f = scriptedFetch(
    json(200, { login: 'https://ex.com/index.php/login/v2/flow/x', poll: { token: 't', endpoint: 'https://ex.com/index.php/login/v2/poll' } }),
    json(200, { server: 'https://ex.com', loginName: 'alice', appPassword: 'pw' }),
    ...rest,
  );
  const b = createDirectBackend({ secrets: new Mem(), plain: new Mem(), fetch: f });
  const { flowId } = await b.beginLogin('ex.com');
  const acc = await b.completeLogin(flowId);
  return { b, f, id: acc.id };
}
const capsWith = (features: string[], canCreate = true) =>
  json(200, ocs({ version: { major: 35 }, capabilities: { spreed: { features, config: { conversations: { 'can-create': canCreate } } } } }));
const room = (extra: Record<string, unknown> = {}) => json(200, ocs({ token: 'abcd', type: 2, displayName: 'Oda', readOnly: 0, participantType: 3, permissions: 510, attendeeId: 1, canLeaveConversation: true, canDeleteConversation: false, ...extra }));

test('backend gates fail closed: missing feature, missing role, create disabled — without calling the write route', async () => {
  {
    const { b, f, id } = await loggedIn(capsWith(['chat-v2']));
    await assert.rejects(() => b.editMessage(id, 'abcd', 5, 'x'), (e: unknown) => e instanceof OcsError && e.errorCode === 'TALK_FEATURE_MISSING');
    assert.equal(f.calls.length, 3);
  }
  {
    const { b, f, id } = await loggedIn(capsWith(['reactions', 'react-permission']), room({ permissions: 128 }));
    await assert.rejects(() => b.react(id, 'abcd', 5, '👍', true), (e: unknown) => e instanceof OcsError && e.errorCode === 'TALK_REACT_FORBIDDEN');
    assert.equal(f.calls.length, 4);
  }
  {
    const { b, id } = await loggedIn(capsWith(['room-description']), room());
    await assert.rejects(() => b.updateRoom(id, 'abcd', { name: 'x' }), (e: unknown) => e instanceof OcsError && e.errorCode === 'TALK_RENAME_FORBIDDEN');
  }
  {
    const { b, id } = await loggedIn(capsWith([], false));
    await assert.rejects(() => b.createRoom(id, 'group', 'Yeni'), (e: unknown) => e instanceof OcsError && e.errorCode === 'TALK_CREATE_FORBIDDEN');
  }
  {
    const { b, id } = await loggedIn(capsWith([]), room({ participantType: 1 }));
    await assert.rejects(() => b.removeParticipant(id, 'abcd', 1), (e: unknown) => e instanceof OcsError && e.errorCode === 'USE_LEAVE');
  }
});

test('backend: moderator rename+description only sends changed fields, then re-reads', async () => {
  const { b, f, id } = await loggedIn(capsWith(['room-description']), room({ participantType: 1, description: 'eski' }), json(200, ocs([])), room({ participantType: 1, description: 'yeni' }));
  const r = await b.updateRoom(id, 'abcd', { name: 'Oda', description: 'yeni' });
  assert.equal(r.description, 'yeni');
  assert.deepEqual(f.calls.slice(2).map((x) => `${x.init.method ?? 'GET'} ${new URL(x.url).pathname.split('/').slice(-2).join('/')}`), [
    'GET cloud/capabilities', 'GET room/abcd', 'PUT abcd/description', 'GET room/abcd',
  ]);
});

test('wire validators: Talk arguments are strictly shaped', async () => {
  const b = createDirectBackend({ secrets: new Mem(), plain: new Mem(), fetch: scriptedFetch() });
  const bad = async (m: string, args: unknown[]) => assert.deepEqual(await dispatchWire(b, m, args), { ok: false, error: { kind: 'client', message: 'invalid arguments' } }, `${m} ${JSON.stringify(args)}`);
  await bad('editMessage', ['acc', 'abcd', 5, '   ']);
  await bad('editMessage', ['acc', '../x', 5, 'x']);
  await bad('editMessage', ['acc', 'abcd', 0, 'x']);
  await bad('react', ['acc', 'abcd', 5, 'lol', true]);
  await bad('react', ['acc', 'abcd', 5, '👍', 'yes']);
  await bad('searchMessages', ['acc', '', null, null]);
  await bad('searchMessages', ['acc', 'x', 'abcd', -1]);
  await bad('createRoom', ['acc', 'private', 'x']);
  await bad('createRoom', ['acc', 'group', 'x'.repeat(256)]);
  await bad('updateRoom', ['acc', 'abcd', {}]);
  await bad('updateRoom', ['acc', 'abcd', { name: 'x', password: 'p' }]);
  await bad('updateRoom', ['acc', 'abcd', { description: 'x'.repeat(2001) }]);
  await bad('addParticipant', ['acc', 'abcd', 'emails', 'a@b.c']);
  await bad('setModerator', ['acc', 'abcd', 3, 1]);
});
