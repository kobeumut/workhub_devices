import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base64ToBytes, bytesToBase64, canOpenSafely, davFilePath, downsample, encodeWav, fileOf, formatBytes, numberedName, safeFileName, shareToRoom,
  uploadFile, wavInfo, FILE_LIMITS,
} from '../src/files';
import { createDirectBackend, dispatchWire, type PlainStore } from '../src/backend';
import { parseServerCapabilities } from '../src/capabilities';
import type { SecretStore } from '../src/accounts';
import { OcsClient, OcsError, davError } from '../src/ocs';
import { normalizeServerUrl } from '../src/serverUrl';
import { talkFeaturesOf, type TalkMessage } from '../src/talk';
import { headerOf, json, ocs, scriptedFetch, type Call } from './helpers';
import { MemoryFileHost } from './memoryFiles';

class Mem implements SecretStore, PlainStore {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
  async deletePrefix(p: string) { for (const k of [...this.m.keys()]) if (k.startsWith(p)) this.m.delete(k); }
}
const client = (f: ReturnType<typeof scriptedFetch>) =>
  new OcsClient({ serverBase: normalizeServerUrl('https://example.com'), getCredentials: async () => ({ loginName: 'a', appPassword: 'b' }), fetch: f });
const status = (s: number, headers: Record<string, string> = {}) => new Response(s === 204 ? null : '', { status: s, headers });
const line = (c: Call) => `${c.init.method} ${c.url.replace(/^https:\/\/(example|ex)\.com/, '').replace(/\?.*$/, '')}`;

test('names: unsafe characters, reserved names, length and numbered conflicts', () => {
  assert.equal(safeFileName('../a/b\\c:d*?.txt'), '_a_b_c_d__.txt');
  assert.equal(safeFileName('  .hidden  '), 'hidden');
  assert.equal(safeFileName('rapor. '), 'rapor');
  assert.equal(safeFileName('CON.txt'), '_CON.txt');
  assert.equal(safeFileName('\u0000\u0007'), '__');
  assert.equal(safeFileName(''), 'file');
  const long = safeFileName(`${'ğ'.repeat(300)}.pdf`);
  assert.equal(long.length, FILE_LIMITS.name);
  assert.ok(long.endsWith('.pdf'));
  assert.equal(numberedName('Rapor.final.pdf', 2), 'Rapor.final (2).pdf');
  assert.equal(numberedName('README', 1), 'README (1)');
  assert.equal(numberedName('a.txt', 0), 'a.txt');
});

test('WebDAV paths: segments encoded, traversal/control characters refused', () => {
  assert.equal(davFilePath('alice', '/Talk/Rapor ğ #1?.txt'), '/remote.php/dav/files/alice/Talk/Rapor%20%C4%9F%20%231%3F.txt');
  assert.equal(davFilePath('ali ce', 'Talk/x'), '/remote.php/dav/files/ali%20ce/Talk/x');
  for (const bad of ['/Talk/../etc', '/Talk/./x', '', '/', 'a\\b', 'a/\u0001']) {
    assert.throws(() => davFilePath('alice', bad), (e: unknown) => e instanceof OcsError && e.errorCode === 'INVALID_PATH', bad);
  }
  assert.throws(() => davFilePath('a/b', 'x'), (e: unknown) => e instanceof OcsError && e.errorCode === 'INVALID_USER');
});

test('safe open list: documents/media yes, executables/scripts/html no', () => {
  for (const n of ['a.pdf', 'b.PNG', 'c.docx', 'd.wav', 'e.mp4']) assert.equal(canOpenSafely(n), true, n);
  for (const n of ['a.exe', 'b.sh', 'c.desktop', 'd.html', 'e.js', 'f.bat', 'g.app', 'h.lnk', 'noext', 'i.jar', 'j.msi', 'k.AppImage']) assert.equal(canOpenSafely(n), false, n);
});

test('file messages: parameters → TalkFile (voice, caption, hide-download)', () => {
  const m = (extra: Partial<TalkMessage>): TalkMessage => ({
    id: 5, token: 'abcd', actorType: 'users', actorId: 'alice', actorDisplayName: 'A', timestamp: 1, message: '{file}', systemMessage: '', messageType: 'comment',
    messageParameters: { actor: { type: 'user', id: 'alice', name: 'A' }, file: { type: 'file', id: '42', name: 'a.wav', size: '1234', path: 'Talk/a.wav', mimetype: 'audio/wav', 'hide-download': 'no' } },
    ...extra,
  });
  assert.deepEqual(fileOf(m({})), { id: '42', name: 'a.wav', size: 1234, path: 'Talk/a.wav', mimetype: 'audio/wav', hideDownload: false, voice: false, caption: '' });
  assert.equal(fileOf(m({ messageType: 'voice-message' }))!.voice, true);
  assert.equal(fileOf(m({ message: 'Bakınız' }))!.caption, 'Bakınız');
  const hidden = m({});
  (hidden.messageParameters as Record<string, Record<string, unknown>>).file!['hide-download'] = 'yes';
  assert.equal(fileOf(hidden)!.hideDownload, true);
  assert.equal(fileOf(m({ messageParameters: [] })), null);
  assert.equal(formatBytes(1536), '1,5 KB');
  assert.equal(formatBytes(23 * 1024 * 1024), '23 MB');
});

test('base64 and WAV: round trip, header check, 16 kHz downsampling', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253]);
  for (let n = 0; n <= bytes.length; n++) {
    const part = bytes.subarray(0, n);
    const b64 = bytesToBase64(part);
    assert.equal(b64, Buffer.from(part).toString('base64'));
    assert.deepEqual([...base64ToBytes(b64)], [...part]);
  }
  assert.throws(() => base64ToBytes('a$=='));
  const pcm = downsample(new Float32Array(48000).fill(0.5), 48000, 16000);
  assert.equal(pcm.length, 16000);
  const wav = encodeWav(pcm, 16000);
  assert.equal(wav.byteLength, 44 + 32000);
  assert.deepEqual(wavInfo(wav), { sampleRate: 16000, channels: 1, durationMs: 1000 });
  assert.equal(wavInfo(new TextEncoder().encode('RIFF....WAVEnot a real header, just text padding here!')), null);
});

test('upload (small): MKCOL folder (405 ok) → HEAD probe finds free name → PUT with If-None-Match', async () => {
  const host = new MemoryFileHost();
  const pick = host.add('Rapor.txt', 'text/plain', new TextEncoder().encode('merhaba'));
  const f = scriptedFetch(status(405), status(200), status(404), status(201));
  const r = await uploadFile(client(f), host, pick.handle, { uid: 'alice', folder: '/Talk' });
  assert.deepEqual(r, { name: 'Rapor (1).txt', path: '/Talk/Rapor (1).txt' });
  assert.deepEqual(f.calls.map(line), [
    'MKCOL /remote.php/dav/files/alice/Talk',
    'HEAD /remote.php/dav/files/alice/Talk/Rapor.txt',
    'HEAD /remote.php/dav/files/alice/Talk/Rapor%20(1).txt',
    'PUT /remote.php/dav/files/alice/Talk/Rapor%20(1).txt',
  ]);
  const put = f.calls[3]!;
  assert.equal(headerOf(put, 'If-None-Match'), '*');
  assert.equal(headerOf(put, 'Content-Type'), 'text/plain');
  assert.equal(new TextDecoder().decode(put.init.body as Uint8Array), 'merhaba');
  assert.equal(put.init.redirect, 'manual');
});

test('upload (large): chunked v2 with Destination, MOVE Overwrite:F; failure deletes the upload dir', async () => {
  const host = new MemoryFileHost();
  const size = FILE_LIMITS.chunk * 2 + 5;
  const pick = host.add('big.bin', 'application/octet-stream', new Uint8Array(size));
  const progress: number[] = [];
  const f = scriptedFetch(status(201), status(404), status(201), status(201), status(201), status(201), status(201));
  await uploadFile(client(f), host, pick.handle, { uid: 'alice', folder: 'Talk' }, { onProgress: (p) => progress.push(p.sent) });
  const lines = f.calls.map(line);
  assert.match(lines[2]!, /^MKCOL \/remote\.php\/dav\/uploads\/alice\/workhub-[a-z0-9]+$/);
  assert.match(lines[3]!, /\/00001$/);
  assert.match(lines[5]!, /\/00003$/);
  assert.match(lines[6]!, /^MOVE .*\/\.file$/);
  assert.equal(headerOf(f.calls[2], 'Destination'), 'https://example.com/remote.php/dav/files/alice/Talk/big.bin');
  assert.equal(headerOf(f.calls[4], 'OC-Total-Length'), String(size));
  assert.equal(headerOf(f.calls[6], 'Overwrite'), 'F');
  assert.deepEqual(progress.filter((n) => n > 0), [FILE_LIMITS.chunk, FILE_LIMITS.chunk * 2, size]);

  // quota hit on chunk 2 → 507 QUOTA_EXCEEDED, upload dir removed
  const f2 = scriptedFetch(status(201), status(404), status(201), status(201), new Response('<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns"><s:message>Insufficient space</s:message></d:error>', { status: 507 }), status(204));
  const host2 = new MemoryFileHost();
  const p2 = host2.add('big.bin', 'application/octet-stream', new Uint8Array(size));
  await assert.rejects(uploadFile(client(f2), host2, p2.handle, { uid: 'alice', folder: 'Talk' }), (e: unknown) => e instanceof OcsError && e.errorCode === 'QUOTA_EXCEEDED' && e.ocsMessage === 'Insufficient space');
  assert.match(line(f2.calls.at(-1)!), /^DELETE \/remote\.php\/dav\/uploads\/alice\/workhub-/);
});

test('share into room: share type 10, talkMetaData carries type/caption/reply', async () => {
  const f = scriptedFetch(json(200, ocs({ id: '77' })));
  const id = await shareToRoom(client(f), 'abcd', '/Talk/a.wav', { referenceId: 'r'.repeat(64), caption: '  Not  ', replyTo: 9, voice: true });
  assert.equal(id, '77');
  const body = JSON.parse(String(f.calls[0]!.init.body));
  assert.deepEqual({ ...body, talkMetaData: JSON.parse(body.talkMetaData) }, {
    shareType: 10, shareWith: 'abcd', path: '/Talk/a.wav', referenceId: 'r'.repeat(64), talkMetaData: { messageType: 'voice-message', caption: 'Not', replyTo: 9 },
  });
  assert.equal(davError(413).errorCode, 'FILE_TOO_LARGE');
  assert.equal(davError(423).kind, 'conflict');
});

test('capabilities: attachments fail closed without allowed=true and a sane folder', () => {
  const caps = (attachments: unknown) => parseServerCapabilities({ capabilities: { spreed: { features: ['chat-v2'], config: { attachments } as Record<string, unknown> } } }).talk.attachments;
  assert.deepEqual(caps({ allowed: true, folder: '/Talk' }), { allowed: true, folder: '/Talk' });
  assert.equal(caps({ allowed: true }).allowed, false);
  assert.equal(caps({ allowed: true, folder: '/../x' }).allowed, false);
  assert.equal(caps(undefined).allowed, false);
  const f = talkFeaturesOf(['media-caption', 'voice-message-sharing'], { attachmentsAllowed: false });
  assert.deepEqual([f.files, f.caption, f.voice], [false, false, false]);
  assert.equal(talkFeaturesOf(['voice-message-sharing'], { attachmentsAllowed: true }).voice, true);
});

async function loggedIn(files: MemoryFileHost | undefined, ...rest: Response[]) {
  const f = scriptedFetch(
    json(200, { login: 'https://ex.com/index.php/login/v2/flow/x', poll: { token: 't', endpoint: 'https://ex.com/index.php/login/v2/poll' } }),
    json(200, { server: 'https://ex.com', loginName: 'alice', appPassword: 'pw' }),
    ...rest,
  );
  const b = createDirectBackend({ secrets: new Mem(), plain: new Mem(), fetch: f, ...(files ? { files } : {}) });
  const { flowId } = await b.beginLogin('ex.com');
  const acc = await b.completeLogin(flowId);
  f.calls.length = 0;
  return { b, f, id: acc.id };
}
const caps = (features: string[], allowed = true) =>
  json(200, ocs({ version: { major: 35 }, capabilities: { spreed: { features: ['chat-v2', ...features], config: { attachments: { allowed, folder: '/Talk' } } } } }));
const room = (extra: Record<string, unknown> = {}) => json(200, ocs({ token: 'abcd', type: 2, displayName: 'Oda', readOnly: 0, participantType: 3, permissions: 510, attendeeId: 1, ...extra }));
const fileMsg = (extra: Record<string, unknown> = {}) => json(200, ocs([{
  id: 5, token: 'abcd', actorType: 'users', actorId: 'bob', actorDisplayName: 'B', timestamp: 1, message: '{file}', systemMessage: '', messageType: 'comment',
  messageParameters: { file: { type: 'file', id: '1', name: 'setup.exe', size: '3', path: 'Talk/setup.exe', mimetype: 'application/x-msdownload', 'hide-download': 'no', ...extra } },
}]));
const ref = 'a'.repeat(64);

test('Backend shareFile gates: no FileHost / attachments off / read-only room / caption without feature → no upload', async () => {
  const host = new MemoryFileHost();
  const pick = host.add('a.txt', 'text/plain', new Uint8Array([1]));
  const none = await loggedIn(undefined);
  await assert.rejects(none.b.shareFile(none.id, 'abcd', pick.handle, { transferId: 'tx-1', referenceId: ref }), (e: unknown) => e instanceof OcsError && e.errorCode === 'FILES_UNSUPPORTED');
  assert.equal(none.f.calls.length, 0);

  const off = await loggedIn(host, caps([], false));
  await assert.rejects(off.b.shareFile(off.id, 'abcd', pick.handle, { transferId: 'tx-1', referenceId: ref }), (e: unknown) => e instanceof OcsError && e.errorCode === 'TALK_FEATURE_MISSING');
  assert.equal(off.f.calls.length, 1);

  const ro = await loggedIn(host, caps([]), room({ readOnly: 1 }));
  await assert.rejects(ro.b.shareFile(ro.id, 'abcd', pick.handle, { transferId: 'tx-1', referenceId: ref }), (e: unknown) => e instanceof OcsError && e.errorCode === 'TALK_CHAT_FORBIDDEN');

  const cap = await loggedIn(host, caps([]), room());
  await assert.rejects(cap.b.shareFile(cap.id, 'abcd', pick.handle, { transferId: 'tx-1', referenceId: ref, caption: 'x' }), (e: unknown) => e instanceof OcsError && e.errorCode === 'TALK_FEATURE_MISSING');
  assert.equal(host.reads, 0);
});

test('Backend shareFile: quota pre-check stops before any byte is read', async () => {
  const host = new MemoryFileHost();
  const pick = host.add('a.bin', 'application/octet-stream', new Uint8Array(5000));
  const { b, f, id } = await loggedIn(host, caps([]), room(), json(200, ocs({ id: 'alice', quota: { free: 4000 } })));
  await assert.rejects(b.shareFile(id, 'abcd', pick.handle, { transferId: 'tx-q', referenceId: ref }), (e: unknown) => e instanceof OcsError && e.errorCode === 'QUOTA_EXCEEDED' && e.status === 507);
  assert.equal(host.reads, 0);
  assert.equal(f.calls.length, 3);
  assert.equal((await b.transfer('tx-q'))?.phase, 'preparing');
});

test('Backend downloadFile: fresh message; hidden download and unsafe "open" refused before any sink/transfer', async () => {
  const host = new MemoryFileHost();
  const hidden = await loggedIn(host, caps(['chat-get-context']), fileMsg({ 'hide-download': 'yes' }));
  await assert.rejects(hidden.b.downloadFile(hidden.id, 'abcd', 5, 'save', 'tx-d'), (e: unknown) => e instanceof OcsError && e.errorCode === 'DOWNLOAD_HIDDEN');
  assert.match(line(hidden.f.calls[1]!), /chat\/abcd\/5\/context$/);

  const exe = await loggedIn(host, caps(['chat-get-context']), fileMsg(), json(200, ocs({ id: 'alice', quota: { free: -3 } })));
  await assert.rejects(exe.b.downloadFile(exe.id, 'abcd', 5, 'open', 'tx-d'), (e: unknown) => e instanceof OcsError && e.errorCode === 'OPEN_NOT_ALLOWED');
  assert.equal(host.saved.length, 0);

  const ok = await loggedIn(host, caps(['chat-get-context']), fileMsg(), json(200, ocs({ id: 'alice', quota: { free: -3 } })), new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Length': '3' } }));
  assert.equal(await ok.b.downloadFile(ok.id, 'abcd', 5, 'save', 'tx-d'), 'saved');
  assert.deepEqual([...host.saved[0]!.data], [1, 2, 3]);
  assert.equal(line(ok.f.calls.at(-1)!), 'GET /remote.php/dav/files/alice/Talk/setup.exe');

  const noCtx = await loggedIn(host, caps([]));
  await assert.rejects(noCtx.b.downloadFile(noCtx.id, 'abcd', 5, 'save', 'tx-d'), (e: unknown) => e instanceof OcsError && e.errorCode === 'TALK_FEATURE_MISSING');
});

test('IPC: file calls validated strictly (handle, transfer id, referenceId, mode, unknown option fields)', async () => {
  const b = createDirectBackend({ secrets: new Mem(), plain: new Mem(), fetch: scriptedFetch() });
  const bad = async (m: string, args: unknown[]) => assert.deepEqual(await dispatchWire(b, m, args), { ok: false, error: { kind: 'client', message: 'invalid arguments' } }, `${m} ${JSON.stringify(args)}`);
  const opts = { transferId: 'tx-1', referenceId: ref };
  await bad('shareFile', ['acc', 'abcd', '/etc/passwd', opts]);
  await bad('shareFile', ['acc', 'abcd', 'fh-1', { ...opts, path: '/x' }]);
  await bad('shareFile', ['acc', 'abcd', 'fh-1', { ...opts, referenceId: 'short' }]);
  await bad('shareFile', ['acc', 'abcd', 'fh-1', { referenceId: ref }]);
  await bad('shareFile', ['acc', 'abcd', 'fh-1', { ...opts, voice: 'yes' }]);
  await bad('shareFile', ['acc', '../x', 'fh-1', opts]);
  await bad('downloadFile', ['acc', 'abcd', 5, 'exec', 'tx-1']);
  await bad('downloadFile', ['acc', 'abcd', 0, 'save', 'tx-1']);
  await bad('downloadFile', ['acc', 'abcd', 5, 'save', 'poll-1']);
  await bad('voiceClip', ['acc', 'abcd', '5']);
  await bad('transfer', ['x']);
  const okShape = await dispatchWire(b, 'shareFile', ['acc', 'abcd', 'fh-1', { ...opts, caption: 'c', replyTo: 3, voice: true }]);
  assert.equal(okShape.ok, false);
  assert.notEqual((okShape as { error: { message?: string } }).error.message, 'invalid arguments');
});
