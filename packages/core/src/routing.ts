import type { AccountId } from './accounts';
import { isWithinServer, type ServerBase } from './serverUrl';
import type { OcsClient } from './ocs';

/** Typed in-app routes. Untrusted payloads/links are only ever converted to one of these. */
export type AppRoute =
  | { name: 'room'; token: string; messageId?: number }
  | { name: 'task'; cardId: number }
  | { name: 'inbox'; notificationId?: number };

export interface RoutedTarget {
  accountId: AccountId;
  route: AppRoute;
}

const ROOM_TOKEN = /^[a-z0-9]{1,64}$/i;
const POSITIVE_INT = /^[1-9]\d{0,15}$/;

// ---- Notifications OCS (inbox) ---------------------------------------------

export interface InboxNotification {
  id: number;
  app: string;
  objectType: string;
  objectId: string;
  subject: string;
  message: string;
  link: string;
  datetime: string;
  /** false → keep in the inbox but never raise an OS alert (server decided another client shows it). */
  shouldNotify: boolean;
}

export function normalizeInboxNotification(raw: Record<string, unknown>): InboxNotification | null {
  const id = Number(raw.notification_id);
  if (!Number.isInteger(id) || id <= 0 || typeof raw.app !== 'string') return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    id,
    app: raw.app,
    objectType: str(raw.object_type),
    objectId: str(raw.object_id),
    subject: str(raw.subject),
    message: str(raw.message),
    link: str(raw.link),
    datetime: str(raw.datetime),
    shouldNotify: raw.shouldNotify !== false,
  };
}

/** Pure dispatcher: app → object type/id → typed route. Unknown → inbox (never an arbitrary URL). */
export function routeForObject(app: string, objectType: string, objectId: string, notificationId?: number): AppRoute {
  if (app === 'spreed' || app === 'talk') {
    // Talk uses `token` or `token/messageId` depending on version/object type.
    const [token, msg] = objectId.split('/');
    if (token && ROOM_TOKEN.test(token) && ['chat', 'room', 'call', 'reminder', 'remote_talk_share'].includes(objectType)) {
      return msg && POSITIVE_INT.test(msg) ? { name: 'room', token, messageId: Number(msg) } : { name: 'room', token };
    }
  }
  // Native and Deck backends both emit app=workhub/objectType=card (the rich subject's `deck-card` is irrelevant).
  if (app === 'workhub' && objectType === 'card' && POSITIVE_INT.test(objectId)) {
    return { name: 'task', cardId: Number(objectId) };
  }
  return notificationId ? { name: 'inbox', notificationId } : { name: 'inbox' };
}

export async function listNotifications(client: OcsClient, etag?: string): Promise<{ items: InboxNotification[] | null; etag: string | null; status: number }> {
  const res = await client.request<Record<string, unknown>[]>('/ocs/v2.php/apps/notifications/api/v2/notifications', {
    ...(etag ? { headers: { 'If-None-Match': etag } } : {}),
  });
  // 304: unchanged; 204: notifications app has nothing for this user (poll much less often).
  const items = res.data ? res.data.map(normalizeInboxNotification).filter((n): n is InboxNotification => n !== null) : null;
  return { items, etag: res.headers.get('ETag'), status: res.status };
}

export async function dismissNotification(client: OcsClient, id: number): Promise<void> {
  if (!Number.isInteger(id) || id <= 0) throw new Error('invalid notification id');
  await client.request(`/ocs/v2.php/apps/notifications/api/v2/notifications/${id}`, { method: 'DELETE' });
}

// ---- Decrypted push payloads -------------------------------------------------

/** Push-side field names differ from OCS (`type`/`id`/`nid`); normalised here. */
export type PushAction =
  | { action: 'show'; notificationId: number; route: AppRoute; app: string }
  | { action: 'dismiss'; notificationIds: number[] }
  | { action: 'dismiss-all' }
  | { action: 'ignore'; reason: string };

export function interpretPush(decrypted: unknown): PushAction {
  if (!decrypted || typeof decrypted !== 'object') return { action: 'ignore', reason: 'malformed' };
  const p = decrypted as Record<string, unknown>;
  if (p['delete-all'] === true) return { action: 'dismiss-all' };
  if (p['delete-multiple'] === true) {
    const nids = Array.isArray(p.nids) ? p.nids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    return nids.length ? { action: 'dismiss', notificationIds: nids } : { action: 'ignore', reason: 'empty delete' };
  }
  const nid = Number(p.nid);
  if (!Number.isInteger(nid) || nid <= 0) return { action: 'ignore', reason: 'missing nid' };
  if (p.delete === true) return { action: 'dismiss', notificationIds: [nid] };
  const app = typeof p.app === 'string' ? p.app : '';
  if (!app) return { action: 'ignore', reason: 'missing app' };
  return { action: 'show', notificationId: nid, app, route: routeForObject(app, String(p.type ?? ''), String(p.id ?? ''), nid) };
}

// ---- Links -------------------------------------------------------------------

/**
 * Convert a server-generated link (`notification.link`, task `url`) into a typed route.
 * Accepts pretty and `/index.php/...` forms and sub-directory installs; rejects other origins.
 */
export function parseServerLink(serverBase: ServerBase, link: string): AppRoute | null {
  if (!isWithinServer(serverBase, link)) return null;
  const root = new URL(serverBase).pathname.replace(/\/+$/, '');
  let path = new URL(link).pathname.slice(root.length);
  path = path.replace(/^\/index\.php(?=\/)/, '').replace(/\/+$/, '');
  let m = /^\/apps\/workhub\/projects\/task\/(\d+)$/.exec(path);
  if (m && POSITIVE_INT.test(m[1] as string)) return { name: 'task', cardId: Number(m[1]) };
  m = /^\/call\/([a-z0-9]+)$/i.exec(path);
  if (m?.[1] && ROOM_TOKEN.test(m[1])) return { name: 'room', token: m[1] };
  return null;
}

// ---- OS presentation ----------------------------------------------------------

export interface Presentation {
  title: string;
  body: string;
  channel: 'chat' | 'workhub' | 'other';
}

/** Lock-screen default is hidden content; rich preview is an explicit per-user opt-in. */
export function presentNotification(n: Pick<InboxNotification, 'app' | 'subject' | 'message'>, showPreview: boolean): Presentation {
  const channel = n.app === 'spreed' || n.app === 'talk' ? 'chat' : n.app === 'workhub' ? 'workhub' : 'other';
  if (!showPreview) {
    const title = channel === 'chat' ? 'Yeni mesaj' : channel === 'workhub' ? 'Workhub bildirimi' : 'Yeni bildirim';
    return { title, body: '', channel };
  }
  return { title: n.subject, body: n.message, channel };
}

export function shouldRaiseOsAlert(n: Pick<InboxNotification, 'shouldNotify'>, foreground: RoutedTarget | null, target: RoutedTarget): boolean {
  if (!n.shouldNotify) return false;
  // Do not banner the chat the user is already looking at — same account AND same room.
  const f = foreground?.route;
  const t = target.route;
  if (foreground?.accountId === target.accountId && f?.name === 'room' && t.name === 'room' && f.token === t.token) return false;
  return true;
}
