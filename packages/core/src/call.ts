import { OcsError, type OcsClient } from './ocs';
import { assertRoomToken, reconnectDelay, ROOM_TYPE, isModeratorType, type TalkRoom } from './talk';

/**
 * Talk audio/video calls — the platform-independent part: capability + room gates, the call
 * OCS endpoints and both signaling transports (internal long-poll, external HPB websocket),
 * normalised into ONE event stream (`SignalEvent`). Media (RTCPeerConnection) lives in
 * `callEngine.ts`; this file never touches media.
 *
 * Wire formats follow the Talk web client (`src/utils/signaling.js`) so mixed calls with the
 * web client and the official mobile apps interoperate.
 */

const CALL_API = '/ocs/v2.php/apps/spreed/api/v4/call';
const ROOM_API = '/ocs/v2.php/apps/spreed/api/v4/room';
const SIGNALING_API = '/ocs/v2.php/apps/spreed/api/v3/signaling';

/** `inCall` / call flags (Talk `Participant::FLAG_*`). */
export const CALL_FLAG = { disconnected: 0, inCall: 1, withAudio: 2, withVideo: 4, withPhone: 8 } as const;
/** Attendee permission bits (Talk `Attendee::PERMISSIONS_*`). */
export const CALL_PERMISSION = { startCall: 2, joinCall: 4, lobbyIgnore: 8, publishAudio: 16, publishVideo: 32, publishScreen: 64 } as const;

// ---- Capabilities and gates ---------------------------------------------------------

export interface CallCapabilities {
  /** `spreed.config.call.enabled` (admin can switch calls off instance-wide). */
  enabled: boolean;
  audio: boolean;
  video: boolean;
  /** `signaling-v3`: the signaling settings/pull endpoints we speak. */
  signalingV3: boolean;
  /** `call-notification-state-api`: is a ring still active (incoming call screen). */
  ringState: boolean;
  /** `silent-call`. */
  silent: boolean;
}

export function callCapabilitiesOf(features: Iterable<string>, callConfig: unknown): CallCapabilities {
  const f = new Set(features);
  const cfg = (callConfig ?? {}) as Record<string, unknown>;
  return {
    // Missing config (very old Talk) → enabled only when the feature flags say so; explicit false wins.
    enabled: cfg.enabled !== false && (cfg.enabled === true || f.has('audio') || f.has('video')),
    audio: f.has('audio'),
    video: f.has('video'),
    signalingV3: f.has('signaling-v3'),
    ringState: f.has('call-notification-state-api'),
    silent: f.has('silent-call'),
  };
}

export type CallBlockReason =
  | 'server_disabled' // calls switched off on the server
  | 'feature_missing' // Talk too old / no audio or signaling-v3
  | 'room_type' // note-to-self, changelog, former one-to-one
  | 'read_only'
  | 'lobby'
  | 'no_permission'; // cannot start (no call running) / cannot join (call running)

/** Room fields the call gate reads (v4 room DTO). Missing → fail closed. */
export type CallRoomGate = Pick<TalkRoom, 'type' | 'readOnly' | 'participantType' | 'permissions'> & {
  hasCall?: boolean;
  callFlag?: number;
  canStartCall?: boolean;
  lobbyState?: number;
};

export interface CallGate {
  /** A call button may be shown (false → hide it and show `reason`). */
  available: boolean;
  reason: CallBlockReason | null;
  /** A call is running in this room right now. */
  hasCall: boolean;
  /** Pressing "call" will work: start a new call or join the running one. */
  canJoin: boolean;
  /** May publish microphone / camera in this room. */
  audio: boolean;
  video: boolean;
}

export function callGate(room: CallRoomGate, caps: CallCapabilities): CallGate {
  const perm = (bit: number) => typeof room.permissions === 'number' && (room.permissions & bit) !== 0;
  const hasCall = room.hasCall === true;
  const blocked = (reason: CallBlockReason): CallGate => ({ available: false, reason, hasCall, canJoin: false, audio: false, video: false });
  if (!caps.enabled) return blocked('server_disabled');
  if (!caps.audio || !caps.signalingV3) return blocked('feature_missing');
  if (room.type !== ROOM_TYPE.oneToOne && room.type !== ROOM_TYPE.group && room.type !== ROOM_TYPE.public) return blocked('room_type');
  if (room.readOnly !== 0) return blocked('read_only');
  if (room.lobbyState === 1 && !isModeratorType(room.participantType) && !perm(CALL_PERMISSION.lobbyIgnore)) return blocked('lobby');
  const canJoin = hasCall ? perm(CALL_PERMISSION.joinCall) : room.canStartCall === true;
  if (!canJoin) return { ...blocked('no_permission') };
  return {
    available: true,
    reason: null,
    hasCall,
    canJoin,
    audio: perm(CALL_PERMISSION.publishAudio),
    video: caps.video && perm(CALL_PERMISSION.publishVideo),
  };
}

/** Flags announced when joining: never more than the room allows. */
export function joinFlags(gate: Pick<CallGate, 'audio' | 'video'>, want: { audio: boolean; video: boolean }): number {
  return CALL_FLAG.inCall | (want.audio && gate.audio ? CALL_FLAG.withAudio : 0) | (want.video && gate.video ? CALL_FLAG.withVideo : 0);
}

// ---- Signaling settings ---------------------------------------------------------------

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface SignalingSettings {
  mode: 'internal' | 'external';
  /** External signaling server base URL (https://…), `null` for internal. */
  server: string | null;
  /** `helloAuthParams`: v1 `{userid, ticket}` / v2 `{token}`. */
  helloV1: { userid: string | null; ticket: string } | null;
  helloV2: { token: string } | null;
  iceServers: IceServer[];
}

const ICE_URL = /^(stun|turns?):[^\s]{1,250}$/i;
const iceList = (raw: unknown, withAuth: boolean): IceServer[] => {
  if (!Array.isArray(raw)) return [];
  const out: IceServer[] = [];
  for (const s of raw.slice(0, 16)) {
    if (!s || typeof s !== 'object') continue;
    const r = s as Record<string, unknown>;
    const urls = (Array.isArray(r.urls) ? r.urls : typeof r.urls === 'string' ? [r.urls] : typeof r.url === 'string' ? [r.url] : [])
      .filter((u): u is string => typeof u === 'string' && ICE_URL.test(u))
      .slice(0, 8);
    if (!urls.length) continue;
    const entry: IceServer = { urls };
    if (withAuth && typeof r.username === 'string' && typeof r.credential === 'string') {
      entry.username = r.username;
      entry.credential = r.credential;
    }
    out.push(entry);
  }
  return out;
};

export function parseSignalingSettings(raw: unknown): SignalingSettings {
  const r = (raw ?? {}) as Record<string, any>;
  const server = typeof r.server === 'string' && /^https?:\/\/[^\s]+$/i.test(r.server) ? r.server : null;
  const external = (r.signalingMode === 'external' || r.signalingMode === 'conversation_cluster') && server !== null;
  const h = (r.helloAuthParams ?? {}) as Record<string, any>;
  const v1 = h['1.0'] && typeof h['1.0'].ticket === 'string' ? { userid: typeof h['1.0'].userid === 'string' ? h['1.0'].userid : null, ticket: h['1.0'].ticket as string } : null;
  const v2 = h['2.0'] && typeof h['2.0'].token === 'string' ? { token: h['2.0'].token as string } : null;
  // Older servers only send `ticket` at the top level (hello v1).
  const legacy = !v1 && typeof r.ticket === 'string' ? { userid: typeof r.userId === 'string' ? r.userId : null, ticket: r.ticket as string } : null;
  return {
    mode: external ? 'external' : 'internal',
    server: external ? server : null,
    helloV1: v1 ?? legacy,
    helloV2: v2,
    iceServers: [...iceList(r.stunservers, false), ...iceList(r.turnservers, true)],
  };
}

/** `wss://host/path/spreed` for the HPB base URL (same rule as the web client). */
export function signalingWebSocketUrl(server: string): string {
  let url = server.trim().replace(/^http/i, 'ws').replace(/\/+$/, '');
  if (!url.endsWith('/spreed')) url += '/spreed';
  return url;
}

// ---- Call OCS endpoints ---------------------------------------------------------------

export interface CallParticipant {
  actorType: string;
  actorId: string;
  displayName: string;
  sessionId: string;
  lastPing: number;
}

export const callApi = {
  async settings(c: OcsClient, token: string): Promise<SignalingSettings> {
    return parseSignalingSettings(await c.get<unknown>(`${SIGNALING_API}/settings`, { query: { token: assertRoomToken(token) } }));
  },
  /** Joins the conversation (a session); with internal signaling this session also signals. */
  async joinRoom(c: OcsClient, token: string): Promise<{ sessionId: string }> {
    const r = await c.request<{ sessionId?: unknown }>(`${ROOM_API}/${assertRoomToken(token)}/participants/active`, { method: 'POST', body: { force: false } });
    const sessionId = r.data?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId || sessionId === '0') throw new OcsError('invalid_response', r.status);
    return { sessionId };
  },
  async leaveRoom(c: OcsClient, token: string): Promise<void> {
    await c.request(`${ROOM_API}/${assertRoomToken(token)}/participants/active`, { method: 'DELETE' });
  },
  async join(c: OcsClient, token: string, flags: number, opts: { silent?: boolean } = {}): Promise<void> {
    await c.request(`${CALL_API}/${assertRoomToken(token)}`, { method: 'POST', body: { flags, ...(opts.silent ? { silent: true } : {}) } });
  },
  async update(c: OcsClient, token: string, flags: number): Promise<void> {
    await c.request(`${CALL_API}/${assertRoomToken(token)}`, { method: 'PUT', body: { flags } });
  },
  /** `all` (moderators): end the call for everyone. */
  async leave(c: OcsClient, token: string, all = false): Promise<void> {
    await c.request(`${CALL_API}/${assertRoomToken(token)}`, { method: 'DELETE', ...(all ? { body: { all: true } } : {}) });
  },
  async participants(c: OcsClient, token: string): Promise<CallParticipant[]> {
    const r = await c.request<unknown[]>(`${CALL_API}/${assertRoomToken(token)}`);
    return (Array.isArray(r.data) ? r.data : []).flatMap((x) => {
      const p = (x ?? {}) as Record<string, unknown>;
      if (typeof p.sessionId !== 'string') return [];
      return [{ actorType: String(p.actorType ?? ''), actorId: String(p.actorId ?? ''), displayName: String(p.displayName ?? ''), sessionId: p.sessionId, lastPing: Number(p.lastPing) || 0 }];
    });
  },
  /**
   * `call-notification-state-api`: 200 → the call still rings for this user, 201 → not any more
   * (answered elsewhere, ended, declined), 404 → no such room/participant.
   */
  async ringing(c: OcsClient, token: string): Promise<boolean> {
    try {
      const r = await c.request(`${CALL_API}/${assertRoomToken(token)}/notification-state`);
      return r.status === 200;
    } catch (e) {
      if (e instanceof OcsError && e.kind === 'not_found') return false;
      throw e;
    }
  },
};

// ---- Normalised signaling events --------------------------------------------------------

/** A peer-to-peer signaling payload (offer/answer/candidate/mute…), as the web client sends it. */
export interface PeerMessage {
  type: string;
  roomType?: 'video' | 'screen';
  sid?: string;
  payload?: unknown;
  /** Display name some clients attach to offers. */
  nick?: string;
  [key: string]: unknown;
}

export interface CallUser {
  /** Signaling session (internal: the Nextcloud session; HPB: the signaling session). */
  sessionId: string;
  userId: string | null;
  inCall: number;
  displayName?: string;
}

export type SignalEvent =
  /** `full`: complete list of sessions in the room (internal); otherwise a partial update (HPB). */
  | { type: 'participants'; users: CallUser[]; full: boolean }
  | { type: 'left'; sessionIds: string[] }
  | { type: 'message'; from: string; data: PeerMessage }
  /** A moderator ended the call for everyone. */
  | { type: 'ended' }
  /** Transport health (UI hint only). */
  | { type: 'network'; ok: boolean }
  /** The session is gone: `conflict` = joined from another device, `kicked` = removed. Final. */
  | { type: 'lost'; reason: 'session' | 'conflict' | 'kicked' | 'network' };

const SESSION_RE = /^[\w+/=.-]{1,512}$/;
const isSession = (v: unknown): v is string => typeof v === 'string' && SESSION_RE.test(v);

function userOf(raw: unknown): CallUser | null {
  const u = (raw ?? {}) as Record<string, unknown>;
  // Internal uses `sessionId`; some HPB versions `sessionid`.
  const sessionId = u.sessionId ?? u.sessionid;
  if (!isSession(sessionId)) return null;
  const userId = typeof u.userId === 'string' ? u.userId : typeof u.userid === 'string' ? u.userid : typeof u.actorId === 'string' && u.actorType === 'users' ? u.actorId : null;
  const user = (u.user ?? {}) as Record<string, unknown>;
  const displayName = typeof u.displayName === 'string' ? u.displayName : typeof user.displayname === 'string' ? user.displayname : undefined;
  const inCall = Number.isInteger(u.inCall) ? (u.inCall as number) : typeof u.inCall === 'boolean' ? (u.inCall ? CALL_FLAG.inCall | CALL_FLAG.withAudio : 0) : 0;
  return { sessionId, userId: userId || null, inCall, ...(displayName ? { displayName } : {}) };
}

function peerMessageOf(raw: unknown): PeerMessage | null {
  let d = raw;
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  if (!d || typeof d !== 'object' || typeof (d as PeerMessage).type !== 'string') return null;
  return d as PeerMessage;
}

/** Internal signaling pull (`GET /api/v3/signaling/{token}` data array) → events. */
export function parseInternalPull(data: unknown): SignalEvent[] {
  if (!Array.isArray(data)) return [];
  const out: SignalEvent[] = [];
  for (const item of data) {
    const m = (item ?? {}) as { type?: unknown; data?: unknown };
    if (m.type === 'usersInRoom' && Array.isArray(m.data)) {
      out.push({ type: 'participants', users: m.data.map(userOf).filter((u): u is CallUser => !!u), full: true });
    } else if (m.type === 'message') {
      const msg = peerMessageOf(m.data);
      const from = msg && (msg as { from?: unknown }).from;
      if (msg && isSession(from)) out.push({ type: 'message', from, data: msg });
    }
  }
  return out;
}

/** One HPB websocket frame → events (+ the hello/room/error replies the transport waits for). */
export function parseExternalFrame(frame: unknown): SignalEvent[] {
  const f = (frame ?? {}) as Record<string, any>;
  if (f.type === 'message') {
    const sender = f.message?.sender?.sessionid;
    const msg = peerMessageOf(f.message?.data);
    return msg && isSession(sender) ? [{ type: 'message', from: sender, data: msg }] : [];
  }
  if (f.type === 'event') {
    const e = f.event ?? {};
    if (e.target === 'room' && e.type === 'join' && Array.isArray(e.join)) {
      return [{ type: 'participants', users: e.join.map(userOf).filter((u: CallUser | null): u is CallUser => !!u), full: false }];
    }
    if (e.target === 'room' && e.type === 'leave' && Array.isArray(e.leave)) {
      return [{ type: 'left', sessionIds: e.leave.filter(isSession) }];
    }
    if (e.target === 'participants' && e.type === 'update') {
      const u = e.update ?? {};
      if (u.all === true && Number(u.incall) === 0) return [{ type: 'ended' }];
      return Array.isArray(u.users) ? [{ type: 'participants', users: u.users.map(userOf).filter((x: CallUser | null): x is CallUser => !!x), full: false }] : [];
    }
    return [];
  }
  if (f.type === 'bye') return [{ type: 'lost', reason: 'kicked' }];
  return [];
}

// ---- Transports -------------------------------------------------------------------------

/** One signaling session for one call. `next` long-polls events (empty array on timeout). */
export interface CallSignaling {
  readonly sessionId: string;
  readonly mode: 'internal' | 'external';
  /** HPB with an MCU (Janus): publish to self, `requestoffer` subscribers. */
  readonly mcu: boolean;
  send(to: string, data: PeerMessage): Promise<void>;
  next(timeoutMs: number, signal?: AbortSignal): Promise<SignalEvent[]>;
  close(): Promise<void>;
}

/** FIFO of events with a single blocking reader (`take`). */
export class EventQueue {
  private items: SignalEvent[] = [];
  private waiter: (() => void) | null = null;
  closed = false;

  push(...events: SignalEvent[]) {
    if (!events.length) return;
    this.items.push(...events);
    this.wake();
  }

  close() {
    this.closed = true;
    this.wake();
  }

  private wake() {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  async take(timeoutMs: number, signal?: AbortSignal): Promise<SignalEvent[]> {
    if (!this.items.length && !this.closed && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          if (this.waiter === done) this.waiter = null;
          resolve();
        };
        const timer = setTimeout(done, Math.max(0, Math.min(timeoutMs, 60_000)));
        signal?.addEventListener('abort', done);
        // A second reader replaces the first (the first just returns empty).
        const prev = this.waiter;
        this.waiter = done;
        prev?.();
      });
    }
    const out = this.items;
    this.items = [];
    return out;
  }
}

export interface InternalSignalingOptions {
  /** Delay before batching outgoing messages into one POST (candidates arrive in bursts). */
  batchMs?: number;
  pullTimeoutMs?: number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * Internal (PHP) signaling: the Nextcloud room session doubles as the signaling session;
 * messages long-poll `GET /api/v3/signaling/{token}` and go out with `POST` (JSON-in-JSON,
 * exactly like the web client).
 */
export async function startInternalSignaling(c: OcsClient, token: string, opts: InternalSignalingOptions = {}): Promise<CallSignaling> {
  assertRoomToken(token);
  const { sessionId } = await callApi.joinRoom(c, token);
  const queue = new EventQueue();
  const stop = new AbortController();
  const sleep = opts.sleep ?? defaultSleep;
  let outbox: Array<{ ev: 'message'; fn: string; sessionId: string }> = [];
  let flushing: Promise<void> | null = null;

  const flush = async () => {
    await sleep(opts.batchMs ?? 30, stop.signal);
    const messages = outbox;
    outbox = [];
    flushing = null;
    if (!messages.length || stop.signal.aborted) return;
    await c.request(`${SIGNALING_API}/${token}`, { method: 'POST', body: { messages: JSON.stringify(messages) } });
  };

  void (async () => {
    let failures = 0;
    while (!stop.signal.aborted) {
      try {
        const r = await c.request<unknown>(`${SIGNALING_API}/${token}`, { signal: stop.signal, timeoutMs: opts.pullTimeoutMs ?? 40_000 });
        if (failures) queue.push({ type: 'network', ok: true });
        failures = 0;
        queue.push(...parseInternalPull(r.data));
      } catch (e) {
        if (stop.signal.aborted) break;
        const kind = e instanceof OcsError ? e.kind : 'network';
        if (kind === 'not_found' || kind === 'unauthorized' || kind === 'forbidden') {
          queue.push({ type: 'lost', reason: 'session' });
          break;
        }
        if (kind === 'conflict') {
          queue.push({ type: 'lost', reason: 'conflict' });
          break;
        }
        if (failures === 0) queue.push({ type: 'network', ok: false });
        await sleep(reconnectDelay(failures++, opts.random), stop.signal);
      }
    }
  })();

  return {
    sessionId,
    mode: 'internal',
    mcu: false,
    async send(to, data) {
      if (stop.signal.aborted) return;
      outbox.push({ ev: 'message', fn: JSON.stringify({ ...data, to }), sessionId });
      flushing ??= flush();
      await flushing;
    },
    next: (timeoutMs, signal) => queue.take(timeoutMs, signal),
    async close() {
      if (stop.signal.aborted) return;
      stop.abort();
      queue.close();
      await callApi.leaveRoom(c, token).catch(() => undefined);
    },
  };
}

/** The subset of the WebSocket API we use (browser, React Native and Node ≥ 22 all provide it). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

export interface ExternalSignalingOptions {
  webSocket: WebSocketFactory;
  timeoutMs?: number;
}

/**
 * External signaling (HPB, nextcloud-spreed-signaling): hello (v2 token, fallback v1 ticket) →
 * Nextcloud room session → `room` join with that session. One resume attempt after a dropped
 * socket; after that the session is reported lost (the UI offers to rejoin).
 */
export async function startExternalSignaling(c: OcsClient, token: string, settings: SignalingSettings, opts: ExternalSignalingOptions): Promise<CallSignaling> {
  assertRoomToken(token);
  if (!settings.server) throw new OcsError('client', undefined, undefined, undefined, 'SIGNALING_UNAVAILABLE');
  const url = signalingWebSocketUrl(settings.server);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const queue = new EventQueue();
  let ws: WebSocketLike;
  let seq = 0;
  let closed = false;
  let resumeId: string | null = null;
  let signalingSession = '';
  let mcu = false;
  let ncJoined = false;
  /** Replies we wait for, keyed by request id. */
  const pending = new Map<string, { resolve: (f: Record<string, any>) => void; reject: (e: unknown) => void }>();

  const request = (msg: Record<string, unknown>) =>
    new Promise<Record<string, any>>((resolve, reject) => {
      const id = String(++seq);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new OcsError('timeout'));
      }, timeoutMs);
      pending.set(id, {
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ ...msg, id }));
    });

  const onFrame = (raw: unknown) => {
    let f: Record<string, any>;
    try {
      f = JSON.parse(String(raw)) as Record<string, any>;
    } catch {
      return;
    }
    const waiting = typeof f.id === 'string' ? pending.get(f.id) : undefined;
    if (waiting) {
      pending.delete(f.id);
      if (f.type === 'error') waiting.reject(new OcsError('client', undefined, String(f.error?.message ?? ''), undefined, String(f.error?.code ?? 'SIGNALING_ERROR')));
      else waiting.resolve(f);
      return;
    }
    if (f.type === 'error') {
      const code = String(f.error?.code ?? '');
      if (code === 'no_such_session' || code === 'processing_failed' || code === 'duplicate_session') queue.push({ type: 'lost', reason: code === 'duplicate_session' ? 'conflict' : 'session' });
      return;
    }
    queue.push(...parseExternalFrame(f));
  };

  const open = () =>
    new Promise<void>((resolve, reject) => {
      const sock = opts.webSocket(url);
      ws = sock;
      const timer = setTimeout(() => reject(new OcsError('timeout')), timeoutMs);
      sock.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      sock.onerror = () => {
        clearTimeout(timer);
        reject(new OcsError('network'));
      };
      sock.onmessage = (ev) => onFrame(ev.data);
      sock.onclose = () => {
        if (ws !== sock) return;
        for (const p of pending.values()) p.reject(new OcsError('network'));
        pending.clear();
        if (!closed) void resume();
      };
    });

  const hello = async (resume: string | null) => {
    const auth = settings.helloV2
      ? { version: '2.0', auth: { url: c.url(`${SIGNALING_API}/backend`), params: settings.helloV2 } }
      : { version: '1.0', auth: { url: c.url(`${SIGNALING_API}/backend`), params: settings.helloV1 ?? {} } };
    const r = await request({ type: 'hello', hello: resume ? { version: auth.version, resumeid: resume } : auth });
    const h = r.hello ?? {};
    if (!isSession(h.sessionid)) throw new OcsError('invalid_response');
    signalingSession = h.sessionid;
    resumeId = typeof h.resumeid === 'string' ? h.resumeid : null;
    mcu = Array.isArray(h.server?.features) && h.server.features.includes('mcu');
  };

  let resuming = false;
  const resume = async () => {
    if (resuming || closed) return;
    resuming = true;
    queue.push({ type: 'network', ok: false });
    const previous = signalingSession;
    try {
      await open();
      await hello(resumeId);
      // A resumed hello keeps the session (and its room); a new one would break every peer.
      if (signalingSession !== previous) throw new OcsError('invalid_response');
      queue.push({ type: 'network', ok: true });
    } catch {
      queue.push({ type: 'lost', reason: 'network' });
    } finally {
      resuming = false;
    }
  };

  try {
    await open();
    await hello(null);
    const { sessionId: ncSession } = await callApi.joinRoom(c, token);
    ncJoined = true;
    await request({ type: 'room', room: { roomid: token, sessionid: ncSession } });
  } catch (e) {
    closed = true;
    try {
      ws!.close();
    } catch {
      /* already closed */
    }
    if (ncJoined) await callApi.leaveRoom(c, token).catch(() => undefined);
    throw e;
  }

  return {
    get sessionId() {
      return signalingSession;
    },
    mode: 'external',
    get mcu() {
      return mcu;
    },
    async send(to, data) {
      if (closed || ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type: 'message', message: { recipient: { type: 'session', sessionid: to }, data: { ...data, to } } }));
    },
    next: (t, signal) => queue.take(t, signal),
    async close() {
      if (closed) return;
      closed = true;
      queue.close();
      try {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'bye', bye: {} }));
        ws.close();
      } catch {
        /* ignore */
      }
      await callApi.leaveRoom(c, token).catch(() => undefined);
    },
  };
}

/** Pick the transport the server announced. */
export async function startSignaling(c: OcsClient, token: string, settings: SignalingSettings, opts: { webSocket?: WebSocketFactory } & InternalSignalingOptions = {}): Promise<CallSignaling> {
  if (settings.mode === 'external') {
    if (!opts.webSocket) throw new OcsError('forbidden', 403, undefined, undefined, 'SIGNALING_UNSUPPORTED');
    return startExternalSignaling(c, token, settings, { webSocket: opts.webSocket });
  }
  return startInternalSignaling(c, token, opts);
}
