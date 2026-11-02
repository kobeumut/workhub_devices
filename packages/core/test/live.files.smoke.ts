/**
 * Live smoke for Talk files (GENE-58): WebDAV upload into the Talk attachment folder (single PUT
 * and chunked v2), share into the conversation, caption, name conflicts, cancel, voice notes,
 * downloads/playback by the OTHER participant, gates (read-only room, non-participant, unsafe
 * "open", hidden download) and quota errors. Goes through the real direct Backend with an
 * in-memory FileHost, exactly the path the apps use (minus the platform picker/sink).
 * Not part of `npm test`. Run: `npm run smoke:files -w @workhub-devices/core` with
 *   WH_SERVER, WH_ALLOW_HTTP=1 (local dev only), WH_{A,B,C}_{USER,PASS};
 *   optional WH_ADMIN_USER/WH_ADMIN_PASS (login password, dev only) for the quota step.
 * Prints no secrets and no file contents; the conversation and the uploaded files are deleted at the end.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  OcsClient, OcsError, normalizeServerUrl, fetchServerCapabilities, talkRoomApi, fetchChat, mergeTimeline, newReferenceId, fileOf,
  createDirectBackend, addAccount, davFilePath, encodeWav, uploadFile, base64ToBytes, fetchMessage,
  type AccountId, type Backend, type ChatItem, type PlainStore, type SecretStore, type ServerBase, type TalkMessage, type TransferProgress,
} from '../src/index';
import { MemoryFileHost } from './memoryFiles';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const base: ServerBase = normalizeServerUrl(env('WH_SERVER'), { allowInsecureHttp: process.env.WH_ALLOW_HTTP === '1' });
const client = (u: string, p: string) => new OcsClient({ serverBase: base, getCredentials: async () => ({ loginName: u, appPassword: p }) });

class Mem implements SecretStore, PlainStore {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
  async deletePrefix(p: string) { for (const k of [...this.m.keys()]) if (k.startsWith(p)) this.m.delete(k); }
}

interface Actor { uid: string; c: OcsClient; b: Backend; id: AccountId; files: MemoryFileHost }
async function actor(prefix: 'A' | 'B' | 'C'): Promise<Actor> {
  const uid = env(`WH_${prefix}_USER`);
  const pass = env(`WH_${prefix}_PASS`);
  const secrets = new Mem();
  const plain = new Mem();
  const files = new MemoryFileHost();
  const acc = await addAccount(secrets, { serverBase: base, loginName: uid, appPassword: pass });
  await plain.set('accounts:v1', JSON.stringify([acc]));
  return { uid, c: client(uid, pass), b: createDirectBackend({ secrets, plain, files, urlOptions: { allowInsecureHttp: true } }), id: acc.id, files };
}

const results: Array<[string, string]> = [];
const step = async (name: string, fn: () => Promise<string | void>) => {
  try {
    const note = await fn();
    results.push([name, `PASS${note ? ` — ${note}` : ''}`]);
  } catch (e) {
    results.push([name, `FAIL — ${e instanceof OcsError ? `${e.kind} ${e.status ?? ''} ${e.errorCode ?? ''} ${e.ocsMessage ?? ''}` : (e as Error).message}`]);
  }
};
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof OcsError ? `${e.kind}:${e.status ?? ''}:${e.errorCode ?? ''}` : `error:${(e as Error).message}`));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
let txSeq = 0;
const tx = () => `tx-smoke-${Date.now().toString(36)}-${++txSeq}`;

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
  byRef(ref: string): TalkMessage | undefined {
    for (const it of this.items) if (it.kind === 'server' && it.message.referenceId === ref) return it.message;
    return undefined;
  }
  count() {
    return this.items.filter((i) => i.kind === 'server' && fileOf(i.message)).length;
  }
}

async function main() {
  const A = await actor('A');
  const B = await actor('B');
  const C = await actor('C');
  let token = '';
  let folder = '/Talk';
  const uploaded: string[] = [];
  let feedB: Feed | undefined;
  let textMsg: TalkMessage | undefined;

  await step('capabilities: attachments allowed + folder, file features on', async () => {
    const caps = await fetchServerCapabilities(A.c);
    assert.equal(caps.talk.attachments.allowed, true);
    folder = caps.talk.attachments.folder ?? '';
    assert.ok(folder);
    const s = await A.b.session(A.id);
    assert.equal(s.talkAttachmentsAllowed, true);
    for (const f of ['media-caption', 'voice-message-sharing', 'chat-get-context', 'chat-reference-id']) assert.ok(s.talkFeatures.includes(f), f);
    return `folder ${folder}`;
  });

  await step('room: A creates a group room, adds B', async () => {
    const room = await talkRoomApi.create(A.c, 'group', `GENE-58 files ${new Date().toISOString()}`);
    token = room.token;
    await talkRoomApi.addParticipant(A.c, token, 'users', B.uid);
    feedB = new Feed(B.c, token);
    await feedB.catchUp();
  });

  const stamp = Date.now().toString(36);
  const smallName = `Rapor ğüşİ ${stamp}.txt`;
  const small = new TextEncoder().encode(`GENE-58 küçük dosya ${stamp}\n`.repeat(50));

  await step('small file: single PUT + share with caption → B sees {file} + caption, fresh path', async () => {
    const pick = A.files.add(smallName, 'text/plain', small);
    const ref = newReferenceId();
    const r = await A.b.shareFile(A.id, token, pick.handle, { transferId: tx(), referenceId: ref, caption: 'Açıklama ✓' });
    uploaded.push(r.path);
    assert.equal(r.name, smallName);
    assert.equal(r.path, `${folder}/${smallName}`);
    assert.ok(A.files.released.includes(pick.handle), 'handle released after share');
    await feedB!.catchUp();
    const m = feedB!.byRef(ref);
    assert.ok(m, 'message with referenceId on B');
    const f = fileOf(m!)!;
    assert.equal(f.name, smallName);
    assert.equal(f.size, small.byteLength);
    assert.equal(f.caption, 'Açıklama ✓');
    assert.equal(f.voice, false);
    assert.equal(f.hideDownload, false);
    textMsg = m;
    return `B path is its own: ${f.path !== r.path ? 'yes' : 'same'}`;
  });

  await step('name conflict: same name again → "name (1).ext", no overwrite', async () => {
    const pick = A.files.add(smallName, 'text/plain', new TextEncoder().encode('ikinci'));
    const r = await A.b.shareFile(A.id, token, pick.handle, { transferId: tx(), referenceId: newReferenceId() });
    uploaded.push(r.path);
    assert.equal(r.name, smallName.replace(/\.txt$/, ' (1).txt'));
    const first = await (await A.c.dav(davFilePath(A.uid, `${folder}/${smallName}`), { method: 'GET' })).arrayBuffer();
    assert.equal(sha(new Uint8Array(first)), sha(small), 'first file unchanged');
  });

  const bigName = `Büyük ${stamp}.bin`;
  const big = new Uint8Array(randomBytes(23 * 1024 * 1024 + 123));
  let bigRef = '';
  await step('large file: chunked upload v2 (3 chunks) with progress, then shared', async () => {
    const pick = A.files.add(bigName, 'application/octet-stream', big);
    const id = tx();
    bigRef = newReferenceId();
    const seen: TransferProgress[] = [];
    const poll = setInterval(() => void A.b.transfer(id).then((p) => p && seen.push(p)), 50);
    const r = await A.b.shareFile(A.id, token, pick.handle, { transferId: id, referenceId: bigRef }).finally(() => clearInterval(poll));
    uploaded.push(r.path);
    const done = await A.b.transfer(id);
    assert.equal(done?.phase, 'done');
    assert.equal(done?.sent, big.byteLength);
    const partial = seen.filter((p) => p.phase === 'uploading' && p.sent > 0 && p.sent < big.byteLength);
    assert.ok(partial.length >= 1, 'intermediate progress observed');
    assert.ok(A.files.reads >= 3);
    return `${partial.length} intermediate progress samples`;
  });

  await step('download by B (Backend → sink): bytes identical, progress done; cancelled dialog → no transfer', async () => {
    await feedB!.catchUp();
    const m = feedB!.byRef(bigRef)!;
    assert.ok(m);
    const id = tx();
    assert.equal(await B.b.downloadFile(B.id, token, m.id, 'save', id), 'saved');
    const got = B.files.saved.at(-1)!;
    assert.equal(got.name, bigName);
    assert.equal(sha(got.data), sha(big));
    assert.equal((await B.b.transfer(id))?.phase, 'done');
    B.files.sinkAnswer = 'cancel';
    assert.equal(await B.b.downloadFile(B.id, token, m.id, 'save', tx()), 'cancelled');
    B.files.sinkAnswer = 'accept';
    assert.equal(await code(B.b.downloadFile(B.id, token, m.id, 'open', tx())), 'forbidden:403:OPEN_NOT_ALLOWED');
    assert.equal(await B.b.downloadFile(B.id, token, textMsg!.id, 'open', tx()), 'opened');
    return 'sha256 match';
  });

  await step('cancel: abort mid-upload → aborted, upload dir removed, nothing shared', async () => {
    const before = (await feedB!.catchUp(), feedB!.count());
    const name = `İptal ${stamp}.bin`;
    const pick = A.files.add(name, 'application/octet-stream', new Uint8Array(randomBytes(31 * 1024 * 1024)));
    const id = tx();
    const p = A.b.shareFile(A.id, token, pick.handle, { transferId: id, referenceId: newReferenceId() });
    for (let i = 0; i < 400; i++) {
      const pr = await A.b.transfer(id);
      if (pr && pr.sent > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await A.b.cancel(id);
    assert.equal(await code(p), 'aborted::');
    const head = await A.c.dav(davFilePath(A.uid, `${folder}/${name}`), { method: 'HEAD', accept: [404] });
    assert.equal(head.status, 404, 'no file at destination');
    await new Promise((r) => setTimeout(r, 500));
    await feedB!.catchUp();
    assert.equal(feedB!.count(), before, 'no new file message');
    assert.ok(!A.files.released.includes(pick.handle), 'handle kept for retry');
  });

  let voiceRef = '';
  const wav = (() => {
    const s = new Float32Array(16000);
    for (let i = 0; i < s.length; i++) s[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / 16000);
    return encodeWav(s, 16000);
  })();
  await step('voice note: WAV shared as voice-message; B plays it (voiceClip bytes identical)', async () => {
    const pick = A.files.add(`Sesli not ${stamp}.wav`, 'audio/wav', wav);
    voiceRef = newReferenceId();
    const r = await A.b.shareFile(A.id, token, pick.handle, { transferId: tx(), referenceId: voiceRef, voice: true });
    uploaded.push(r.path);
    await feedB!.catchUp();
    const m = feedB!.byRef(voiceRef)!;
    assert.equal(m.messageType, 'voice-message');
    assert.equal(fileOf(m)!.voice, true);
    const clip = await B.b.voiceClip(B.id, token, m.id);
    assert.equal(clip.mime, 'audio/wav');
    assert.equal(sha(base64ToBytes(clip.base64)), sha(wav));
  });

  await step('voice gate: non-audio as voice → 422 INVALID_VOICE_MESSAGE before any upload', async () => {
    const pick = A.files.add('not-audio.txt', 'text/plain', small);
    const reads = A.files.reads;
    assert.equal(await code(A.b.shareFile(A.id, token, pick.handle, { transferId: tx(), referenceId: newReferenceId(), voice: true })), 'client:422:INVALID_VOICE_MESSAGE');
    assert.equal(A.files.reads, reads);
  });

  await step('gates: non-participant C → 404; read-only room → B 403 (client) and server refuses a direct share', async () => {
    const cPick = C.files.add('c.txt', 'text/plain', small);
    assert.equal(await code(C.b.shareFile(C.id, token, cPick.handle, { transferId: tx(), referenceId: newReferenceId() })), 'not_found:404:');
    await A.c.request(`/ocs/v2.php/apps/spreed/api/v4/room/${token}/read-only`, { method: 'PUT', body: { state: 1 } });
    const bPick = B.files.add('b.txt', 'text/plain', small);
    assert.equal(await code(B.b.shareFile(B.id, token, bPick.handle, { transferId: tx(), referenceId: newReferenceId() })), 'forbidden:403:TALK_CHAT_FORBIDDEN');
    assert.equal(B.files.reads, 0, 'nothing uploaded');
    // Server re-check: upload outside the gate, then try to share into the read-only room.
    const up = await uploadFile(B.c, B.files, B.files.add(`b-direct ${stamp}.txt`, 'text/plain', small).handle, { uid: B.uid, folder });
    const direct = await code(B.c.request('/ocs/v2.php/apps/files_sharing/api/v1/shares', { method: 'POST', body: { shareType: 10, shareWith: token, path: up.path } }));
    await B.c.dav(davFilePath(B.uid, up.path), { method: 'DELETE', accept: [404] });
    await A.c.request(`/ocs/v2.php/apps/spreed/api/v4/room/${token}/read-only`, { method: 'PUT', body: { state: 0 } });
    assert.notEqual(direct, 'ok');
    return `server: ${direct}`;
  });

  await step('hidden download: room shares do not persist hideDownload (Talk 25) — flag read from the fresh message', async () => {
    // RoomShareProvider::update() stores permissions/expiration/password only, so the owner cannot
    // hide downloads of a room share; the client gate (`DOWNLOAD_HIDDEN`) is covered by unit tests.
    await feedB!.catchUp();
    const m = feedB!.byRef(voiceRef)!;
    const shares = await A.c.get<Array<{ id: string; share_type: number; share_with: string }>>('/ocs/v2.php/apps/files_sharing/api/v1/shares', { query: { path: uploaded.at(-1)!, reshares: true } });
    const share = shares.find((s) => s.share_type === 10 && s.share_with === token);
    assert.ok(share, 'room share listed');
    const upd = await code(A.c.request(`/ocs/v2.php/apps/files_sharing/api/v1/shares/${share!.id}`, { method: 'PUT', body: { hideDownload: 'true' } }));
    const fresh = await fetchMessage(B.c, token, m.id);
    assert.equal(fileOf(fresh)!.hideDownload, false);
    assert.equal(await code(B.b.voiceClip(B.id, token, m.id)), 'ok');
    return `PUT ${upd}, hide-download stays "no"`;
  });

  const adminUser = process.env.WH_ADMIN_USER;
  const adminPass = process.env.WH_ADMIN_PASS;
  await step('quota: C with 1 MB quota → pre-check QUOTA_EXCEEDED (no bytes sent); bypassing it → server 507 QUOTA_EXCEEDED', async () => {
    if (!adminUser || !adminPass) return 'SKIP — no WH_ADMIN_* (dev admin) given';
    const admin = client(adminUser, adminPass);
    const prev = (await admin.get<{ quota?: { quota?: unknown } }>(`/ocs/v1.php/cloud/users/${encodeURIComponent(C.uid)}`)).quota?.quota;
    const restore = typeof prev === 'number' && prev >= 0 ? String(prev) : 'none';
    await admin.request(`/ocs/v1.php/cloud/users/${encodeURIComponent(C.uid)}`, { method: 'PUT', body: { key: 'quota', value: '1 MB' } });
    let room = '';
    try {
      room = (await talkRoomApi.create(C.c, 'group', `GENE-58 quota ${stamp}`)).token;
      const data = new Uint8Array(randomBytes(3 * 1024 * 1024));
      const pick = C.files.add(`kota ${stamp}.bin`, 'application/octet-stream', data);
      assert.equal(await code(C.b.shareFile(C.id, room, pick.handle, { transferId: tx(), referenceId: newReferenceId() })), 'client:507:QUOTA_EXCEEDED');
      assert.equal(C.files.reads, 0, 'pre-check stopped before reading/sending');
      const server = await code(uploadFile(C.c, C.files, pick.handle, { uid: C.uid, folder }));
      assert.equal(server, 'client:507:QUOTA_EXCEEDED');
    } finally {
      if (room) await talkRoomApi.remove(C.c, room).catch(() => undefined);
      await admin.request(`/ocs/v1.php/cloud/users/${encodeURIComponent(C.uid)}`, { method: 'PUT', body: { key: 'quota', value: restore } });
    }
  });

  await step('cleanup: room deleted, uploaded files removed', async () => {
    if (token) await talkRoomApi.remove(A.c, token);
    for (const p of uploaded) await A.c.dav(davFilePath(A.uid, p), { method: 'DELETE', accept: [404] });
    return `${uploaded.length} files`;
  });

  for (const [n, r] of results) console.log(`${r.startsWith('PASS') ? '✓' : '✗'} ${n}: ${r}`);
  const failed = results.filter(([, r]) => !r.startsWith('PASS')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

void main();
