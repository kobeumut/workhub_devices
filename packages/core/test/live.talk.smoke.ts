/**
 * Live smoke for the Talk extensions (GENE-57): conversation management, reply/quote, edit,
 * delete, reactions, mentions and message search — each change verified on the OTHER user's
 * feed (incremental chat fetch merged with the same `mergeTimeline` the UI uses).
 * Not part of `npm test`. Run: `npm run smoke:talk -w @workhub-devices/core` with
 *   WH_SERVER, WH_ALLOW_HTTP=1 (local dev only), WH_A_USER/WH_A_PASS, WH_B_USER/WH_B_PASS, WH_C_USER/WH_C_PASS.
 * Prints no secrets and no message bodies; the conversation it creates is deleted at the end.
 */
import assert from 'node:assert/strict';
import {
  OcsClient, OcsError, normalizeServerUrl, fetchServerCapabilities, talkFeaturesOf, talkRoomApi, roomActions, messageActions,
  sendMessage, fetchChat, mergeTimeline, editMessage, deleteMessage, addReaction, removeReaction, listReactions, reactionSummary,
  mentionSuggestions, searchMessages, inviteCandidates, newReferenceId, isHiddenSystemMessage, mentionsSelf, mentionText,
  type ChatItem, type ServerBase, type TalkMessage, type TalkFeatures,
} from '../src/index';

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
const uidA = env('WH_A_USER');
const uidB = env('WH_B_USER');
const uidC = env('WH_C_USER');
const results: Array<[string, string]> = [];
const step = async (name: string, fn: () => Promise<string | void>) => {
  try {
    const note = await fn();
    results.push([name, `PASS${note ? ` — ${note}` : ''}`]);
  } catch (e) {
    results.push([name, `FAIL — ${e instanceof OcsError ? `${e.kind} ${e.status ?? ''} ${e.errorCode ?? ''}` : (e as Error).message}`]);
  }
};
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof OcsError ? `${e.kind}:${e.status ?? ''}` : 'error'));

/** The other side's view: history once, then incremental fetches merged like the UI does. */
class Feed {
  items: ChatItem[] = [];
  last = 0;
  constructor(private c: OcsClient, private token: string) {}
  async catchUp() {
    for (let i = 0; i < 5; i++) {
      const r = await fetchChat(this.c, this.token, { lookIntoFuture: true, lastKnownMessageId: this.last, timeout: 1, limit: 100 });
      if (r.notModified || r.messages.length === 0) return;
      this.items = mergeTimeline(this.items, r.messages);
      this.last = Math.max(this.last, ...r.messages.map((m) => m.id));
    }
  }
  get(id: number): TalkMessage | undefined {
    for (const it of this.items) if (it.kind === 'server' && it.message.id === id) return it.message;
    return undefined;
  }
  visible() {
    return this.items.filter((i) => i.kind === 'server' && !isHiddenSystemMessage(i.message));
  }
}

async function main() {
  let token = '';
  let f: TalkFeatures = talkFeaturesOf([]);
  let mid = 0;
  let replyId = 0;
  let feedB: Feed | undefined;
  const now = () => Math.floor(Date.now() / 1000);

  await step('capabilities: needed Talk features present', async () => {
    const caps = await fetchServerCapabilities(A);
    f = talkFeaturesOf(caps.talk.features);
    const missing = Object.entries(f).filter(([, v]) => !v).map(([k]) => k);
    assert.deepEqual(missing, []);
    assert.equal(caps.talk.canCreate, true);
    return `Talk ${caps.talk.version}`;
  });

  await step('room create (group) + rename + description by owner', async () => {
    const room = await talkRoomApi.create(A, 'group', `GENE-57 smoke ${new Date().toISOString()}`);
    token = room.token;
    assert.equal(room.type, 2);
    assert.equal(roomActions(room, f).rename, true);
    await talkRoomApi.rename(A, token, 'GENE-57 smoke (renamed)');
    await talkRoomApi.describe(A, token, 'Açıklama: Türkçe ğüşiöç');
    const read = await talkRoomApi.get(A, token);
    assert.equal(read.displayName, 'GENE-57 smoke (renamed)');
    assert.equal(read.description, 'Açıklama: Türkçe ğüşiöç');
  });

  await step('participants: invite candidates, add B and C, promote/demote B, remove C', async () => {
    const cands = await inviteCandidates(A, token, uidB.slice(0, 2));
    assert.ok(cands.some((x) => x.source === 'users' && x.id === uidB), 'B found in invite autocomplete');
    await talkRoomApi.addParticipant(A, token, 'users', uidB);
    await talkRoomApi.addParticipant(A, token, 'users', uidC);
    let ps = await talkRoomApi.participants(A, token);
    const b = ps.find((p) => p.actorId === uidB)!;
    const c = ps.find((p) => p.actorId === uidC)!;
    assert.equal(b.participantType, 3);
    await talkRoomApi.setModerator(A, token, b.attendeeId, true);
    ps = await talkRoomApi.participants(A, token);
    assert.equal(ps.find((p) => p.actorId === uidB)!.participantType, 2);
    assert.equal(roomActions(await talkRoomApi.get(B, token), f).manageParticipants, true);
    await talkRoomApi.setModerator(A, token, b.attendeeId, false);
    assert.equal(roomActions(await talkRoomApi.get(B, token), f).manageParticipants, false);
    await talkRoomApi.removeAttendee(A, token, c.attendeeId);
    ps = await talkRoomApi.participants(A, token);
    assert.deepEqual(ps.map((p) => p.actorId).sort(), [uidA, uidB].sort());
    assert.equal(await code(talkRoomApi.get(C, token)), 'not_found:404');
    return `participants=${ps.length}`;
  });

  await step('non-moderator B: rename/remove/delete refused by the server (and hidden by roomActions)', async () => {
    const rb = await talkRoomApi.get(B, token);
    const acts = roomActions(rb, f);
    assert.equal(acts.rename || acts.manageParticipants || acts.delete, false);
    assert.equal(await code(talkRoomApi.rename(B, token, 'hijack')), 'forbidden:403');
    assert.equal(await code(talkRoomApi.remove(B, token)), 'forbidden:403');
    const self = (await talkRoomApi.participants(B, token)).find((p) => p.actorId === uidA)!;
    assert.equal(await code(talkRoomApi.removeAttendee(B, token, self.attendeeId)), 'forbidden:403');
  });

  await step('message → reply with quote visible to B', async () => {
    feedB = new Feed(B, token);
    await feedB.catchUp();
    mid = (await sendMessage(A, token, { message: 'smoke ilk mesaj', referenceId: newReferenceId() }))!.id;
    await feedB.catchUp();
    const seen = feedB.get(mid)!;
    assert.ok(seen, 'B sees the message');
    const room = await talkRoomApi.get(B, token);
    assert.equal(messageActions(seen, room, { actorType: 'users', actorId: uidB }, f, now()).reply, true);
    replyId = (await sendMessage(B, token, { message: `${mentionText(uidA)} yanıt`, replyTo: mid, referenceId: newReferenceId() }))!.id;
    const feedA = new Feed(A, token);
    await feedA.catchUp();
    const reply = feedA.get(replyId)!;
    assert.equal(reply.parent?.id, mid);
    assert.ok(reply.parent && 'message' in reply.parent);
    assert.equal(mentionsSelf(reply, uidA), true, 'mention rendered as rich object for A');
  });

  await step('mention autocomplete returns room participants (+@all)', async () => {
    const s = await mentionSuggestions(B, token, uidA.slice(0, 2));
    assert.ok(s.some((x) => x.source === 'users' && x.mentionId === uidA));
    const all = await mentionSuggestions(B, token, '');
    assert.ok(all.some((x) => x.mentionId === 'all'));
    return `suggestions=${s.length}`;
  });

  await step('reaction by B: visible to A via feed (counts + reactionsSelf), list, remove', async () => {
    const roomB = await talkRoomApi.get(B, token);
    assert.equal(roomActions(roomB, f).react, true);
    await addReaction(B, token, mid, '👍');
    const feedA = new Feed(A, token);
    await feedA.catchUp();
    assert.deepEqual(reactionSummary(feedA.get(mid)!), [{ emoji: '👍', count: 1, self: false }]);
    await addReaction(A, token, mid, '👍');
    await feedB!.catchUp();
    assert.deepEqual(reactionSummary(feedB!.get(mid)!), [{ emoji: '👍', count: 2, self: true }]);
    const list = await listReactions(A, token, mid);
    assert.deepEqual(list['👍']!.map((x) => x.actorId).sort(), [uidA, uidB].sort());
    await removeReaction(B, token, mid, '👍');
    await feedB!.catchUp();
    assert.deepEqual(reactionSummary(feedB!.get(mid)!), [{ emoji: '👍', count: 1, self: false }]);
    assert.ok(feedB!.visible().every((i) => i.kind !== 'server' || !['reaction', 'reaction_revoked', 'reaction_deleted'].includes(i.message.systemMessage)));
  });

  await step('edit by A: B sees new text + edited marker; quote in the reply updates; B cannot edit A', async () => {
    const sys = await editMessage(A, token, mid, 'smoke düzenlendi');
    assert.equal(sys.systemMessage, 'message_edited');
    await feedB!.catchUp();
    const m = feedB!.get(mid)!;
    assert.equal(m.message, 'smoke düzenlendi');
    assert.ok(m.lastEditTimestamp && m.lastEditTimestamp > 0);
    const q = feedB!.get(replyId)!.parent;
    assert.ok(q && 'message' in q && q.message === 'smoke düzenlendi');
    const roomB = await talkRoomApi.get(B, token);
    assert.equal(messageActions(m, roomB, { actorType: 'users', actorId: uidB }, f, now()).edit, false);
    assert.equal(await code(editMessage(B, token, mid, 'x')), 'forbidden:403');
  });

  await step('search: unified search finds the message, with and without the conversation filter', async () => {
    const inRoom = await searchMessages(B, { term: 'düzenlendi', token });
    assert.ok(inRoom.hits.some((h) => h.token === token && h.messageId === mid));
    const global = await searchMessages(B, { term: 'düzenlendi' });
    assert.ok(global.hits.some((h) => h.token === token));
    assert.equal((await searchMessages(C, { term: 'düzenlendi', token })).hits.length, 0, 'removed participant gets no hits');
    return `hits=${inRoom.hits.length}`;
  });

  await step('delete by A: B sees the deleted placeholder; quote marked deleted; B cannot delete A', async () => {
    assert.equal(await code(deleteMessage(B, token, mid)), 'forbidden:403');
    const sys = await deleteMessage(A, token, mid);
    assert.equal(sys.systemMessage, 'message_deleted');
    await feedB!.catchUp();
    assert.equal(feedB!.get(mid)!.messageType, 'comment_deleted');
    assert.deepEqual(feedB!.get(replyId)!.parent, { id: mid, deleted: true });
    assert.equal(messageActions(feedB!.get(mid)!, await talkRoomApi.get(A, token), { actorType: 'users', actorId: uidA }, f, now()).delete, false);
  });

  await step('public room (type 3): create then delete', async () => {
    const pub = await talkRoomApi.create(A, 'public', `GENE-57 public ${Date.now()}`);
    assert.equal(pub.type, 3);
    await talkRoomApi.remove(A, pub.token);
    assert.equal(await code(talkRoomApi.get(A, pub.token)), 'not_found:404');
  });

  await step('B leaves; owner deletes the conversation', async () => {
    const rb = await talkRoomApi.get(B, token);
    assert.equal(roomActions(rb, f).leave, true);
    await talkRoomApi.leave(B, token);
    assert.equal(await code(talkRoomApi.get(B, token)), 'not_found:404');
    const ra = await talkRoomApi.get(A, token);
    assert.equal(roomActions(ra, f).delete, true);
    await talkRoomApi.remove(A, token);
    assert.equal(await code(talkRoomApi.get(A, token)), 'not_found:404');
    token = '';
  });

  if (token) await talkRoomApi.remove(A, token).catch(() => {});
  for (const [n, r] of results) console.log(`${r.startsWith('PASS') ? '✔' : '✘'} ${n}: ${r}`);
  if (results.some(([, r]) => r.startsWith('FAIL'))) process.exit(1);
}

main().catch((e) => {
  console.error('smoke crashed:', e instanceof OcsError ? e.kind : (e as Error).message);
  process.exit(1);
});
