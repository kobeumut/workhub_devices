import test from 'node:test';
import assert from 'node:assert/strict';
import { CallEngine, type CallEngineState, type DataChannelLike, type IceCandidateLike, type MediaStreamLike, type MediaTrackLike, type RtcPeerLike, type SessionDescriptionLike } from '../src/callEngine';
import type { PeerMessage } from '../src/call';

class FakeTrack implements MediaTrackLike {
  enabled = true;
  stopped = false;
  constructor(readonly kind: string) {}
  stop() {
    this.stopped = true;
  }
}
class FakeStream implements MediaStreamLike {
  constructor(readonly tracks: FakeTrack[]) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
}
class FakeChannel implements DataChannelLike {
  readyState = 'connecting';
  sent: string[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 'closed';
  }
}
class FakePeer implements RtcPeerLike {
  static all: FakePeer[] = [];
  signalingState = 'stable';
  iceConnectionState = 'new';
  closed = false;
  tracks: MediaTrackLike[] = [];
  remote: SessionDescriptionLike[] = [];
  candidates: IceCandidateLike[] = [];
  offers: Array<Record<string, unknown> | undefined> = [];
  channels: FakeChannel[] = [];
  private listeners = new Map<string, Array<(ev: any) => void>>();
  constructor() {
    FakePeer.all.push(this);
  }
  async createOffer(o?: Record<string, unknown>) {
    this.offers.push(o);
    return { type: 'offer', sdp: `offer-${this.offers.length}` };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'answer' };
  }
  async setLocalDescription(d: SessionDescriptionLike) {
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(d: SessionDescriptionLike) {
    this.remote.push(d);
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate(c: IceCandidateLike) {
    this.candidates.push(c);
  }
  addTrack(t: MediaTrackLike) {
    this.tracks.push(t);
  }
  createDataChannel() {
    const c = new FakeChannel();
    this.channels.push(c);
    return c;
  }
  close() {
    this.closed = true;
  }
  addEventListener(type: string, cb: (ev: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  fire(type: string, ev: unknown = {}) {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
  ice(state: string) {
    this.iceConnectionState = state;
    this.fire('iceconnectionstatechange');
  }
}

function setup(self: string, mode: 'mesh' | 'mcu' = 'mesh', withVideo = true) {
  FakePeer.all = [];
  const sent: Array<{ to: string; data: PeerMessage }> = [];
  const states: CallEngineState[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const local = new FakeStream([new FakeTrack('audio'), ...(withVideo ? [new FakeTrack('video')] : [])]);
  const engine = new CallEngine({
    selfSessionId: self,
    mode,
    createPeer: () => new FakePeer(),
    iceServers: [{ urls: ['stun:s'] }],
    send: async (to, data) => void sent.push({ to, data }),
    localStream: local,
    onChange: (s) => states.push(s),
    nick: 'Alice',
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => void ((t as { cleared: boolean }).cleared = true),
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { engine, sent, states, timers, local, flush, last: () => states.at(-1)! };
}

const users = (...list: Array<[string, number]>) => ({ type: 'participants' as const, full: true, users: list.map(([sessionId, inCall]) => ({ sessionId, userId: sessionId, inCall })) });

test('mesh: the larger session id offers to the smaller one (Talk web rule), with our media and a status channel', async () => {
  const { engine, sent, last } = setup('m');
  await engine.handle(users(['m', 7], ['a', 7], ['z', 7], ['x', 0]));
  assert.equal(FakePeer.all.length, 1, 'only to "a" (smaller); "z" will call us; "x" is not in the call');
  const pc = FakePeer.all[0]!;
  assert.deepEqual(pc.tracks.map((t) => t.kind), ['audio', 'video']);
  assert.equal(pc.channels.length, 1);
  const offer = sent.find((s) => s.data.type === 'offer')!;
  assert.equal(offer.to, 'a');
  assert.deepEqual(offer.data.payload, { type: 'offer', sdp: 'offer-1' });
  assert.equal(offer.data.roomType, 'video');
  assert.equal(offer.data.nick, 'Alice');
  assert.deepEqual(last().participants.map((p) => [p.sessionId, p.state]), [['a', 'connecting'], ['z', 'waiting']]);
});

test('mesh: answering an offer, candidates before the remote description are queued, our candidates are sent', async () => {
  const { engine, sent, last } = setup('m');
  await engine.handle(users(['m', 7], ['z', 3]));
  await engine.handle({ type: 'message', from: 'z', data: { type: 'candidate', roomType: 'video', payload: { candidate: { candidate: 'early', sdpMid: '0', sdpMLineIndex: 0 } } } });
  await engine.handle({ type: 'message', from: 'z', data: { type: 'offer', roomType: 'video', sid: 's1', payload: { type: 'offer', sdp: 'remote' } } });
  const pc = FakePeer.all[0]!;
  assert.deepEqual(pc.remote, [{ type: 'offer', sdp: 'remote' }]);
  // the early candidate arrived before the peer existed → dropped; later ones are applied
  await engine.handle({ type: 'message', from: 'z', data: { type: 'candidate', roomType: 'video', payload: { candidate: { candidate: 'late', sdpMid: '0', sdpMLineIndex: 0 } } } });
  assert.deepEqual(pc.candidates.map((c) => c.candidate), ['late']);
  const answer = sent.find((s) => s.data.type === 'answer')!;
  assert.deepEqual([answer.to, answer.data.sid, answer.data.payload], ['z', 's1', { type: 'answer', sdp: 'answer' }]);
  pc.fire('icecandidate', { candidate: { candidate: 'mine', sdpMid: '0', sdpMLineIndex: 0 } });
  pc.fire('icecandidate', { candidate: null });
  const cands = sent.filter((s) => s.data.type === 'candidate');
  assert.equal(cands.length, 1);
  assert.deepEqual(cands[0]!.data.payload, { candidate: { candidate: 'mine', sdpMid: '0', sdpMLineIndex: 0 } });
  const stream = new FakeStream([new FakeTrack('audio')]);
  pc.fire('track', { streams: [stream] });
  pc.ice('connected');
  assert.equal(last().participants[0]!.stream, stream);
  assert.equal(last().participants[0]!.state, 'connected');
});

test('mesh: queued candidates on our own offer are applied after the answer', async () => {
  const { engine } = setup('m');
  await engine.handle(users(['m', 7], ['a', 7]));
  const pc = FakePeer.all[0]!;
  await engine.handle({ type: 'message', from: 'a', data: { type: 'candidate', payload: { candidate: { candidate: 'c1' } } } });
  assert.equal(pc.candidates.length, 0);
  await engine.handle({ type: 'message', from: 'a', data: { type: 'answer', payload: { type: 'answer', sdp: 'ans' } } });
  assert.deepEqual(pc.candidates.map((c) => c.candidate), ['c1']);
});

test('mesh: leaving participants are closed; screen offers ignored; glare resolved by session order', async () => {
  const { engine, sent } = setup('m');
  await engine.handle(users(['m', 7], ['a', 7]));
  const toA = FakePeer.all[0]!;
  // "a" (smaller) also offers at the same time: our (larger) offer wins, theirs is ignored
  await engine.handle({ type: 'message', from: 'a', data: { type: 'offer', payload: { type: 'offer', sdp: 'glare' } } });
  assert.equal(FakePeer.all.length, 1);
  assert.equal(toA.remote.length, 0);
  await engine.handle({ type: 'message', from: 'a', data: { type: 'offer', roomType: 'screen', payload: { type: 'offer', sdp: 'screen' } } });
  assert.equal(FakePeer.all.length, 1);
  await engine.handle(users(['m', 7], ['a', 0]));
  assert.equal(toA.closed, true);
  assert.equal(engine.state.participants.length, 0);
  // a larger peer's offer during our pending offer replaces ours
  await engine.handle(users(['m', 7], ['b', 7]));
  const toB = FakePeer.all.at(-1)!;
  assert.equal(sent.at(-1)!.to, 'b');
  await engine.handle(users(['m', 7], ['b', 7], ['z', 7]));
  const before = FakePeer.all.length;
  await engine.handle({ type: 'message', from: 'z', data: { type: 'offer', payload: { type: 'offer', sdp: 'z' } } });
  assert.equal(FakePeer.all.length, before + 1);
  assert.equal(toB.closed, false);
});

test('mesh: the smaller side offers itself if no offer arrives (fallback timer)', async () => {
  const { engine, timers, sent, flush } = setup('a');
  await engine.handle(users(['a', 7], ['m', 7]));
  assert.equal(FakePeer.all.length, 0);
  assert.equal(timers.length, 1);
  timers[0]!.fn();
  await flush();
  assert.equal(FakePeer.all.length, 1);
  assert.equal(sent.at(-1)!.data.type, 'offer');
  // an offer that arrives in time cancels the fallback
  const t2 = setup('a');
  await t2.engine.handle(users(['a', 7], ['m', 7]));
  await t2.engine.handle({ type: 'message', from: 'm', data: { type: 'offer', payload: { type: 'offer', sdp: 'x' } } });
  assert.equal(t2.timers[0]!.cleared, true);
});

test('mute/unmute: local tracks toggle, peers are told via signaling and the status channel; remote mute is shown', async () => {
  const { engine, sent, local, last } = setup('m');
  await engine.handle(users(['m', 7], ['a', 7]));
  const ch = FakePeer.all[0]!.channels[0]!;
  ch.readyState = 'open';
  ch.onopen?.({});
  assert.deepEqual(ch.sent.map((x) => JSON.parse(x).type), ['audioOn', 'videoOn']);
  engine.setAudio(false);
  assert.equal(local.getAudioTracks()[0]!.enabled, false);
  assert.deepEqual(sent.at(-1), { to: 'a', data: { type: 'mute', roomType: 'video', payload: { name: 'audio' } } });
  assert.equal(JSON.parse(ch.sent.at(-1)!).type, 'audioOff');
  engine.setVideo(true);
  assert.equal(sent.at(-1)!.data.type, 'unmute');
  await engine.handle({ type: 'message', from: 'a', data: { type: 'mute', payload: { name: 'video' } } });
  assert.equal(last().participants[0]!.video, false);
  ch.onmessage?.({ data: JSON.stringify({ type: 'audioOff' }) });
  assert.equal(last().participants[0]!.audio, false);
});

test('reconnect: ICE failure → ICE restart offer, then rebuild if it does not recover; network recovery restarts', async () => {
  const { engine, sent, timers, flush } = setup('m');
  await engine.handle(users(['m', 7], ['a', 7]));
  const pc = FakePeer.all[0]!;
  pc.ice('failed');
  await flush();
  assert.equal(pc.offers.at(-1)?.iceRestart, true);
  assert.equal(engine.state.participants[0]!.state, 'reconnecting');
  const restart = timers.find((t) => t.ms === 15_000)!;
  restart.fn();
  await flush();
  assert.equal(pc.closed, true);
  assert.equal(FakePeer.all.length, 2, 'rebuilt');
  const pc2 = FakePeer.all[1]!;
  pc2.ice('connected');
  const offersBefore = sent.filter((s) => s.data.type === 'offer').length;
  await engine.handle({ type: 'network', ok: false });
  await engine.handle({ type: 'network', ok: true });
  await flush();
  assert.equal(sent.filter((s) => s.data.type === 'offer').length, offersBefore + 1);
  assert.equal(pc2.offers.at(-1)?.iceRestart, true);
  engine.networkChanged();
  await flush();
  assert.equal(pc2.offers.length, 3);
});

test('end of call: moderator ended / session lost closes every connection', async () => {
  const { engine, last } = setup('m');
  await engine.handle(users(['m', 7], ['a', 7]));
  await engine.handle({ type: 'ended' });
  assert.equal(FakePeer.all[0]!.closed, true);
  assert.equal(last().ended, 'ended');
  const t2 = setup('m');
  await t2.engine.handle({ type: 'lost', reason: 'conflict' });
  assert.equal(t2.last().ended, 'conflict');
  await t2.engine.handle(users(['m', 7], ['a', 7]));
  assert.equal(FakePeer.all.length, 0, 'ignored after the end');
});

test('MCU: publish to our own session (sendonly), request offers from publishers, answer receive-only', async () => {
  const { engine, sent, flush } = setup('m', 'mcu');
  await flush();
  const pub = FakePeer.all[0]!;
  assert.deepEqual(pub.tracks.map((t) => t.kind), ['audio', 'video']);
  assert.deepEqual(pub.offers[0], { offerToReceiveAudio: false, offerToReceiveVideo: false });
  assert.equal(sent[0]!.to, 'm');
  await engine.handle({ type: 'message', from: 'm', data: { type: 'answer', payload: { type: 'answer', sdp: 'mcu-answer' } } });
  assert.deepEqual(pub.remote, [{ type: 'answer', sdp: 'mcu-answer' }]);
  await engine.handle({ type: 'participants', full: false, users: [{ sessionId: 'p1', userId: 'bob', inCall: 7 }, { sessionId: 'p2', userId: 'carol', inCall: 1 }] });
  assert.deepEqual(sent.filter((s) => s.data.type === 'requestoffer').map((s) => s.to), ['p1'], 'p2 publishes nothing');
  await engine.handle({ type: 'message', from: 'p1', data: { type: 'offer', sid: 'x', payload: { type: 'offer', sdp: 'sub' } } });
  const sub = FakePeer.all[1]!;
  assert.equal(sub.tracks.length, 0, 'subscriber is receive-only');
  assert.equal(sent.at(-1)!.data.type, 'answer');
  assert.equal(sent.at(-1)!.to, 'p1');
});
