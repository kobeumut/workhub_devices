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
  /** v4 fields used for capability/role gates (absent = fail closed). */
  description?: string;
  participantType?: number;
  permissions?: number;
  attendeeId?: number;
  actorType?: string;
  actorId?: string;
  canDeleteConversation?: boolean;
  canLeaveConversation?: boolean;
  /** Calls: a call is running / its flags, may this participant start one, lobby (0 off, 1 on). */
  hasCall?: boolean;
  callFlag?: number;
  canStartCall?: boolean;
  lobbyState?: number;
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
  /** Full parent, or `{ id, deleted: true }` when the quoted message was deleted. */
  parent?: TalkMessage | { id: number; deleted: true };
  isReplyable?: boolean;
  /** emoji → count; the server sends `[]` / `{}` when empty. */
  reactions?: Record<string, number> | [];
  /** The viewer's own reactions (only present when they reacted). */
  reactionsSelf?: string[];
  lastEditTimestamp?: number;
  lastEditActorDisplayName?: string;
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
  applyMessageUpdates(byId, incoming);
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

// ---- Edits, deletions and reactions arriving through the chat feed -----------

/**
 * System messages that only carry an update of their `parent` (Talk docs: "should not be shown").
 * The parent in these messages is re-read by the server at fetch time, so it is the current state.
 */
export const UPDATE_SYSTEM_MESSAGES: ReadonlySet<string> = new Set([
  'message_edited', 'message_deleted', 'reaction', 'reaction_deleted', 'reaction_revoked',
]);

/** Hidden from the timeline: pure update carriers (the change shows on the message itself). */
export const isHiddenSystemMessage = (m: TalkMessage) => UPDATE_SYSTEM_MESSAGES.has(m.systemMessage) || m.systemMessage === 'poll_voted';

const isFullMessage = (p: TalkMessage['parent']): p is TalkMessage => !!p && typeof p === 'object' && 'message' in p && typeof p.id === 'number';

/** Replace the edited/deleted/reacted message (and quotes of it) with the parent snapshot. */
function applyMessageUpdates(byId: Map<number, TalkMessage>, incoming: readonly TalkMessage[]) {
  const updates = [...incoming].filter((m) => UPDATE_SYSTEM_MESSAGES.has(m.systemMessage) && isFullMessage(m.parent)).sort((a, b) => a.id - b.id);
  for (const u of updates) {
    const fresh = u.parent as TalkMessage;
    const old = byId.get(fresh.id);
    if (old) {
      // `reactionsSelf` is only sent when the viewer reacted; absence means "none".
      byId.set(fresh.id, { ...old, ...fresh, reactionsSelf: fresh.reactionsSelf ?? [] });
    }
    for (const [id, m] of byId) {
      if (m.parent && m.parent.id === fresh.id && isFullMessage(m.parent)) {
        byId.set(id, { ...m, parent: fresh.messageType === 'comment_deleted' ? { id: fresh.id, deleted: true } : { ...m.parent, ...fresh } });
      }
    }
  }
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  self: boolean;
}

export function reactionSummary(m: TalkMessage): ReactionSummary[] {
  const map = m.reactions && !Array.isArray(m.reactions) ? m.reactions : {};
  const self = new Set(m.reactionsSelf ?? []);
  return Object.entries(map)
    .filter(([, n]) => typeof n === 'number' && n > 0)
    .map(([emoji, count]) => ({ emoji, count, self: self.has(emoji) }));
}

// ---- Capability + role rules (UI hides, Backend re-checks, server decides) ----

export interface TalkFeatures {
  reply: boolean;
  edit: boolean;
  delete: boolean;
  /** Without it, deletion is limited to 6 hours. */
  deleteUnlimited: boolean;
  reactions: boolean;
  /** Talk ≥ NC34: reacting has its own permission bit (256) instead of the chat bit. */
  reactPermission: boolean;
  mentions: boolean;
  /** Unified search provider `talk-message` (with `conversation` filter). */
  search: boolean;
  description: boolean;
  /** `spreed.config.attachments.allowed` (the user may upload/share files); missing → false. */
  files: boolean;
  /** Caption shown with a shared file (`media-caption`). */
  caption: boolean;
  /** `voice-message-sharing`. */
  voice: boolean;
  /** `chat-get-context`: needed to re-read one message (fresh file path before a download). */
  context: boolean;
}

export function talkFeaturesOf(features: Iterable<string>, config: { attachmentsAllowed?: boolean } = {}): TalkFeatures {
  const f = new Set(features);
  const files = config.attachmentsAllowed === true;
  return {
    files,
    caption: files && f.has('media-caption'),
    voice: files && f.has('voice-message-sharing'),
    context: f.has('chat-get-context'),
    reply: f.has('chat-replies'),
    edit: f.has('edit-messages'),
    delete: f.has('delete-messages'),
    deleteUnlimited: f.has('delete-messages-unlimited'),
    reactions: f.has('reactions'),
    reactPermission: f.has('react-permission'),
    mentions: f.has('chat-v2'),
    search: f.has('unified-search'),
    description: f.has('room-description'),
  };
}

/** Conversation types (Talk constants). */
export const ROOM_TYPE = { oneToOne: 1, group: 2, public: 3, changelog: 4, formerOneToOne: 5, noteToSelf: 6 } as const;
/** Participant types: 1 owner, 2 moderator, 3 user, 4 guest, 5 self-joined user, 6 guest moderator. */
export const PARTICIPANT_TYPE = { owner: 1, moderator: 2, user: 3, guest: 4, selfJoined: 5, guestModerator: 6 } as const;
export const TALK_PERMISSION = { chat: 128, react: 256 } as const;
export const TALK_LIMITS = { message: 32000, roomName: 255, description: 2000, editAgeSec: 86400, deleteAgeSec: 6 * 3600, searchTerm: 200 } as const;

export const isModeratorType = (t: number | undefined) => t === PARTICIPANT_TYPE.owner || t === PARTICIPANT_TYPE.moderator || t === PARTICIPANT_TYPE.guestModerator;
const isGroupLike = (type: number) => type === ROOM_TYPE.group || type === ROOM_TYPE.public;
const hasPerm = (room: Pick<TalkRoom, 'permissions'>, bit: number) => typeof room.permissions === 'number' && (room.permissions & bit) !== 0;

export type RoomGate = Pick<TalkRoom, 'type' | 'readOnly' | 'participantType' | 'permissions' | 'canDeleteConversation' | 'canLeaveConversation'>;

export interface RoomActions {
  chat: boolean;
  react: boolean;
  rename: boolean;
  describe: boolean;
  manageParticipants: boolean;
  leave: boolean;
  delete: boolean;
}

/** What the current participant may do with the room. Missing fields → not allowed (fail closed). */
export function roomActions(room: RoomGate, f: TalkFeatures): RoomActions {
  const writable = room.readOnly === 0;
  const mod = isModeratorType(room.participantType) && isGroupLike(room.type);
  return {
    chat: writable && hasPerm(room, TALK_PERMISSION.chat),
    react: f.reactions && writable && hasPerm(room, f.reactPermission ? TALK_PERMISSION.react : TALK_PERMISSION.chat),
    rename: mod,
    describe: mod && f.description,
    manageParticipants: mod,
    leave: room.canLeaveConversation === true,
    delete: room.canDeleteConversation === true,
  };
}

export interface MessageActions {
  reply: boolean;
  edit: boolean;
  delete: boolean;
  react: boolean;
}

const NO_ACTIONS: MessageActions = { reply: false, edit: false, delete: false, react: false };

/**
 * Mirrors ChatController::editMessage/deleteMessage and ReactionController: own message, or a
 * moderator outside one-to-one rooms; only real comments; edit ≤ 24 h (except note-to-self),
 * delete ≤ 6 h unless `delete-messages-unlimited`.
 */
export function messageActions(m: TalkMessage, room: RoomGate, self: { actorType: string; actorId: string }, f: TalkFeatures, nowSec: number): MessageActions {
  if (m.systemMessage !== '' || m.messageType !== 'comment' || m.id <= 0) return NO_ACTIONS;
  const r = roomActions(room, f);
  const own = m.actorType === self.actorType && m.actorId === self.actorId;
  const modOther = isModeratorType(room.participantType) && room.type !== ROOM_TYPE.oneToOne && room.type !== ROOM_TYPE.formerOneToOne;
  const mayChange = r.chat && (own || modOther);
  const age = nowSec - m.timestamp;
  const onlyFile = /^\{file\}$/.test(m.message.trim());
  return {
    reply: f.reply && r.chat && m.isReplyable !== false,
    edit: f.edit && mayChange && !onlyFile && (room.type === ROOM_TYPE.noteToSelf || age < TALK_LIMITS.editAgeSec),
    delete: f.delete && mayChange && (f.deleteUnlimited || age < TALK_LIMITS.deleteAgeSec),
    react: r.react,
  };
}

// ---- Message / reaction API ----------------------------------------------------

const REACTION_API = '/ocs/v2.php/apps/spreed/api/v1/reaction';
const assertMessageId = (id: number) => {
  if (!Number.isInteger(id) || id <= 0) throw new OcsError('client', undefined, 'invalid message id');
  return id;
};

/** An emoji reaction: short, no whitespace/controls, not plain ASCII text. */
export const isReaction = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 32 && !/[\s\u0000-\u001f\u007f]/.test(v) && /[^\u0000-\u007f]/.test(v);

/** Returns the `message_edited` system message; its `parent` is the edited message. */
export async function editMessage(client: OcsClient, token: string, messageId: number, message: string): Promise<TalkMessage> {
  const r = await client.request<TalkMessage>(`${CHAT_API}/${assertRoomToken(token)}/${assertMessageId(messageId)}`, { method: 'PUT', body: { message } });
  if (!r.data || !isFullMessage(r.data.parent)) throw new OcsError('invalid_response', r.status);
  return r.data;
}

/** Returns the `message_deleted` system message; its `parent` is the `comment_deleted` placeholder. */
export async function deleteMessage(client: OcsClient, token: string, messageId: number): Promise<TalkMessage> {
  const r = await client.request<TalkMessage>(`${CHAT_API}/${assertRoomToken(token)}/${assertMessageId(messageId)}`, { method: 'DELETE' });
  if (!r.data || !isFullMessage(r.data.parent)) throw new OcsError('invalid_response', r.status);
  return r.data;
}

export interface ReactionActor {
  actorType: string;
  actorId: string;
  actorDisplayName: string;
  timestamp: number;
}
export type ReactionMap = Record<string, ReactionActor[]>;

const reactionMap = (d: unknown): ReactionMap => (d && typeof d === 'object' && !Array.isArray(d) ? (d as ReactionMap) : {});

export async function addReaction(client: OcsClient, token: string, messageId: number, reaction: string): Promise<ReactionMap> {
  if (!isReaction(reaction)) throw new OcsError('client', undefined, 'invalid reaction');
  const r = await client.request<ReactionMap>(`${REACTION_API}/${assertRoomToken(token)}/${assertMessageId(messageId)}`, { method: 'POST', body: { reaction } });
  return reactionMap(r.data);
}

export async function removeReaction(client: OcsClient, token: string, messageId: number, reaction: string): Promise<ReactionMap> {
  if (!isReaction(reaction)) throw new OcsError('client', undefined, 'invalid reaction');
  const r = await client.request<ReactionMap>(`${REACTION_API}/${assertRoomToken(token)}/${assertMessageId(messageId)}`, { method: 'DELETE', query: { reaction } });
  return reactionMap(r.data);
}

export async function listReactions(client: OcsClient, token: string, messageId: number, reaction?: string): Promise<ReactionMap> {
  if (reaction !== undefined && !isReaction(reaction)) throw new OcsError('client', undefined, 'invalid reaction');
  const r = await client.request<ReactionMap>(`${REACTION_API}/${assertRoomToken(token)}/${assertMessageId(messageId)}`, { query: { reaction } });
  return reactionMap(r.data);
}

/** Apply a reaction response to the local message (counts from the server, own flag locally). */
export function withReactions(m: TalkMessage, map: ReactionMap, selfActor: { actorType: string; actorId: string }): TalkMessage {
  const reactions: Record<string, number> = {};
  const mine: string[] = [];
  for (const [emoji, actors] of Object.entries(map)) {
    if (!Array.isArray(actors) || actors.length === 0) continue;
    reactions[emoji] = actors.length;
    if (actors.some((a) => a.actorType === selfActor.actorType && a.actorId === selfActor.actorId)) mine.push(emoji);
  }
  return { ...m, reactions, reactionsSelf: mine };
}

// ---- Mentions --------------------------------------------------------------------

export interface MentionSuggestion {
  id: string;
  label: string;
  /** `users`, `groups`, `calls` (= @all), `guests`, `emails`, `federated_users`, `teams`. */
  source: string;
  mentionId: string;
}

export async function mentionSuggestions(client: OcsClient, token: string, search: string, limit = 10): Promise<MentionSuggestion[]> {
  const r = await client.request<MentionSuggestion[]>(`${CHAT_API}/${assertRoomToken(token)}/mentions`, {
    query: { search: search.slice(0, 64), limit: Math.max(1, Math.min(limit, 20)), includeStatus: false },
  });
  return (Array.isArray(r.data) ? r.data : [])
    .filter((x) => x && typeof x.mentionId === 'string' && typeof x.label === 'string')
    .map((x) => ({ id: String(x.id), label: x.label, source: String(x.source), mentionId: x.mentionId }));
}

/** The `@…` word being typed right before the caret, if any. */
export function activeMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const m = /(^|\s)@([^\s@"]{0,64})$/.exec(before);
  if (!m) return null;
  return { start: before.length - m[2]!.length - 1, query: m[2]! };
}

/** Talk parses `@id` for simple ids and `@"id"` otherwise (spaces, `/`, …). */
export function mentionText(mentionId: string): string {
  return /^[a-z0-9_.@-]+$/i.test(mentionId) && !mentionId.includes('@') ? `@${mentionId}` : `@"${mentionId.replace(/"/g, '')}"`;
}

/** Replace the active `@query` with the mention; returns the new text and caret. */
export function insertMention(text: string, at: { start: number; query: string }, mentionId: string): { text: string; caret: number } {
  const insert = `${mentionText(mentionId)} `;
  const end = at.start + 1 + at.query.length;
  return { text: text.slice(0, at.start) + insert + text.slice(end), caret: at.start + insert.length };
}

/** Message text for the edit box: mention placeholders back to `@id`, other objects to their name. */
export function editableText(m: Pick<TalkMessage, 'message' | 'messageParameters'>): string {
  const params = Array.isArray(m.messageParameters) ? {} : m.messageParameters;
  return m.message.replace(/\{([a-z0-9_-]+)\}/gi, (whole, key: string) => {
    const p = params[key];
    if (!p) return whole;
    if (p.type === 'call') return '@all';
    if (MENTION_TYPES[p.type]) return mentionText(typeof p['mention-id'] === 'string' ? (p['mention-id'] as string) : String(p.id));
    return typeof p.name === 'string' ? p.name : whole;
  });
}

/** Does the message mention the viewer (directly, or @all)? */
export function mentionsSelf(m: TalkMessage, selfId: string): boolean {
  const params = Array.isArray(m.messageParameters) ? {} : m.messageParameters;
  return Object.values(params).some((p) => (p.type === 'user' && String(p.id) === selfId) || p.type === 'call');
}

// ---- Message search (unified search provider) -------------------------------------

export interface MessageSearchHit {
  token: string;
  messageId: number;
  /** "{user} in {conversation}" or "{user}" (server-localised). */
  title: string;
  /** Plain text excerpt around the match — never rendered as HTML. */
  excerpt: string;
  actorId: string;
  timestamp: number;
}

export interface MessageSearchPage {
  hits: MessageSearchHit[];
  /** Offset for the next page; null when no more results. */
  cursor: number | null;
}

interface RawSearchResult {
  isPaginated?: boolean;
  cursor?: unknown;
  entries?: Array<{ title?: unknown; subline?: unknown; attributes?: Record<string, unknown> }>;
}

export async function searchMessages(client: OcsClient, o: { term: string; token?: string | null; cursor?: number | null; limit?: number }): Promise<MessageSearchPage> {
  const term = o.term.trim();
  if (!term || term.length > TALK_LIMITS.searchTerm) throw new OcsError('client', undefined, 'invalid search term');
  const limit = Math.max(1, Math.min(o.limit ?? 20, 50));
  const r = await client.request<RawSearchResult>('/ocs/v2.php/search/providers/talk-message/search', {
    query: { term, limit, cursor: o.cursor ?? undefined, conversation: o.token ? assertRoomToken(o.token) : undefined },
  });
  const entries = Array.isArray(r.data?.entries) ? r.data!.entries : [];
  const hits: MessageSearchHit[] = [];
  for (const e of entries) {
    const a = e.attributes ?? {};
    const token = typeof a.conversation === 'string' ? a.conversation : '';
    const messageId = Number(a.messageId);
    if (!/^[a-z0-9]{1,64}$/i.test(token) || !Number.isInteger(messageId) || messageId <= 0) continue;
    hits.push({
      token,
      messageId,
      title: typeof e.title === 'string' ? e.title : '',
      excerpt: typeof e.subline === 'string' ? e.subline : '',
      actorId: typeof a.actorId === 'string' ? a.actorId : '',
      timestamp: Number(a.timestamp) || 0,
    });
  }
  const next = Number(r.data?.cursor);
  return { hits, cursor: r.data?.isPaginated && entries.length >= limit && Number.isInteger(next) && next > 0 ? next : null };
}

// ---- Conversation management --------------------------------------------------------

export interface TalkParticipant {
  attendeeId: number;
  actorType: string;
  actorId: string;
  displayName: string;
  participantType: number;
}

export type RoomKind = 'group' | 'public';
export interface RoomPatch {
  name?: string;
  description?: string;
}

export const talkRoomApi = {
  async get(c: OcsClient, token: string): Promise<TalkRoom> {
    const r = await c.request<TalkRoom>(`${ROOM_API}/${assertRoomToken(token)}`);
    if (!r.data?.token) throw new OcsError('invalid_response', r.status);
    return r.data;
  },
  async create(c: OcsClient, kind: RoomKind, name: string): Promise<TalkRoom> {
    const r = await c.request<TalkRoom>(ROOM_API, { method: 'POST', body: { roomType: kind === 'public' ? ROOM_TYPE.public : ROOM_TYPE.group, roomName: name.trim() } });
    if (!r.data?.token) throw new OcsError('invalid_response', r.status);
    return r.data;
  },
  async rename(c: OcsClient, token: string, name: string): Promise<void> {
    await c.request(`${ROOM_API}/${assertRoomToken(token)}`, { method: 'PUT', body: { roomName: name.trim() } });
  },
  async describe(c: OcsClient, token: string, description: string): Promise<void> {
    await c.request(`${ROOM_API}/${assertRoomToken(token)}/description`, { method: 'PUT', body: { description } });
  },
  async participants(c: OcsClient, token: string): Promise<TalkParticipant[]> {
    const r = await c.request<TalkParticipant[]>(`${ROOM_API}/${assertRoomToken(token)}/participants`, { query: { includeStatus: false } });
    return (Array.isArray(r.data) ? r.data : []).map((p) => ({
      attendeeId: p.attendeeId, actorType: p.actorType, actorId: p.actorId, displayName: p.displayName ?? '', participantType: p.participantType,
    }));
  },
  /** Returns the (possibly changed) room type. */
  async addParticipant(c: OcsClient, token: string, source: 'users' | 'groups', id: string): Promise<{ type?: number }> {
    const r = await c.request<{ type?: number } | []>(`${ROOM_API}/${assertRoomToken(token)}/participants`, { method: 'POST', body: { newParticipant: id, source } });
    return r.data && !Array.isArray(r.data) ? r.data : {};
  },
  async removeAttendee(c: OcsClient, token: string, attendeeId: number): Promise<void> {
    await c.request(`${ROOM_API}/${assertRoomToken(token)}/attendees`, { method: 'DELETE', query: { attendeeId } });
  },
  async setModerator(c: OcsClient, token: string, attendeeId: number, moderator: boolean): Promise<void> {
    await c.request(`${ROOM_API}/${assertRoomToken(token)}/moderators`, moderator ? { method: 'POST', body: { attendeeId } } : { method: 'DELETE', query: { attendeeId } });
  },
  async leave(c: OcsClient, token: string): Promise<void> {
    await c.request(`${ROOM_API}/${assertRoomToken(token)}/participants/self`, { method: 'DELETE' });
  },
  async remove(c: OcsClient, token: string): Promise<void> {
    await c.request(`${ROOM_API}/${assertRoomToken(token)}`, { method: 'DELETE' });
  },
};

/** Users/groups that can be invited to a conversation (core autocomplete, `itemType=call`). */
export interface InviteCandidate {
  source: 'users' | 'groups';
  id: string;
  label: string;
}

export async function inviteCandidates(c: OcsClient, token: string, search: string): Promise<InviteCandidate[]> {
  const r = await c.request<Array<{ id?: unknown; label?: unknown; source?: unknown }>>('/ocs/v2.php/core/autocomplete/get', {
    query: { search: search.slice(0, 64), itemType: 'call', itemId: assertRoomToken(token), shareTypes: [0, 1], limit: 20 },
  });
  const out: InviteCandidate[] = [];
  for (const x of Array.isArray(r.data) ? r.data : []) {
    if (typeof x.id !== 'string' || !x.id) continue;
    const source = x.source === 'users' ? 'users' : x.source === 'groups' ? 'groups' : null;
    if (source) out.push({ source, id: x.id, label: typeof x.label === 'string' ? x.label : x.id });
  }
  return out;
}
