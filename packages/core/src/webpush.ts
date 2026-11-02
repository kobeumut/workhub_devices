import { OcsError, type OcsClient } from './ocs';

/**
 * Nextcloud Notifications Web Push v2 (RFC 8030/8291/8292) — one subscription with
 * `appTypes=talk,workhub` receives BOTH Talk and Workhub notifications (unlike native push v2,
 * which routes Talk and other apps to different registrations).
 *
 * This module uses WebCrypto (`crypto.subtle`): Node ≥ 20 / Electron main / tests. On iOS and
 * Android the same algorithm runs natively (NSE / FirebaseMessagingService), because JS may not
 * be running when a push arrives. This file is the reference implementation for those ports.
 */

const API = '/ocs/v2.php/apps/notifications/api/v2/webpush';
export const WEBPUSH_APP_TYPES = 'talk,workhub';

export const b64url = {
  encode(bytes: Uint8Array): string {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(s: string): Uint8Array {
    if (!/^[A-Za-z0-9_-]*=*$/.test(s)) throw new Error('invalid base64url');
    const norm = s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

const enc = new TextEncoder();
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** Per-account, per-device subscription keys. `privateJwk` + `auth` are secrets (secure storage only). */
export interface SubscriptionKeys {
  publicKey: string; // base64url, 65-byte uncompressed P-256 point → `uaPublicKey`
  auth: string; // base64url, 16 bytes
  privateJwk: JsonWebKey;
}

export async function generateSubscriptionKeys(): Promise<SubscriptionKeys> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return {
    publicKey: b64url.encode(pub),
    auth: b64url.encode(crypto.getRandomValues(new Uint8Array(16))),
    privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey),
  };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) }, key, length * 8));
}

export class WebPushDecryptError extends Error {
  constructor(reason: string) {
    super(`web push decrypt failed: ${reason}`);
    this.name = 'WebPushDecryptError';
  }
}

/** Decrypt an RFC 8291 `aes128gcm` body (single record) into UTF-8 text. */
export async function decryptWebPush(body: Uint8Array, keys: SubscriptionKeys): Promise<string> {
  if (body.length < 16 + 4 + 1 + 65 + 17) throw new WebPushDecryptError('too short');
  const salt = body.subarray(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idlen = body[20]!;
  if (idlen !== 65) throw new WebPushDecryptError('unexpected keyid length');
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  if (ciphertext.length > rs) throw new WebPushDecryptError('multi-record bodies are not used by Nextcloud');

  const priv = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pubKey = await crypto.subtle.importKey('raw', buf(asPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pubKey }, priv, 256));
  const uaPublic = b64url.decode(keys.publicKey);

  const ikm = await hkdf(b64url.decode(keys.auth), ecdh, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  let plain: Uint8Array;
  try {
    const k = await crypto.subtle.importKey('raw', buf(cek), 'AES-GCM', false, ['decrypt']);
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(nonce) }, k, buf(ciphertext)));
  } catch {
    throw new WebPushDecryptError('authentication failed');
  }
  // Last record: data || 0x02 || 0x00*
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (end < 0 || plain[end] !== 2) throw new WebPushDecryptError('bad padding');
  return new TextDecoder().decode(plain.subarray(0, end));
}

// ---- Server registration ------------------------------------------------------

export async function getVapidKey(client: OcsClient): Promise<string> {
  const r = await client.get<{ vapid: string }>(`${API}/vapid`);
  if (typeof r.vapid !== 'string' || !/^[A-Za-z0-9_-]{80,100}=*$/.test(r.vapid)) throw new OcsError('invalid_response');
  return r.vapid;
}

/** 201 = created (activation push follows), 200 = already registered/updated. */
export async function registerWebPush(client: OcsClient, endpoint: string, keys: Pick<SubscriptionKeys, 'publicKey' | 'auth'>, appTypes = WEBPUSH_APP_TYPES): Promise<'created' | 'updated'> {
  if (!endpoint.startsWith('https://')) throw new OcsError('client', undefined, 'endpoint must be https');
  const r = await client.request(API, { method: 'POST', body: { endpoint, uaPublicKey: keys.publicKey, auth: keys.auth, appTypes } });
  return r.status === 201 ? 'created' : 'updated';
}

export async function activateWebPush(client: OcsClient, activationToken: string): Promise<void> {
  await client.request(`${API}/activate`, { method: 'POST', body: { activationToken } });
}

export async function unregisterWebPush(client: OcsClient): Promise<void> {
  await client.request(API, { method: 'DELETE' });
}

/**
 * What the relay hands to the device. `ct` is the untouched encrypted Web Push body when it fits
 * the FCM/APNs 4 KB limit; otherwise only `topic` (`nid<id>`) arrives and the app fetches
 * `GET notifications/{id}` with its own credentials (404 → the notification was deleted).
 */
export interface RelayedPush {
  ct?: string; // base64url aes128gcm body
  topic?: string;
  urgency?: string;
}

export type DecodedPush =
  | { kind: 'payload'; json: unknown }
  | { kind: 'fetch'; notificationId: number }
  | { kind: 'sync' };

export async function decodeRelayedPush(msg: RelayedPush, keys: SubscriptionKeys): Promise<DecodedPush> {
  if (msg.ct) return { kind: 'payload', json: JSON.parse(await decryptWebPush(b64url.decode(msg.ct), keys)) };
  const m = /^nid([1-9]\d{0,15})$/.exec(msg.topic ?? '');
  return m ? { kind: 'fetch', notificationId: Number(m[1]) } : { kind: 'sync' };
}

/** Activation pushes carry `{activationToken}` instead of a notification. */
export function activationTokenOf(json: unknown): string | null {
  const t = (json as { activationToken?: unknown } | null)?.activationToken;
  return typeof t === 'string' && t.length > 0 && t.length < 256 ? t : null;
}
