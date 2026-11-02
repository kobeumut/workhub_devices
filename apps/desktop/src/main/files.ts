import { app, dialog, shell, type BrowserWindow } from 'electron';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
type FsHandle = Awaited<ReturnType<typeof fs.open>>;
import { basename, extname, join } from 'node:path';
import { canOpenSafely, safeFileName, voiceNoteName, wavInfo, FILE_LIMITS, type FileHost, type FileSink, type PickedFile, type SinkMode } from '@workhub-devices/core';

/**
 * Talk attachments on the desktop live ENTIRELY in the main process: the renderer gets opaque
 * handles (`fh-…`), names and sizes — never a path, a file descriptor or credentials. Uploads
 * read from the picked path; downloads go to a location the user chose in the save dialog, or
 * (for "open") to a private temp folder handed to the default app, only for non-executable types.
 */
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', zip: 'application/zip',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
};
export const mimeOf = (name: string) => MIME[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';

type Entry = { kind: 'path'; path: string; name: string; size: number; mime: string } | { kind: 'buffer'; data: Uint8Array; name: string; mime: string };

const MAX_HANDLES = 50;
const MAX_PICK = 10;

export function createDesktopFiles(getWindow: () => BrowserWindow | null, smokeOut: string | undefined) {
  const handles = new Map<string, Entry>();
  const register = (e: Entry): PickedFile => {
    if (handles.size >= MAX_HANDLES) handles.delete(handles.keys().next().value!);
    const handle = `fh-${randomBytes(12).toString('hex')}`;
    handles.set(handle, e);
    return { handle, name: e.name, size: e.kind === 'path' ? e.size : e.data.byteLength, mime: e.mime };
  };
  const openDir = join(app.getPath('temp'), `workhub-open-${process.pid}`);

  const host: FileHost = {
    async stat(handle) {
      const e = handles.get(handle);
      if (!e) return null;
      if (e.kind === 'buffer') return { name: e.name, size: e.data.byteLength, mime: e.mime };
      // Re-stat: a file that changed size since it was picked is refused by the upload.
      const st = await fs.stat(e.path).catch(() => null);
      return st?.isFile() ? { name: e.name, size: st.size, mime: e.mime } : null;
    },
    async read(handle, offset, length) {
      const e = handles.get(handle);
      if (!e) throw new Error('gone');
      if (e.kind === 'buffer') return e.data.subarray(offset, offset + length);
      const fh = await fs.open(e.path, 'r');
      try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, offset);
        return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
      } finally {
        await fh.close();
      }
    },
    async release(handle) {
      handles.delete(handle);
    },
    async openSink(rawName, _mime, _size, mode: SinkMode): Promise<FileSink | null> {
      const name = safeFileName(rawName);
      let target: string;
      if (smokeOut) {
        target = join(smokeOut, `${mode === 'open' ? 'opened-' : 'saved-'}${name}`);
      } else if (mode === 'open') {
        if (!canOpenSafely(name)) throw new Error('unsafe type');
        const dir = join(openDir, randomBytes(6).toString('hex'));
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        target = join(dir, name);
      } else {
        const win = getWindow();
        const r = win
          ? await dialog.showSaveDialog(win, { defaultPath: join(app.getPath('downloads'), name) })
          : await dialog.showSaveDialog({ defaultPath: join(app.getPath('downloads'), name) });
        if (r.canceled || !r.filePath) return null;
        target = r.filePath;
      }
      // Write next to the target and rename at the end: a cancelled download never leaves a half file.
      const part = `${target}.${randomBytes(4).toString('hex')}.part`;
      let fh: FsHandle | null = await fs.open(part, 'wx', 0o600);
      return {
        async write(chunk) {
          await fh!.write(chunk);
        },
        async finish() {
          await fh!.close();
          fh = null;
          await fs.rename(part, target);
          if (mode === 'open') {
            if (!smokeOut) {
              const err = await shell.openPath(target);
              if (err) throw new Error('open failed');
            }
            return 'opened';
          }
          if (!smokeOut) shell.showItemInFolder(target);
          return 'saved';
        },
        async abort() {
          await fh?.close().catch(() => undefined);
          fh = null;
          await fs.unlink(part).catch(() => undefined);
        },
      };
    },
  };

  return {
    host,
    /** OS open dialog (smoke: a generated test file). Returns metadata + handles only. */
    async pick(): Promise<PickedFile[]> {
      if (smokeOut) {
        const p = join(smokeOut, `Masaüstü ek ${Date.now().toString(36)}.txt`);
        await fs.writeFile(p, `GENE-58 desktop smoke ${new Date().toISOString()}\n`.repeat(200));
        const st = await fs.stat(p);
        return [register({ kind: 'path', path: p, name: basename(p), size: st.size, mime: 'text/plain' })];
      }
      const win = getWindow();
      const opts = { properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'> };
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      if (r.canceled) return [];
      const out: PickedFile[] = [];
      for (const p of r.filePaths.slice(0, MAX_PICK)) {
        const st = await fs.stat(p).catch(() => null);
        if (!st?.isFile()) continue;
        out.push(register({ kind: 'path', path: p, name: safeFileName(basename(p)), size: st.size, mime: mimeOf(p) }));
      }
      return out;
    },
    /** A finished voice note from the renderer: only a bounded, well-formed PCM WAV is accepted. */
    stageRecording(bytes: unknown): PickedFile | null {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > FILE_LIMITS.maxVoice) return null;
      const info = wavInfo(bytes);
      if (!info || info.durationMs < 300) return null;
      return register({ kind: 'buffer', data: new Uint8Array(bytes), name: voiceNoteName(), mime: 'audio/wav' });
    },
    release(handle: unknown) {
      if (typeof handle === 'string') handles.delete(handle);
    },
  };
}
