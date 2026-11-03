// Two CallEngines in one Chromium page, real RTCPeerConnection + fake camera/mic, signaling
// in memory. Proves the engine's offer/answer/candidate/mute/ICE-restart flow on real WebRTC.
import { CallEngine, type CallEngineState, type MediaStreamLike, type RtcPeerLike } from '../../../../packages/core/src/callEngine';
import type { SignalEvent } from '../../../../packages/core/src/call';

declare global {
  interface Window {
    loopback: Promise<Record<string, unknown>>;
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, fn: () => boolean, ms = 15_000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await wait(50);
  }
  return Date.now() - t0;
}

async function run() {
  const result: Record<string, unknown> = {};
  const media = async () => (await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 320, height: 240 } })) as unknown as MediaStreamLike;
  const [streamA, streamB] = [await media(), await media()];
  const engines: Record<string, CallEngine> = {};
  const states: Record<string, CallEngineState | null> = { a: null, z: null };
  const sent: Record<string, number> = {};
  const deliver = (from: string, to: string, ev: SignalEvent) => setTimeout(() => void engines[to]!.handle(ev), 5);
  for (const [id, stream] of [['a', streamA], ['z', streamB]] as const) {
    engines[id] = new CallEngine({
      selfSessionId: id,
      mode: 'mesh',
      createPeer: (c) => new RTCPeerConnection(c) as unknown as RtcPeerLike,
      iceServers: [],
      localStream: stream,
      nick: id,
      send: async (to, data) => {
        sent[data.type] = (sent[data.type] ?? 0) + 1;
        deliver(id, to, { type: 'message', from: id, data: JSON.parse(JSON.stringify(data)) });
      },
      onChange: (s) => (states[id] = s),
    });
  }
  const everyone: SignalEvent = { type: 'participants', full: true, users: [{ sessionId: 'a', userId: 'alice', inCall: 7 }, { sessionId: 'z', userId: 'zed', inCall: 7 }] };
  await Promise.all([engines.a!.handle(everyone), engines.z!.handle(everyone)]);
  const remote = (id: string) => states[id]?.participants[0];
  result.connectMs = await until('both connected with remote audio+video', () =>
    ['a', 'z'].every((id) => remote(id)?.state === 'connected' && (remote(id)?.stream?.getAudioTracks().length ?? 0) > 0 && (remote(id)?.stream?.getVideoTracks().length ?? 0) > 0));
  result.offerFrom = 'z (larger session id)';
  // Decoded video frames actually arrive.
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = remote('a')!.stream as unknown as MediaStream;
  await video.play();
  await until('remote video frames decoded', () => video.videoWidth > 0);
  result.remoteVideo = `${video.videoWidth}x${video.videoHeight}`;
  // Mute is announced to the other side.
  engines.z!.setAudio(false);
  await until('mute seen remotely', () => remote('a')?.audio === false);
  engines.z!.setAudio(true);
  await until('unmute seen remotely', () => remote('a')?.audio === true);
  result.mute = 'ok';
  // Network change → ICE restart renegotiation, still connected.
  const offersBefore = sent.offer ?? 0;
  engines.z!.networkChanged();
  await until('ICE restart offer', () => (sent.offer ?? 0) > offersBefore);
  await wait(500);
  await until('still connected after ICE restart', () => remote('a')?.state === 'connected' && remote('z')?.state === 'connected');
  result.iceRestart = 'ok';
  // Leaving closes the connection on the other side.
  await engines.a!.handle({ type: 'participants', full: true, users: [{ sessionId: 'a', userId: 'alice', inCall: 7 }, { sessionId: 'z', userId: 'zed', inCall: 0 }] });
  result.leave = states.a?.participants.length === 0 ? 'ok' : 'still listed';
  engines.a!.close();
  engines.z!.close();
  result.signaling = sent;
  return result;
}

window.loopback = run().then((r) => ({ ok: true, ...r }), (e) => ({ ok: false, error: String(e?.message ?? e) }));
