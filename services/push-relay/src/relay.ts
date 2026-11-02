import { createPublicKey, verify } from 'node:crypto';

/**
 * Stateless Web Push → FCM relay.
 *
 * Nextcloud Notifications only speaks Web Push (RFC 8030) to third-party endpoints; FCM/APNs do not
 * accept that protocol for native apps. The device therefore registers this endpoint at its
 * Nextcloud server:
 *
 *     https://<relay>/wp/<fcmRegistrationToken>?k=<server VAPID public key>&a=<opaque account tag>
 *
 * For every push the relay
 *   1. accepts only requests signed (VAPID, RFC 8292) by the key pinned in the URL — so only the
 *      user's own Nextcloud can reach the device even if the URL leaks;
 *   2. forwards the still-encrypted body (it holds no decryption key and stores nothing);
 *   3. maps the FCM result back to Web Push status codes (410 → Nextcloud drops the subscription).
 *
 * FCM delivers to Android directly and to iOS through APNs (APNs key uploaded to Firebase).
 */

export interface RelayRequest {
  method: string;
  /** Path after the function mount point, e.g. `/wp/<token>`. */
  path: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>; // lower-case names
  body: Uint8Array;
}

export interface RelayResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/** Subset of the FCM HTTP v1 `Message` that the relay produces. */
export interface FcmMessage {
  token: string;
  data: Record<string, string>;
  android: { priority: 'high' | 'normal'; ttl: string; collapseKey?: string };
  apns: {
    headers: Record<string, string>;
    payload: { aps: { 'mutable-content': 1; alert: { title: string; body: string }; sound: string; 'thread-id'?: string } };
  };
}

export type SendResult = { ok: true } | { ok: false; reason: 'unregistered' | 'invalid' | 'quota' | 'unavailable'; retryAfterSec?: number };

export interface RelayDeps {
  /** Public origin of the relay (VAPID `aud` must equal it). */
  origin: string;
  send: (msg: FcmMessage) => Promise<SendResult>;
  now?: () => number;
}

/** FCM and APNs both cap payloads at 4096 bytes; keep headroom for keys/JSON framing. */
export const MAX_INLINE_CT = 3900;
const MAX_BODY = 4096;
const FCM_TOKEN = /^[A-Za-z0-9_:-]{20,4096}$/;
const B64URL = /^[A-Za-z0-9_-]+=*$/;

const b64urlToBuf = (s: string) => Buffer.from(s.replace(/=+$/, ''), 'base64url');

export function parseVapidHeader(authorization: string | undefined): { jwt: string; key: string } | null {
  if (!authorization) return null;
  const m = /^vapid\s+(.+)$/i.exec(authorization.trim());
  if (!m) return null;
  const params = Object.fromEntries(
    (m[1] as string).split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim()];
    }),
  );
  return params.t && params.k ? { jwt: params.t, key: params.k } : null;
}

/**
 * `aud` must name this relay. Nextcloud's web-push library builds it as `scheme://host`
 * WITHOUT the port, so a relay on a non-default port is matched on scheme + hostname.
 */
export function audienceMatches(aud: unknown, origin: string): boolean {
  if (typeof aud !== 'string') return false;
  if (aud === origin) return true;
  try {
    const o = new URL(origin);
    return aud === `${o.protocol}//${o.hostname}`;
  } catch {
    return false;
  }
}

/** RFC 8292 VAPID: ES256 JWT signed by `key`, `aud` = relay origin, unexpired, max 24 h. */
export function verifyVapid(jwt: string, key: string, origin: string, nowMs: number): boolean {
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) return false;
  const raw = b64urlToBuf(key);
  if (raw.length !== 65 || raw[0] !== 4) return false;
  try {
    const pub = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') },
      format: 'jwk',
    });
    const header = JSON.parse(b64urlToBuf(parts[0]!).toString('utf8'));
    if (header.alg !== 'ES256') return false;
    const ok = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, b64urlToBuf(parts[2]!));
    if (!ok) return false;
    const claims = JSON.parse(b64urlToBuf(parts[1]!).toString('utf8'));
    const now = Math.floor(nowMs / 1000);
    return audienceMatches(claims.aud, origin) && typeof claims.exp === 'number' && claims.exp > now && claims.exp <= now + 24 * 3600 + 60;
  } catch {
    return false;
  }
}

export function buildFcmMessage(token: string, body: Uint8Array, h: RelayRequest['headers'], accountTag?: string): FcmMessage {
  const topic = h.topic && /^[A-Za-z0-9_-]{1,32}$/.test(h.topic) ? h.topic : undefined;
  const urgency = ['very-low', 'low', 'normal', 'high'].includes(h.urgency ?? '') ? (h.urgency as string) : 'normal';
  const ttlSec = Math.min(Math.max(Number(h.ttl) || 0, 0), 28 * 24 * 3600);
  const ct = Buffer.from(body).toString('base64url');
  const data: Record<string, string> = { urgency };
  if (ct.length <= MAX_INLINE_CT) data.ct = ct; // otherwise the app fetches by topic/nid
  if (topic) data.topic = topic;
  // Opaque per-account tag chosen by the device (one FCM token serves several accounts).
  if (accountTag) data.acct = accountTag;
  return {
    token,
    data,
    // Every push becomes or updates a user-visible notification → high is allowed and avoids Doze delay.
    android: { priority: urgency === 'high' || urgency === 'normal' ? 'high' : 'normal', ttl: `${ttlSec}s`, ...(topic ? { collapseKey: topic } : {}) },
    apns: {
      headers: {
        'apns-push-type': 'alert',
        'apns-priority': urgency === 'high' || urgency === 'normal' ? '10' : '5',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + ttlSec),
        ...(topic ? { 'apns-collapse-id': topic } : {}),
      },
      // Generic text; the Notification Service Extension decrypts and replaces it (or hides it
      // with the notification-filtering entitlement). Content never travels in clear.
      payload: { aps: { 'mutable-content': 1, alert: { title: 'Workhub', body: 'Yeni bildirim' }, sound: 'default' } },
    },
  };
}

export async function handleWebPush(req: RelayRequest, deps: RelayDeps): Promise<RelayResponse> {
  if (req.method !== 'POST') return { status: 405, headers: { Allow: 'POST' } };
  const m = /^\/wp\/([^/]+)$/.exec(req.path);
  const token = m ? decodeURIComponent(m[1] as string) : '';
  if (!FCM_TOKEN.test(token)) return { status: 404 };
  const pinned = req.query.k;
  if (!pinned || !B64URL.test(pinned)) return { status: 404 };

  const vapid = parseVapidHeader(req.headers.authorization);
  if (!vapid || vapid.key.replace(/=+$/, '') !== pinned.replace(/=+$/, '') || !verifyVapid(vapid.jwt, vapid.key, deps.origin, (deps.now ?? Date.now)())) {
    return { status: 401 };
  }
  if ((req.headers['content-encoding'] ?? '').toLowerCase() !== 'aes128gcm') return { status: 415 };
  if (req.body.length === 0 || req.body.length > MAX_BODY) return { status: 413 };

  const acct = req.query.a;
  if (acct !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(acct)) return { status: 404 };
  const result = await deps.send(buildFcmMessage(token, req.body, req.headers, acct));
  if (result.ok) return { status: 201 };
  switch (result.reason) {
    case 'unregistered':
    case 'invalid':
      return { status: 410 }; // Nextcloud deletes the subscription
    case 'quota':
      return { status: 429, headers: { 'Retry-After': String(result.retryAfterSec ?? 60) } };
    default:
      return { status: 503, headers: { 'Retry-After': String(result.retryAfterSec ?? 30) } };
  }
}
