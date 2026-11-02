import { OcsError, type OcsClient } from './ocs';
import { assertRoomToken, type TalkMessage } from './talk';

/**
 * Talk attachments: upload to the user's Talk attachment folder over WebDAV (chunked v2 for big
 * files), then share the file into the conversation (`files_sharing` share type 10 = room).
 * Downloads read the file through the viewer's OWN WebDAV path from a fresh copy of the message.
 *
 * Contract (Talk 25.0.6 / Nextcloud 35): `docs/chat.md` "Share a file to the chat",
 * `lib/Chat/SystemMessage/Listener.php::fixMimeTypeOfVoiceMessage` (voice messages must be
 * `audio/mpeg` or `audio/wav`, otherwise the server silently downgrades them to a plain file),
 * `lib/Chat/Parser/SystemMessage.php::getFileFromShare` (file parameter fields).
 */

/** Opaque handle to a file the platform picked or recorded; the bytes stay in the shell. */
export type FileHandle = string;
export const FILE_HANDLE_RE = /^fh-[a-z0-9-]{1,64}$/;

export interface PickedFile {
  handle: FileHandle;
  name: string;
  size: number;
  mime: string;
}

/** Where downloaded bytes go: `save` → user-chosen location, `open` → default app (safe types only). */
export type SinkMode = 'save' | 'open';

export interface FileSink {
  write(chunk: Uint8Array): Promise<void>;
  /** Flush and hand over (save / open); returns what happened. */
  finish(): Promise<'saved' | 'opened'>;
  /** Discard partial data (cancel / error). */
  abort(): Promise<void>;
}

/**
 * Platform file access, implemented by each shell at its trust boundary (desktop: Electron main,
 * never the renderer; mobile: the native module). Core never sees a filesystem path.
 */
export interface FileHost {
  stat(handle: FileHandle): Promise<Omit<PickedFile, 'handle'> | null>;
  read(handle: FileHandle, offset: number, length: number): Promise<Uint8Array>;
  release(handle: FileHandle): Promise<void>;
  /** Ask where to put a download. `null` = the user cancelled (save dialog). */
  openSink(name: string, mime: string, size: number, mode: SinkMode): Promise<FileSink | null>;
}

export const FILE_LIMITS = {
  /** Client-side ceiling for one upload (the server/quota may be lower). */
  maxUpload: 2 * 1024 ** 3,
  /** Files up to this size go in one PUT; bigger ones use chunked upload v2 with this chunk size. */
  chunk: 10 * 1024 ** 2,
  /** Voice notes are uploaded as WAV; bounded so a stuck recorder can't fill the quota. */
  maxVoice: 25 * 1024 ** 2,
  /** In-memory audio for playback (voice notes). */
  maxPlayback: 25 * 1024 ** 2,
  name: 200,
  caption: 32000,
} as const;

/** Voice notes the server accepts as `voice-message` (anything else becomes a plain file). */
export const VOICE_MIME_TYPES: ReadonlySet<string> = new Set(['audio/wav', 'audio/mpeg']);

/**
 * File types the desktop/mobile shell may hand to the default application ("Open"). Everything
 * else (executables, scripts, installers, shortcuts, HTML…) can only be saved.
 */
export const SAFE_OPEN_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif', 'tif', 'tiff',
  'pdf', 'txt', 'md', 'csv', 'log',
  'mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'weba',
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi',
  'doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp',
]);

export const extensionOf = (name: string) => {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name);
  return m ? m[1]!.toLowerCase() : '';
};
export const canOpenSafely = (name: string) => SAFE_OPEN_EXTENSIONS.has(extensionOf(name));

/**
 * A file name that is valid on Nextcloud and on Windows/macOS/Linux: no separators or reserved
 * characters, no control characters, no leading dots/trailing dots or spaces, bounded length
 * (extension kept). Empty results become `file`.
 */
export function safeFileName(raw: string): string {
  let n = String(raw).normalize('NFC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').trim();
  n = n.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = `_${n}`;
  if (!n) n = 'file';
  if (n.length > FILE_LIMITS.name) {
    const ext = extensionOf(n);
    const keep = ext ? FILE_LIMITS.name - ext.length - 1 : FILE_LIMITS.name;
    n = ext ? `${n.slice(0, keep)}.${ext}` : n.slice(0, keep);
  }
  return n;
}

/** `name (n).ext` — the convention Nextcloud/Talk web use for conflicts. */
export function numberedName(name: string, n: number): string {
  if (n <= 0) return name;
  const ext = extensionOf(name);
  return ext ? `${name.slice(0, -(ext.length + 1))} (${n}).${ext}` : `${name} (${n})`;
}

/** One relative path segment list, validated (no traversal, no empty or control segments). */
export function splitRelativePath(path: string): string[] {
  const parts = path.split('/').filter((p) => p !== '');
  if (parts.length === 0 || parts.length > 64) throw new OcsError('client', undefined, undefined, undefined, 'INVALID_PATH');
  for (const p of parts) {
    if (p === '.' || p === '..' || p.length > 255 || /[\u0000-\u001f\u007f\\]/.test(p)) throw new OcsError('client', undefined, undefined, undefined, 'INVALID_PATH');
  }
  return parts;
}

const DAV_FILES = '/remote.php/dav/files';
const DAV_UPLOADS = '/remote.php/dav/uploads';
const encodeUid = (uid: string) => {
  if (!uid || uid.length > 64 || /[\u0000-\u001f\u007f/\\]/.test(uid)) throw new OcsError('client', undefined, undefined, undefined, 'INVALID_USER');
  return encodeURIComponent(uid);
};
export const davFilePath = (uid: string, relPath: string) => `${DAV_FILES}/${encodeUid(uid)}/${splitRelativePath(relPath).map(encodeURIComponent).join('/')}`;

// ---- Talk file messages ------------------------------------------------------

export interface TalkFile {
  id: string;
  name: string;
  size: number;
  /** Path relative to the VIEWER's home (only accurate in a fresh chat read). */
  path: string;
  mimetype: string;
  /** Share owner disabled downloads: no save/open/play. */
  hideDownload: boolean;
  voice: boolean;
  /** Caption shown with the file (`media-caption`), empty when none. */
  caption: string;
}

/** The shared file of a `{file}` message, or null. Voice notes are `messageType: voice-message`. */
export function fileOf(m: Pick<TalkMessage, 'message' | 'messageParameters' | 'messageType'>): TalkFile | null {
  const params = Array.isArray(m.messageParameters) ? {} : m.messageParameters;
  const f = params.file;
  if (!f || f.type !== 'file' || typeof f.name !== 'string') return null;
  const size = Number(f.size);
  return {
    id: String(f.id),
    name: f.name,
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    path: typeof f.path === 'string' ? f.path : '',
    mimetype: typeof f.mimetype === 'string' ? f.mimetype : 'application/octet-stream',
    hideDownload: f['hide-download'] === 'yes',
    voice: m.messageType === 'voice-message',
    caption: m.message === '{file}' ? '' : m.message,
  };
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1).replace('.', ',')} ${units[i]}`;
}

// ---- Transfers -----------------------------------------------------------------

export interface TransferProgress {
  sent: number;
  total: number;
  phase: 'preparing' | 'uploading' | 'sharing' | 'downloading' | 'done';
}
export type ProgressFn = (p: TransferProgress) => void;

/** Transfer ids come from the UI (`tx-…`) so it can poll progress and cancel. */
export const TRANSFER_ID_RE = /^tx-[a-z0-9-]{1,64}$/;

export interface AttachmentTarget {
  uid: string;
  /** `spreed.config.attachments.folder`, e.g. `/Talk`. */
  folder: string;
}

export interface ShareOptions {
  referenceId: string;
  caption?: string;
  replyTo?: number;
  voice?: boolean;
  /** Send without notifications (`silent`, only with media-caption). */
  silent?: boolean;
}

export interface UploadResult {
  /** Final name in the attachment folder (may carry a ` (n)` suffix). */
  name: string;
  path: string;
  shareId: string;
}

const check = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new OcsError('aborted');
};

/** MKCOL each segment of the folder (405 = already there). */
async function ensureFolder(c: OcsClient, uid: string, folder: string, signal?: AbortSignal) {
  const parts = splitRelativePath(folder);
  for (let i = 1; i <= parts.length; i++) {
    check(signal);
    await c.dav(davFilePath(uid, parts.slice(0, i).join('/')), { method: 'MKCOL', accept: [405], ...(signal ? { signal } : {}) });
  }
}

/** First free `name`, `name (1)`, … in the folder (HEAD probe; the final write still refuses overwrite). */
async function freeName(c: OcsClient, uid: string, folder: string, name: string, signal?: AbortSignal): Promise<string> {
  for (let n = 0; n < 100; n++) {
    check(signal);
    const candidate = numberedName(name, n);
    const r = await c.dav(davFilePath(uid, `${folder}/${candidate}`), { method: 'HEAD', accept: [404], ...(signal ? { signal } : {}) });
    if (r.status === 404) return candidate;
  }
  throw new OcsError('conflict', 409, undefined, undefined, 'NAME_EXHAUSTED');
}

/** Free bytes of the user's quota; null when unlimited/unknown. */
export async function quotaFree(c: OcsClient): Promise<{ uid: string; free: number | null }> {
  const r = await c.get<{ id?: unknown; quota?: { free?: unknown } }>('/ocs/v1.php/cloud/user');
  const uid = typeof r.id === 'string' ? r.id : '';
  if (!uid) throw new OcsError('invalid_response');
  const free = Number(r.quota?.free);
  return { uid, free: Number.isFinite(free) && free >= 0 ? free : null };
}

/**
 * Upload the handle's bytes as `<folder>/<free name>` without ever overwriting an existing file.
 * Small files: one PUT (`If-None-Match: *`). Large files: chunked upload v2 (`MKCOL` upload dir
 * with `Destination`, numbered chunk PUTs, `MOVE .file` with `Overwrite: F`); cancel or failure
 * deletes the upload dir. Progress is reported per chunk.
 */
export async function uploadFile(
  c: OcsClient,
  host: FileHost,
  handle: FileHandle,
  target: AttachmentTarget,
  o: { signal?: AbortSignal; onProgress?: ProgressFn; name?: string } = {},
): Promise<{ name: string; path: string }> {
  const st = await host.stat(handle);
  if (!st) throw new OcsError('not_found', 404, undefined, undefined, 'FILE_GONE');
  if (st.size > FILE_LIMITS.maxUpload) throw new OcsError('client', 413, undefined, undefined, 'FILE_TOO_LARGE');
  const sig = o.signal ? { signal: o.signal } : {};
  const report = (sent: number, phase: TransferProgress['phase']) => o.onProgress?.({ sent, total: st.size, phase });
  report(0, 'preparing');
  await ensureFolder(c, target.uid, target.folder, o.signal);
  const name = await freeName(c, target.uid, target.folder, safeFileName(o.name ?? st.name), o.signal);
  const rel = `${splitRelativePath(target.folder).join('/')}/${name}`;
  const dest = davFilePath(target.uid, rel);
  const type = { 'Content-Type': st.mime || 'application/octet-stream' };

  if (st.size <= FILE_LIMITS.chunk) {
    check(o.signal);
    const body = st.size > 0 ? await host.read(handle, 0, st.size) : new Uint8Array(0);
    if (body.byteLength !== st.size) throw new OcsError('client', undefined, undefined, undefined, 'FILE_CHANGED');
    report(0, 'uploading');
    await c.dav(dest, { method: 'PUT', body, headers: { ...type, 'If-None-Match': '*', 'OC-Total-Length': String(st.size) }, timeoutMs: 120_000, ...sig });
    report(st.size, 'uploading');
    return { name, path: `/${rel}` };
  }

  const uploadDir = `${DAV_UPLOADS}/${encodeUid(target.uid)}/workhub-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const destination = c.url(dest);
  const headers = { Destination: destination, 'OC-Total-Length': String(st.size) };
  try {
    await c.dav(uploadDir, { method: 'MKCOL', headers, ...sig });
    let offset = 0;
    for (let n = 1; offset < st.size; n++) {
      check(o.signal);
      const len = Math.min(FILE_LIMITS.chunk, st.size - offset);
      const chunk = await host.read(handle, offset, len);
      if (chunk.byteLength !== len) throw new OcsError('client', undefined, undefined, undefined, 'FILE_CHANGED');
      await c.dav(`${uploadDir}/${String(n).padStart(5, '0')}`, { method: 'PUT', body: chunk, headers, timeoutMs: 120_000, ...sig });
      offset += len;
      report(offset, 'uploading');
    }
    check(o.signal);
    // Assembly can take a while on the server for big files.
    await c.dav(`${uploadDir}/.file`, { method: 'MOVE', headers: { ...headers, Overwrite: 'F' }, timeoutMs: 300_000, ...sig });
    return { name, path: `/${rel}` };
  } catch (e) {
    await c.dav(uploadDir, { method: 'DELETE', accept: [404] }).catch(() => undefined);
    throw e;
  }
}

/** Share an uploaded file into the conversation; the server posts the `{file}` chat message. */
export async function shareToRoom(c: OcsClient, token: string, path: string, o: ShareOptions): Promise<string> {
  const meta: Record<string, unknown> = { messageType: o.voice ? 'voice-message' : 'comment' };
  const caption = o.caption?.trim();
  if (caption) meta.caption = caption.slice(0, FILE_LIMITS.caption);
  if (o.replyTo) meta.replyTo = o.replyTo;
  if (o.silent) meta.silent = true;
  const r = await c.request<{ id?: unknown }>('/ocs/v2.php/apps/files_sharing/api/v1/shares', {
    method: 'POST',
    body: { shareType: 10, shareWith: assertRoomToken(token), path, referenceId: o.referenceId, talkMetaData: JSON.stringify(meta) },
  });
  const id = r.data && (typeof r.data.id === 'string' || typeof r.data.id === 'number') ? String(r.data.id) : '';
  if (!id) throw new OcsError('invalid_response', r.status);
  return id;
}

/**
 * Stream a file from the viewer's WebDAV into a sink. Uses the response stream where the runtime
 * has one (Node/Electron), otherwise one buffer (React Native). Aborts the sink on any failure.
 */
export async function downloadFile(
  c: OcsClient,
  uid: string,
  file: Pick<TalkFile, 'path' | 'size'>,
  sink: FileSink,
  o: { signal?: AbortSignal; onProgress?: ProgressFn } = {},
): Promise<'saved' | 'opened'> {
  try {
    const res = await c.dav(davFilePath(uid, file.path), { method: 'GET', timeoutMs: 300_000, ...(o.signal ? { signal: o.signal } : {}) });
    const total = Number(res.headers.get('Content-Length')) || file.size;
    let sent = 0;
    o.onProgress?.({ sent, total, phase: 'downloading' });
    const reader = (res.body as ReadableStream<Uint8Array> | null)?.getReader?.();
    if (reader) {
      for (;;) {
        check(o.signal);
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) {
          await sink.write(value);
          sent += value.byteLength;
          o.onProgress?.({ sent, total, phase: 'downloading' });
        }
      }
    } else {
      const buf = new Uint8Array(await res.arrayBuffer());
      check(o.signal);
      await sink.write(buf);
      sent = buf.byteLength;
    }
    const r = await sink.finish();
    o.onProgress?.({ sent, total: Math.max(total, sent), phase: 'done' });
    return r;
  } catch (e) {
    await sink.abort().catch(() => undefined);
    if (e instanceof OcsError) throw e;
    throw new OcsError(o.signal?.aborted ? 'aborted' : 'network');
  }
}

/** Whole (small) file into memory — voice note playback. */
export async function fetchFileBytes(c: OcsClient, uid: string, file: Pick<TalkFile, 'path' | 'size'>, max: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (file.size > max) throw new OcsError('client', 413, undefined, undefined, 'FILE_TOO_LARGE');
  const res = await c.dav(davFilePath(uid, file.path), { method: 'GET', timeoutMs: 120_000, ...(signal ? { signal } : {}) });
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > max) throw new OcsError('client', 413, undefined, undefined, 'FILE_TOO_LARGE');
  return buf;
}

/** Single message, fresh from the server (`chat-get-context`), so file paths are the viewer's own. */
export async function fetchMessage(c: OcsClient, token: string, messageId: number): Promise<TalkMessage> {
  if (!Number.isInteger(messageId) || messageId <= 0) throw new OcsError('client', undefined, 'invalid message id');
  const r = await c.request<TalkMessage[]>(`/ocs/v2.php/apps/spreed/api/v1/chat/${assertRoomToken(token)}/${messageId}/context`, { query: { limit: 1 } });
  const m = (Array.isArray(r.data) ? r.data : []).find((x) => x && x.id === messageId);
  if (!m) throw new OcsError('not_found', 404, undefined, undefined, 'MESSAGE_NOT_FOUND');
  return m;
}

// ---- Base64 (RN bridge + desktop playback) without Buffer ---------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += `${B64[(n >> 18) & 63]}${B64[(n >> 12) & 63]}==`;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += `${B64[(n >> 18) & 63]}${B64[(n >> 12) & 63]}${B64[(n >> 6) & 63]}=`;
  }
  return out;
}

const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();
export function base64ToBytes(b64: string): Uint8Array {
  const s = b64.replace(/[\s=]/g, '');
  if (s.length % 4 === 1) throw new OcsError('invalid_response');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => (i + k < s.length ? B64_INDEX[s.charCodeAt(i + k)] ?? -1 : 0));
    if (v.some((x) => x < 0)) throw new OcsError('invalid_response');
    const n = (v[0]! << 18) | (v[1]! << 12) | (v[2]! << 6) | v[3]!;
    out[o++] = (n >> 16) & 255;
    if (i + 2 < s.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < s.length) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

// ---- WAV (voice notes) -----------------------------------------------------------

/** 16-bit PCM mono WAV from float samples (-1…1), the format Talk accepts as `voice-message`. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const data = samples.length * 2;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + data, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, data, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/** Header sanity check for staged recordings (desktop main refuses anything else). */
export function wavInfo(bytes: Uint8Array): { sampleRate: number; channels: number; durationMs: number } | null {
  if (bytes.byteLength < 44) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ' || v.getUint16(20, true) !== 1) return null;
  const channels = v.getUint16(22, true);
  const sampleRate = v.getUint32(24, true);
  const byteRate = v.getUint32(28, true);
  if (channels < 1 || channels > 2 || sampleRate < 8000 || sampleRate > 48000 || !byteRate) return null;
  return { sampleRate, channels, durationMs: Math.round(((bytes.byteLength - 44) / byteRate) * 1000) };
}

/** Linear downsampling (averaging) for the 16 kHz voice-note format. */
export function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (to >= from) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

export const voiceNoteName = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `Sesli not ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.wav`;
};
