import { OcsError, type OcsClient } from './ocs';

const ROOM_API = '/ocs/v2.php/apps/spreed/api/v4/room';
const CHAT_API = '/ocs/v2.php/apps/spreed/api/v1/chat';

export interface TalkRoom {
  token: string;
  type: number;
  name: string;
  displayName: string;
  unreadMessages: number;
  unreadMention: boolean;
  isFavorite: boolean;
  lastActivity: number;
  readOnly: number;
  lastMessage?: TalkMessage | Record<string, never>;
}

export interface RichObject {
  type: string;
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface TalkMessage {
  id: number;
  token: string;
  actorType: string;
  actorId: string;
  actorDisplayName: string;
  timestamp: number;
  message: string;
  messageParameters: Record<string, RichObject> | [];
  systemMessage: string;
  messageType: string;
  referenceId?: string;
  parent?: TalkMessage;
}

/** Room tokens are short alphanumerics; validate before they go into a URL path (trust boundary). */
export function assertRoomToken(token: string): string {
  if (!/^[a-z0-9]{1,64}$/i.test(token)) throw new OcsError('client', undefined, 'invalid room token');
  return token;
}

// ---- Rooms ----------------------------------------------------------------

export interface RoomListResult {
  rooms: TalkRoom[];
  /** Pass back as `modifiedSince` (server clock, never the client clock). */
  modifiedBefore: number | null;
  /** When it changes, capabilities/signaling settings must be refreshed. */
  talkHash: string | null;
}

export async function listRooms(client: OcsClient, opts: { modifiedSince?: number; signal?: AbortSignal } = {}): Promise<RoomListResult> {
  const res = await client.request<TalkRoom[]>(ROOM_API, {
    query: { modifiedSince: opts.modifiedSince, includeStatus: true },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const mb = Number(res.headers.get('X-Nextcloud-Talk-Modified-Before'));
  return {
    rooms: res.data ?? [],
    modifiedBefore: Number.isFinite(mb) && mb > 0 ? mb : null,
    talkHash: res.headers.get('X-Nextcloud-Talk-Hash'),
  };
}

/** Delta results never report removals, so `full` lists replace, deltas upsert. */
export function mergeRooms(prev: readonly TalkRoom[], next: readonly TalkRoom[], mode: 'full' | 'delta'): TalkRoom[] {
  const map = new Map<string, TalkRoom>(mode === 'full' ? [] : prev.map((r) => [r.token, r]));
  for (const r of next) map.set(r.token, r);
  return [...map.values()].sort((a, b) => Number(b.isFavorite) - Number(a.isFavorite) || b.lastActivity - a.lastActivity);
}

// ---- Chat -----------------------------------------------------------------

export interface ChatFetchResult {
  messages: TalkMessage[];
  /** `X-Chat-Last-Given`: cursor for the next request. Null on 304 (keep the old cursor). */
  lastGiven: number | null;
  notModified: boolean;
}

export interface ChatFetchOptions {
  lookIntoFuture: boolean;
  lastKnownMessageId?: number;
  limit?: number;
  /** Long-poll timeout in seconds (server max 60). */
  timeout?: number;
  /** Passive fetches must not move the read marker; only a visible, focused chat marks read. */
  setReadMarker?: boolean;
  /** Only sent when the server supports `chat-keep-notifications`. */
  markNotificationsAsRead?: boolean;
  signal?: AbortSignal;
}

export async function fetchChat(client: OcsClient, token: string, o: ChatFetchOptions): Promise<ChatFetchResult> {
  const res = await client.request<TalkMessage[]>(`${CHAT_API}/${assertRoomToken(token)}`, {
    query: {
      lookIntoFuture: o.lookIntoFuture,
      lastKnownMessageId: o.lastKnownMessageId,
      limit: Math.min(o.limit ?? 100, 200),
      timeout: o.lookIntoFuture ? Math.min(o.timeout ?? 30, 60) : undefined,
      setReadMarker: o.setReadMarker ?? false,
      markNotificationsAsRead: o.markNotificationsAsRead,
      includeLastKnown: false,
    },
    // long-poll: give the server its full timeout plus a margin before aborting locally
    timeoutMs: ((o.lookIntoFuture ? Math.min(o.timeout ?? 30, 60) : 0) + 15) * 1000,
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (res.status === 304) return { messages: [], lastGiven: null, notModified: true };
  const lg = Number(res.headers.get('X-Chat-Last-Given'));
  return { messages: res.data ?? [], lastGiven: Number.isFinite(lg) && lg > 0 ? lg : null, notModified: false };
}

/** 64 hex chars, the format Talk expects for `referenceId`. */
export function newReferenceId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sendMessage(
  client: OcsClient,
  token: string,
  body: { message: string; referenceId?: string; replyTo?: number; silent?: boolean },
  signal?: AbortSignal,
): Promise<TalkMessage | null> {
  const res = await client.request<TalkMessage>(`${CHAT_API}/${assertRoomToken(token)}`, {
    method: 'POST',
    body,
    ...(signal ? { signal } : {}),
  });
  return res.data;
}

export async function markRead(client: OcsClient, token: string, lastReadMessage: number): Promise<void> {
  await client.request(`${CHAT_API}/${assertRoomToken(token)}/read`, { method: 'POST', body: { lastReadMessage } });
}

// ---- Optimistic timeline merge ---------------------------------------------

export type PendingState = 'sending' | 'failed' | 'unknown';

export type ChatItem =
  | { kind: 'server'; message: TalkMessage }
  | { kind: 'pending'; referenceId: string; text: string; state: PendingState; createdAt: number };

/**
 * Merge server messages into a timeline.
 * - Duplicate server ids collapse (history + long-poll overlap).
 * - A server message with a pending item's `referenceId` replaces it: a send whose HTTP
 *   result was lost (`unknown`) is reconciled by the poll, not re-sent.
 * - Pending items stay at the end in creation order.
 */
export function mergeTimeline(items: readonly ChatItem[], incoming: readonly TalkMessage[]): ChatItem[] {
  const byId = new Map<number, TalkMessage>();
  const pending: Extract<ChatItem, { kind: 'pending' }>[] = [];
  for (const it of items) {
    if (it.kind === 'server') byId.set(it.message.id, it.message);
    else pending.push(it);
  }
  for (const m of incoming) byId.set(m.id, m);
  const confirmedRefs = new Set<string>();
  for (const m of byId.values()) if (m.referenceId) confirmedRefs.add(m.referenceId);
  const server: ChatItem[] = [...byId.values()].sort((a, b) => a.id - b.id).map((message) => ({ kind: 'server', message }));
  return [...server, ...pending.filter((p) => !confirmedRefs.has(p.referenceId)).sort((a, b) => a.createdAt - b.createdAt)];
}

export function setPendingState(items: readonly ChatItem[], referenceId: string, state: PendingState): ChatItem[] {
  return items.map((it) => (it.kind === 'pending' && it.referenceId === referenceId ? { ...it, state } : it));
}

/**
 * Retry is only offered for `failed` (server definitely rejected / never reached) — for
 * `unknown` the UI must first reconcile via a fetch; otherwise a duplicate could be sent.
 */
export function classifySendFailure(err: unknown): PendingState {
  if (err instanceof OcsError) {
    if (err.kind === 'timeout' || err.kind === 'network' || err.kind === 'aborted' || err.kind === 'server') return 'unknown';
    return 'failed';
  }
  return 'unknown';
}

export function lastServerId(items: readonly ChatItem[]): number | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.kind === 'server') return it.message.id;
  }
  return undefined;
}

// ---- Rich object rendering (no HTML) ----------------------------------------

export type MessageSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; text: string; mentionType: 'user' | 'call' | 'group' | 'guest' | 'federated'; id: string }
  | { type: 'file'; text: string; id: string }
  | { type: 'object'; text: string };

const MENTION_TYPES: Record<string, Extract<MessageSegment, { type: 'mention' }>['mentionType']> = {
  user: 'user',
  call: 'call',
  'user-group': 'group',
  group: 'group',
  guest: 'guest',
  email: 'guest',
  'federated-user': 'federated',
};

/**
 * Splits `{placeholder}` rich-object strings into typed segments. Unknown object types become
 * plain names; nothing is ever interpreted as HTML or a navigable URL here.
 */
export function renderMessageSegments(message: string, parameters: TalkMessage['messageParameters']): MessageSegment[] {
  const params = Array.isArray(parameters) ? {} : parameters;
  const out: MessageSegment[] = [];
  const re = /\{([a-z0-9_-]+)\}/gi;
  let last = 0;
  for (let m = re.exec(message); m; m = re.exec(message)) {
    const obj = params[m[1] as string];
    if (!obj) continue; // literal braces stay as text
    if (m.index > last) out.push({ type: 'text', text: message.slice(last, m.index) });
    const name = typeof obj.name === 'string' ? obj.name : '';
    const mentionType = MENTION_TYPES[obj.type];
    if (mentionType) out.push({ type: 'mention', text: `@${name}`, mentionType, id: String(obj.id) });
    else if (obj.type === 'file') out.push({ type: 'file', text: name, id: String(obj.id) });
    else out.push({ type: 'object', text: name });
    last = m.index + m[0].length;
  }
  if (last < message.length) out.push({ type: 'text', text: message.slice(last) });
  // merge adjacent text segments
  return out.reduce<MessageSegment[]>((acc, s) => {
    const prev = acc[acc.length - 1];
    if (prev?.type === 'text' && s.type === 'text') prev.text += s.text;
    else acc.push({ ...s });
    return acc;
  }, []);
}

/** Bounded exponential backoff with jitter for long-poll reconnects (ms). */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
  return Math.round(base / 2 + random() * (base / 2));
}
