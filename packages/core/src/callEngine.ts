import { CALL_FLAG, type CallUser, type PeerMessage, type SignalEvent } from './call';

/**
 * Call engine: turns the signaling event stream into RTCPeerConnections and back.
 *
 * - Mesh (internal signaling, HPB without MCU): one connection per remote participant in the
 *   call. Like the Talk web client, the participant with the LARGER session id sends the offer
 *   to the smaller one; if no offer arrives in `offerFallbackMs` the smaller side offers instead
 *   (covers clients with a different rule). Offer glare: the larger side's offer wins.
 * - MCU (HPB + Janus): one sendonly "publisher" connection offered to OUR session id, and one
 *   receive-only subscriber per remote publisher requested with `requestoffer`.
 *
 * Media objects are platform types (browser WebRTC / react-native-webrtc); only the methods
 * below are used, so tests run with fakes and no real WebRTC.
 */

export interface SessionDescriptionLike {
  type: string;
  sdp?: string;
}
export interface IceCandidateLike {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}
export interface MediaTrackLike {
  readonly kind: string;
  enabled: boolean;
  stop(): void;
}
export interface MediaStreamLike {
  getTracks(): MediaTrackLike[];
  getAudioTracks(): MediaTrackLike[];
  getVideoTracks(): MediaTrackLike[];
}
export interface DataChannelLike {
  readonly readyState: string;
  send(data: string): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onopen: ((ev: unknown) => void) | null;
}
export interface RtcPeerLike {
  readonly signalingState: string;
  readonly iceConnectionState: string;
  createOffer(options?: Record<string, unknown>): Promise<SessionDescriptionLike>;
  createAnswer(): Promise<SessionDescriptionLike>;
  setLocalDescription(d: SessionDescriptionLike): Promise<void>;
  setRemoteDescription(d: SessionDescriptionLike): Promise<void>;
  addIceCandidate(c: IceCandidateLike): Promise<void>;
  addTrack(track: MediaTrackLike, stream: MediaStreamLike): unknown;
  addTransceiver?(kind: string, init: { direction: string }): unknown;
  createDataChannel?(label: string): DataChannelLike;
  close(): void;
  addEventListener(type: string, cb: (ev: any) => void): void;
}
export interface RtcConfig {
  iceServers: Array<{ urls: string[]; username?: string; credential?: string }>;
}
export type PeerFactory = (config: RtcConfig) => RtcPeerLike;

export type PeerConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface RemoteParticipant {
  sessionId: string;
  userId: string | null;
  displayName: string | null;
  inCall: number;
  state: PeerConnectionState | 'waiting';
  stream: MediaStreamLike | null;
  /** Mute state the remote announced (null = unknown → derive from call flags). */
  audio: boolean;
  video: boolean;
}

export interface CallEngineState {
  participants: RemoteParticipant[];
  /** A moderator ended the call, or our session is gone. */
  ended: null | 'ended' | 'session' | 'conflict' | 'kicked' | 'network';
  networkOk: boolean;
}

export interface CallEngineDeps {
  selfSessionId: string;
  mode: 'mesh' | 'mcu';
  createPeer: PeerFactory;
  iceServers: RtcConfig['iceServers'];
  send(to: string, data: PeerMessage): Promise<void>;
  localStream: MediaStreamLike | null;
  onChange(state: CallEngineState): void;
  nick?: string;
  offerFallbackMs?: number;
  /** Give a failed connection this long to recover via ICE restart before rebuilding it. */
  restartTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface Peer {
  key: string; // remote session id ('self' for the MCU publisher)
  to: string; // where signaling goes (MCU publisher: our own session)
  pc: RtcPeerLike;
  sid: string;
  offerer: boolean;
  publisher: boolean;
  remoteSet: boolean;
  pendingCandidates: IceCandidateLike[];
  state: PeerConnectionState;
  stream: MediaStreamLike | null;
  channel: DataChannelLike | null;
  restartTimer: unknown;
}

const newSid = () => `${Date.now()}${Math.floor(Math.random() * 1e9)}`;
const inCall = (u: { inCall: number }) => (u.inCall & CALL_FLAG.inCall) !== 0;
const publishes = (u: { inCall: number }) => (u.inCall & (CALL_FLAG.withAudio | CALL_FLAG.withVideo)) !== 0;

export class CallEngine {
  private users = new Map<string, CallUser>();
  private peers = new Map<string, Peer>();
  private mute = new Map<string, { audio?: boolean; video?: boolean }>();
  private fallback = new Map<string, unknown>();
  private requested = new Set<string>();
  private ended: CallEngineState['ended'] = null;
  private networkOk = true;
  private localAudio = true;
  private localVideo = true;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly d: CallEngineDeps) {
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.localAudio = !!d.localStream?.getAudioTracks().some((t) => t.enabled);
    this.localVideo = !!d.localStream?.getVideoTracks().some((t) => t.enabled);
    if (d.mode === 'mcu' && d.localStream && d.localStream.getTracks().length) void this.publish();
  }

  get state(): CallEngineState {
    const participants: RemoteParticipant[] = [];
    for (const u of this.users.values()) {
      if (u.sessionId === this.d.selfSessionId || !inCall(u)) continue;
      const p = this.peers.get(u.sessionId);
      const m = this.mute.get(u.sessionId) ?? {};
      participants.push({
        sessionId: u.sessionId,
        userId: u.userId,
        displayName: u.displayName ?? null,
        inCall: u.inCall,
        state: p ? p.state : 'waiting',
        stream: p?.stream ?? null,
        audio: m.audio ?? (u.inCall & CALL_FLAG.withAudio) !== 0,
        video: m.video ?? (u.inCall & CALL_FLAG.withVideo) !== 0,
      });
    }
    participants.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    return { participants, ended: this.ended, networkOk: this.networkOk };
  }

  private emit() {
    this.d.onChange(this.state);
  }

  /** Feed one signaling event. */
  async handle(ev: SignalEvent): Promise<void> {
    if (this.ended) return;
    switch (ev.type) {
      case 'participants': {
        if (ev.full) {
          const keep = new Set(ev.users.map((u) => u.sessionId));
          for (const id of [...this.users.keys()]) if (!keep.has(id)) this.users.delete(id);
        }
        for (const u of ev.users) {
          const prev = this.users.get(u.sessionId);
          this.users.set(u.sessionId, { ...prev, ...u, ...(u.displayName || !prev?.displayName ? {} : { displayName: prev.displayName }) });
        }
        await this.reconcile();
        break;
      }
      case 'left':
        for (const id of ev.sessionIds) this.users.delete(id);
        await this.reconcile();
        break;
      case 'message':
        await this.onMessage(ev.from, ev.data);
        break;
      case 'ended':
        this.finish('ended');
        return;
      case 'lost':
        this.finish(ev.reason);
        return;
      case 'network': {
        const recovered = ev.ok && !this.networkOk;
        this.networkOk = ev.ok;
        if (recovered) this.restartAll();
        break;
      }
    }
    this.emit();
  }

  /** Mute/unmute: toggles the local track and tells everyone (web clients show the icon). */
  setAudio(on: boolean) {
    this.localAudio = on;
    for (const t of this.d.localStream?.getAudioTracks() ?? []) t.enabled = on;
    this.broadcastMedia('audio', on);
  }

  setVideo(on: boolean) {
    this.localVideo = on;
    for (const t of this.d.localStream?.getVideoTracks() ?? []) t.enabled = on;
    this.broadcastMedia('video', on);
  }

  /** The network changed (Wi-Fi ↔ cellular): renegotiate ICE on every connection we offer. */
  networkChanged() {
    this.restartAll();
  }

  /** Close every connection (the caller leaves the call and closes signaling). */
  close() {
    for (const p of this.peers.values()) this.drop(p);
    this.peers.clear();
    for (const t of this.fallback.values()) this.clearTimer(t);
    this.fallback.clear();
  }

  private finish(reason: NonNullable<CallEngineState['ended']>) {
    this.ended = reason;
    this.close();
    this.emit();
  }

  private broadcastMedia(name: 'audio' | 'video', on: boolean) {
    for (const p of this.peers.values()) {
      if (p.publisher || this.d.mode === 'mesh') void this.d.send(p.to, { type: on ? 'unmute' : 'mute', roomType: 'video', payload: { name } }).catch(() => undefined);
      if (p.channel?.readyState === 'open') {
        try {
          p.channel.send(JSON.stringify({ type: `${name}${on ? 'On' : 'Off'}` }));
        } catch {
          /* closing */
        }
      }
    }
  }

  private async reconcile() {
    const self = this.users.get(this.d.selfSessionId);
    const selfIn = !self || inCall(self); // our own entry may lag behind the join
    for (const [key, p] of this.peers) {
      if (p.publisher) continue;
      const u = this.users.get(key);
      if (!u || !inCall(u) || !selfIn) {
        this.drop(p);
        this.peers.delete(key);
        this.mute.delete(key);
        this.requested.delete(key);
      }
    }
    if (!selfIn) return;
    for (const u of this.users.values()) {
      if (u.sessionId === this.d.selfSessionId || !inCall(u) || this.peers.has(u.sessionId)) continue;
      if (this.d.mode === 'mcu') {
        if (publishes(u) && !this.requested.has(u.sessionId)) {
          this.requested.add(u.sessionId);
          await this.d.send(u.sessionId, { type: 'requestoffer', roomType: 'video' }).catch(() => this.requested.delete(u.sessionId));
        }
      } else if (u.sessionId < this.d.selfSessionId) {
        await this.offer(u.sessionId);
      } else if (!this.fallback.has(u.sessionId)) {
        // We wait for their offer; offer ourselves if it never comes.
        const id = u.sessionId;
        this.fallback.set(id, this.setTimer(() => {
          this.fallback.delete(id);
          const still = this.users.get(id);
          if (!this.ended && still && inCall(still) && !this.peers.has(id)) void this.offer(id).then(() => this.emit());
        }, this.d.offerFallbackMs ?? 8_000));
      }
    }
  }

  private newPeer(key: string, to: string, offerer: boolean, publisher: boolean, sid: string): Peer {
    const pc = this.d.createPeer({ iceServers: this.d.iceServers });
    const peer: Peer = { key, to, pc, sid, offerer, publisher, remoteSet: false, pendingCandidates: [], state: 'connecting', stream: null, channel: null, restartTimer: null };
    pc.addEventListener('icecandidate', (e: { candidate?: IceCandidateLike | null }) => {
      const c = e.candidate;
      if (!c || !c.candidate) return; // end-of-candidates
      void this.d
        .send(to, { type: 'candidate', roomType: 'video', sid: peer.sid, payload: { candidate: { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null } } })
        .catch(() => undefined);
    });
    pc.addEventListener('track', (e: { streams?: MediaStreamLike[] }) => {
      const s = e.streams?.[0];
      if (s && peer.stream !== s) {
        peer.stream = s;
        this.emit();
      }
    });
    pc.addEventListener('iceconnectionstatechange', () => this.onIceState(peer));
    pc.addEventListener('datachannel', (e: { channel?: DataChannelLike }) => {
      if (e.channel) this.attachChannel(peer, e.channel);
    });
    // Mesh: every connection carries our media. MCU: only the publisher; subscribers receive.
    if (this.d.mode === 'mesh' || publisher) {
      const stream = this.d.localStream;
      for (const t of stream?.getTracks() ?? []) pc.addTrack(t, stream!);
    }
    return peer;
  }

  private attachChannel(peer: Peer, ch: DataChannelLike) {
    peer.channel = ch;
    ch.onopen = () => {
      try {
        ch.send(JSON.stringify({ type: this.localAudio ? 'audioOn' : 'audioOff' }));
        ch.send(JSON.stringify({ type: this.localVideo ? 'videoOn' : 'videoOff' }));
      } catch {
        /* closing */
      }
    };
    ch.onmessage = (e) => {
      let m: { type?: unknown };
      try {
        m = JSON.parse(String(e.data)) as { type?: unknown };
      } catch {
        return;
      }
      const map: Record<string, ['audio' | 'video', boolean]> = { audioOn: ['audio', true], audioOff: ['audio', false], videoOn: ['video', true], videoOff: ['video', false] };
      const hit = typeof m.type === 'string' ? map[m.type] : undefined;
      if (!hit) return;
      this.mute.set(peer.key, { ...this.mute.get(peer.key), [hit[0]]: hit[1] });
      this.emit();
    };
  }

  private async offer(remote: string, sid = newSid()) {
    const t = this.fallback.get(remote);
    if (t !== undefined) {
      this.clearTimer(t);
      this.fallback.delete(remote);
    }
    const peer = this.newPeer(remote, remote, true, false, sid);
    this.peers.set(remote, peer);
    if (peer.pc.createDataChannel) this.attachChannel(peer, peer.pc.createDataChannel('status'));
    await this.sendOffer(peer, false);
  }

  /** MCU: our sendonly publisher, offered to our own session. */
  private async publish() {
    const peer = this.newPeer('self', this.d.selfSessionId, true, true, newSid());
    this.peers.set('self', peer);
    await this.sendOffer(peer, false).catch(() => undefined);
  }

  private async sendOffer(peer: Peer, iceRestart: boolean) {
    const opts: Record<string, unknown> = peer.publisher ? { offerToReceiveAudio: false, offerToReceiveVideo: false } : { offerToReceiveAudio: true, offerToReceiveVideo: true };
    if (iceRestart) opts.iceRestart = true;
    const offer = await peer.pc.createOffer(opts);
    await peer.pc.setLocalDescription(offer);
    await this.d.send(peer.to, { type: 'offer', roomType: 'video', sid: peer.sid, payload: { type: 'offer', sdp: offer.sdp ?? '' }, ...(this.d.nick ? { nick: this.d.nick } : {}) });
  }

  private async onMessage(from: string, m: PeerMessage) {
    if (m.roomType && m.roomType !== 'video') return; // screen shares are not shown yet
    const key = from === this.d.selfSessionId ? 'self' : from;
    switch (m.type) {
      case 'offer': {
        const sdp = (m.payload as { sdp?: unknown } | undefined)?.sdp;
        if (typeof sdp !== 'string') return;
        let peer = this.peers.get(key);
        if (peer && peer.offerer && peer.pc.signalingState === 'have-local-offer') {
          // Glare: the larger session id's offer wins.
          if (from < this.d.selfSessionId) return;
          this.drop(peer);
          this.peers.delete(key);
          peer = undefined;
        }
        if (!peer) {
          peer = this.newPeer(key, from, false, false, typeof m.sid === 'string' ? m.sid : newSid());
          this.peers.set(key, peer);
          const t = this.fallback.get(key);
          if (t !== undefined) {
            this.clearTimer(t);
            this.fallback.delete(key);
          }
        } else if (typeof m.sid === 'string') peer.sid = m.sid;
        await peer.pc.setRemoteDescription({ type: 'offer', sdp });
        await this.flushCandidates(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        await this.d.send(from, { type: 'answer', roomType: 'video', sid: peer.sid, payload: { type: 'answer', sdp: answer.sdp ?? '' }, ...(this.d.nick ? { nick: this.d.nick } : {}) });
        break;
      }
      case 'answer': {
        const peer = this.peers.get(key);
        const sdp = (m.payload as { sdp?: unknown } | undefined)?.sdp;
        if (!peer || typeof sdp !== 'string' || peer.pc.signalingState !== 'have-local-offer') return;
        await peer.pc.setRemoteDescription({ type: 'answer', sdp });
        await this.flushCandidates(peer);
        break;
      }
      case 'candidate': {
        const peer = this.peers.get(key);
        const c = (m.payload as { candidate?: IceCandidateLike } | undefined)?.candidate;
        if (!peer || !c || typeof c.candidate !== 'string') return;
        if (!peer.remoteSet) peer.pendingCandidates.push(c);
        else await peer.pc.addIceCandidate(c).catch(() => undefined);
        break;
      }
      case 'mute':
      case 'unmute': {
        const name = (m.payload as { name?: unknown } | undefined)?.name;
        if (name !== 'audio' && name !== 'video') return;
        this.mute.set(key, { ...this.mute.get(key), [name]: m.type === 'unmute' });
        break;
      }
      default:
        return;
    }
  }

  private async flushCandidates(peer: Peer) {
    peer.remoteSet = true;
    const list = peer.pendingCandidates;
    peer.pendingCandidates = [];
    for (const c of list) await peer.pc.addIceCandidate(c).catch(() => undefined);
  }

  private onIceState(peer: Peer) {
    if (this.peers.get(peer.key) !== peer) return;
    const s = peer.pc.iceConnectionState;
    const prev = peer.state;
    if (s === 'connected' || s === 'completed') {
      peer.state = 'connected';
      if (peer.restartTimer !== null) this.clearTimer(peer.restartTimer);
      peer.restartTimer = null;
    } else if (s === 'disconnected') {
      peer.state = 'reconnecting';
    } else if (s === 'failed') {
      peer.state = 'reconnecting';
      this.restart(peer);
    }
    if (peer.state !== prev) this.emit();
  }

  /** ICE restart from the offering side; rebuild the connection if that does not help in time. */
  private restart(peer: Peer) {
    if (!peer.offerer || this.ended) return;
    void this.sendOffer(peer, true).catch(() => undefined);
    if (peer.restartTimer !== null) return;
    peer.restartTimer = this.setTimer(() => {
      peer.restartTimer = null;
      if (this.peers.get(peer.key) !== peer || peer.state === 'connected' || this.ended) return;
      this.drop(peer);
      this.peers.delete(peer.key);
      if (peer.publisher) void this.publish().then(() => this.emit());
      else void this.offer(peer.key).then(() => this.emit());
    }, this.d.restartTimeoutMs ?? 15_000);
  }

  private restartAll() {
    for (const p of this.peers.values()) if (p.offerer) this.restart(p);
  }

  private drop(p: Peer) {
    if (p.restartTimer !== null) this.clearTimer(p.restartTimer);
    p.restartTimer = null;
    try {
      p.channel?.close();
    } catch {
      /* ignore */
    }
    try {
      p.pc.close();
    } catch {
      /* ignore */
    }
  }
}
