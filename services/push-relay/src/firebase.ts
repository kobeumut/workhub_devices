/**
 * Firebase Cloud Functions (2nd gen) entry point.
 * Deploy: see README "Push bildirimleri: Firebase kurulumu".
 * Needs no secrets of its own: firebase-admin uses the function's service account.
 */
import { initializeApp } from 'firebase-admin/app';
import { getMessaging, type Message } from 'firebase-admin/messaging';
import { onRequest } from 'firebase-functions/v2/https';
import { defineString } from 'firebase-functions/params';
import { handleWebPush, type FcmMessage, type SendResult } from './relay';

initializeApp();

/** Public origin the devices put in their endpoint, e.g. `https://push.example.com` (VAPID `aud`). */
const RELAY_ORIGIN = defineString('RELAY_ORIGIN');

/** Relay's HTTP v1 shaped message → firebase-admin `Message` (ttl in ms, camelCase aps keys). */
export function toAdminMessage(msg: FcmMessage): Message {
  const { aps } = msg.apns.payload;
  return {
    token: msg.token,
    data: msg.data,
    android: {
      priority: msg.android.priority,
      ttl: Number.parseInt(msg.android.ttl, 10) * 1000,
      ...(msg.android.collapseKey ? { collapseKey: msg.android.collapseKey } : {}),
    },
    apns: {
      headers: msg.apns.headers,
      payload: { aps: { mutableContent: true, alert: aps.alert, sound: aps.sound } },
    },
  };
}

export async function sendViaFcm(msg: FcmMessage): Promise<SendResult> {
  try {
    await getMessaging().send(toAdminMessage(msg));
    return { ok: true };
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    if (code === 'messaging/registration-token-not-registered') return { ok: false, reason: 'unregistered' };
    // invalid-argument may be our own bug (e.g. payload) — do not make Nextcloud drop the subscription for it
    if (code === 'messaging/invalid-registration-token' || code === 'messaging/mismatched-credential') {
      return { ok: false, reason: 'invalid' };
    }
    if (code === 'messaging/message-rate-exceeded' || code === 'messaging/quota-exceeded') return { ok: false, reason: 'quota' };
    return { ok: false, reason: 'unavailable' };
  }
}

export const webpush = onRequest({ region: 'europe-west1', cors: false, maxInstances: 20, memory: '256MiB' }, async (req, res) => {
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  const query: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.query)) query[k] = typeof v === 'string' ? v : undefined;
  const out = await handleWebPush(
    { method: req.method, path: req.path, query, headers, body: new Uint8Array(req.rawBody ?? Buffer.alloc(0)) },
    { origin: RELAY_ORIGIN.value(), send: sendViaFcm },
  );
  for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
  res.status(out.status).send(out.body ?? '');
});
