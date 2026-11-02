import { base64ToBytes, downsample, encodeWav, type PickedFile } from '@workhub-devices/core';
import type { AudioPlayback, VoiceRecorder } from '@workhub-devices/features';

/**
 * Voice notes in the renderer: microphone PCM via Web Audio → 16 kHz mono 16-bit WAV (Talk only
 * keeps `voice-message` for WAV/MP3) → handed to main as bytes, which returns an opaque handle.
 * Bounded to 10 minutes. The main process grants the microphone (audio only) to this frame.
 */
const RATE = 16_000;
const MAX_MS = 10 * 60_000;

export function createVoiceRecorder(stage: (wav: Uint8Array) => Promise<PickedFile | null>): VoiceRecorder {
  let state: { stream: MediaStream; ctx: AudioContext; node: ScriptProcessorNode; chunks: Float32Array[]; started: number } | null = null;
  const teardown = async () => {
    const s = state;
    state = null;
    if (!s) return null;
    s.node.disconnect();
    s.stream.getTracks().forEach((t) => t.stop());
    await s.ctx.close().catch(() => undefined);
    return s;
  };
  return {
    async start() {
      if (state) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const s = { stream, ctx, node, chunks: [] as Float32Array[], started: Date.now() };
      node.onaudioprocess = (e) => {
        if (Date.now() - s.started > MAX_MS) return;
        s.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      src.connect(node);
      node.connect(ctx.destination);
      state = s;
    },
    async stop() {
      const s = await teardown();
      if (!s) return null;
      const total = s.chunks.reduce((n, c) => n + c.length, 0);
      const pcm = new Float32Array(total);
      let o = 0;
      for (const c of s.chunks) {
        pcm.set(c, o);
        o += c.length;
      }
      return stage(encodeWav(downsample(pcm, s.ctx.sampleRate, RATE), RATE));
    },
    async cancel() {
      await teardown();
    },
  };
}

export async function playAudio(clip: { mime: string; base64: string }): Promise<AudioPlayback> {
  const url = URL.createObjectURL(new Blob([base64ToBytes(clip.base64) as BlobPart], { type: clip.mime }));
  const audio = new Audio(url);
  let done!: () => void;
  const ended = new Promise<void>((r) => (done = r));
  const finish = () => {
    URL.revokeObjectURL(url);
    done();
  };
  audio.onended = finish;
  audio.onerror = finish;
  await audio.play();
  return {
    stop: () => {
      audio.pause();
      finish();
    },
    ended,
  };
}
