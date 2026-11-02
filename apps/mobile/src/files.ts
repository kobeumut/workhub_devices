import { base64ToBytes, bytesToBase64, OcsError, voiceNoteName, type FileHost, type FileSink, type PickedFile } from '@workhub-devices/core';
import type { AudioPlayback, PlatformServices } from '@workhub-devices/features';
import { native, nativeEvents } from './native';

/**
 * Talk attachments on mobile: the native module owns the files (SAF documents, recorded WAVs,
 * download cache); JS sees opaque ids and moves bytes in bounded base64 chunks. Only wired when
 * the native side implements it (Android today; iOS: GENE-60).
 */
const SINK_CHUNK = 1024 * 1024;

export const filesSupported = !!(native.filePick && native.fileRead && native.sinkOpen);

const asPicked = (x: { id: string; name: string; size: number; mime: string }): PickedFile => ({ handle: x.id, name: x.name, size: x.size, mime: x.mime });

export const mobileFileHost: FileHost = {
  async stat(handle) {
    const s = await native.fileStat!(handle);
    return s ? { name: s.name, size: s.size, mime: s.mime } : null;
  },
  async read(handle, offset, length) {
    return base64ToBytes(await native.fileRead!(handle, offset, length));
  },
  async release(handle) {
    native.fileRelease!(handle);
  },
  async openSink(name, mime, _size, mode): Promise<FileSink> {
    const id = await native.sinkOpen!(name);
    let aborted = false;
    return {
      async write(chunk) {
        for (let o = 0; o < chunk.byteLength; o += SINK_CHUNK) await native.sinkWrite!(id, bytesToBase64(chunk.subarray(o, o + SINK_CHUNK)));
      },
      async finish() {
        const r = await native.sinkFinish!(id, mime, mode);
        if (r === 'cancelled') throw new OcsError('aborted');
        return r;
      },
      async abort() {
        if (!aborted) native.sinkAbort!(id);
        aborted = true;
      },
    };
  },
};

export function mobileFileServices(): Partial<Pick<PlatformServices, 'files' | 'voice' | 'playAudio'>> {
  if (!filesSupported) return {};
  return {
    files: {
      pick: async () => (await native.filePick!()).map(asPicked),
      release: async (h) => native.fileRelease!(h),
    },
    ...(native.voiceStart
      ? {
          voice: {
            start: () => native.voiceStart!(),
            stop: async () => {
              const r = await native.voiceStop!(voiceNoteName());
              return r ? asPicked(r) : null;
            },
            cancel: async () => native.voiceCancel!(),
          },
        }
      : {}),
    ...(native.audioPlay
      ? {
          playAudio: async (clip): Promise<AudioPlayback> => {
            let done!: () => void;
            const ended = new Promise<void>((r) => (done = r));
            const sub = nativeEvents.addListener('WorkhubAudioEnded', () => {
              sub.remove();
              done();
            });
            await native.audioPlay!(clip.base64);
            return {
              stop: () => {
                native.audioStop!();
                sub.remove();
                done();
              },
              ended,
            };
          },
        }
      : {}),
  };
}
