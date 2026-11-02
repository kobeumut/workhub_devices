import type { FileHost, FileSink, PickedFile, SinkMode } from '../src/files';

/** In-memory FileHost for tests/smokes: picked files are byte arrays, sinks collect bytes. */
export class MemoryFileHost implements FileHost {
  files = new Map<string, { name: string; mime: string; data: Uint8Array }>();
  saved: Array<{ name: string; mime: string; mode: SinkMode; data: Uint8Array }> = [];
  released: string[] = [];
  reads = 0;
  /** `null` → the next sink request is "cancelled by the user". */
  sinkAnswer: 'accept' | 'cancel' = 'accept';
  private seq = 0;

  add(name: string, mime: string, data: Uint8Array): PickedFile {
    const handle = `fh-mem-${++this.seq}`;
    this.files.set(handle, { name, mime, data });
    return { handle, name, size: data.byteLength, mime };
  }
  async stat(handle: string) {
    const f = this.files.get(handle);
    return f ? { name: f.name, size: f.data.byteLength, mime: f.mime } : null;
  }
  async read(handle: string, offset: number, length: number) {
    const f = this.files.get(handle);
    if (!f) throw new Error('gone');
    this.reads++;
    return f.data.slice(offset, offset + length);
  }
  async release(handle: string) {
    this.released.push(handle);
    this.files.delete(handle);
  }
  async openSink(name: string, mime: string, _size: number, mode: SinkMode): Promise<FileSink | null> {
    if (this.sinkAnswer === 'cancel') return null;
    const parts: Uint8Array[] = [];
    let aborted = false;
    return {
      write: async (c) => {
        parts.push(c.slice());
      },
      finish: async () => {
        const total = parts.reduce((n, p) => n + p.byteLength, 0);
        const data = new Uint8Array(total);
        let o = 0;
        for (const p of parts) {
          data.set(p, o);
          o += p.byteLength;
        }
        if (!aborted) this.saved.push({ name, mime, mode, data });
        return mode === 'open' ? 'opened' : 'saved';
      },
      abort: async () => {
        aborted = true;
      },
    };
  }
}
