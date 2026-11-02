/**
 * Live end-to-end: real Nextcloud → this relay (local HTTPS) → captured FCM message → device-side
 * decrypt with @workhub-devices/core. Proves that ONE Web Push subscription with
 * `appTypes=talk,workhub` receives both a Talk chat notification and a normal Workhub assignment,
 * and that Nextcloud's VAPID signature passes the relay's pinning.
 *
 * Not a device test: FCM/APNs delivery and the native decrypt still need a physical device.
 * Env: WH_SERVER, WH_ALLOW_HTTP, WH_A_USER/PASS, WH_B_USER/PASS, RELAY_BIND (host:port reachable
 * from the Nextcloud container), RELAY_CERT, RELAY_KEY (PEM; cert imported into Nextcloud).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { handleWebPush, type FcmMessage } from '../src/relay';
import {
  OcsClient, normalizeServerUrl, generateSubscriptionKeys, getVapidKey, registerWebPush, activateWebPush, unregisterWebPush,
  decodeRelayedPush, activationTokenOf, interpretPush, sendMessage, newReferenceId, workhubApi, dismissNotification, listNotifications,
  type SubscriptionKeys, type PushAction,
} from '../../../packages/core/src/index';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const base = normalizeServerUrl(env('WH_SERVER'), { allowInsecureHttp: process.env.WH_ALLOW_HTTP === '1' });
const client = (u: string, p: string) => new OcsClient({ serverBase: base, getCredentials: async () => ({ loginName: u, appPassword: p }) });
const A = client(env('WH_A_USER'), env('WH_A_PASS'));
const B = client(env('WH_B_USER'), env('WH_B_PASS'));
const WH = '/ocs/v2.php/apps/workhub/api/v1';
const origin = `https://${env('RELAY_BIND')}`;
const FAKE_FCM_TOKEN = `e2e-device-token:${Date.now()}`;

const inbox: FcmMessage[] = [];
const waiters: Array<() => void> = [];
const statusLog: number[] = [];

async function nextPush(pred: (a: PushAction | { activation: string }) => boolean, keys: SubscriptionKeys, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    while (inbox.length) {
      const m = inbox.shift()!;
      const d = await decodeRelayedPush(m.data, keys);
      if (d.kind !== 'payload') throw new Error(`expected inline ciphertext, got ${d.kind}`);
      const act = activationTokenOf(d.json);
      const item = act ? { activation: act } : interpretPush(d.json);
      if (pred(item)) return { item, msg: m };
    }
    if (Date.now() > deadline) throw new Error('timeout waiting for push');
    await new Promise<void>((r) => {
      waiters.push(r);
      setTimeout(r, 1000);
    });
  }
}

async function main() {
  const server = createServer({ cert: readFileSync(env('RELAY_CERT')), key: readFileSync(env('RELAY_KEY')) }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url ?? '/', origin);
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
      const out = await handleWebPush(
        { method: req.method ?? '', path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body: new Uint8Array(Buffer.concat(chunks)) },
        { origin, send: async (m) => (inbox.push(m), waiters.splice(0).forEach((w) => w()), { ok: true }) },
      );
      statusLog.push(out.status);
      res.writeHead(out.status, out.headers).end(out.body ?? '');
    });
  });
  const [host, port] = env('RELAY_BIND').split(':');
  await new Promise<void>((r) => server.listen(Number(port), '0.0.0.0', r));
  const results: string[] = [];
  try {
    const keys = await generateSubscriptionKeys();
    const vapid = await getVapidKey(B);
    const endpoint = `${origin}/wp/${encodeURIComponent(FAKE_FCM_TOKEN)}?k=${vapid}`;
    assert.equal(await registerWebPush(B, endpoint, keys), 'created');
    const { item: act } = await nextPush((x) => 'activation' in x, keys);
    await activateWebPush(B, (act as { activation: string }).activation);
    results.push(`✔ register appTypes=talk,workhub → activation push decrypted → activated (host ${host})`);

    // Talk message A → B
    const room = await A.request<{ token: string }>('/ocs/v2.php/apps/spreed/api/v4/room', { method: 'POST', body: { roomType: 1, invite: env('WH_B_USER') } });
    await sendMessage(A, room.data!.token, { message: 'GENE-48 push e2e', referenceId: newReferenceId() });
    const talk = await nextPush((x) => 'action' in x && x.action === 'show' && x.app === 'spreed', keys);
    const tr = (talk.item as Extract<PushAction, { action: 'show' }>).route;
    assert.equal(tr.name === 'room' && tr.token, room.data!.token);
    results.push(`✔ Talk message → same subscription, route=room, FCM priority=${talk.msg.android.priority}, apns-priority=${talk.msg.apns.headers['apns-priority']}, ct=${talk.msg.data.ct!.length}B`);

    // Normal Workhub assignment A → B
    const p = await A.request<{ id: number }>(`${WH}/projects`, { method: 'POST', body: { title: 'GENE-48 push e2e' }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
    await A.request(`${WH}/projects/${p.data!.id}/members`, { method: 'POST', body: { type: 'user', participant: env('WH_B_USER'), edit: true, share: false, manage: false }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
    const stackId = (await workhubApi.board(A, p.data!.id)).project.stacks[0]!.id;
    const t = await A.request<{ id: number }>(`${WH}/projects/${p.data!.id}/tasks`, {
      method: 'POST', body: { stackId, title: 'GENE-48 push e2e task', assignees: [env('WH_B_USER')], priority: 'normal' }, headers: { 'Idempotency-Key': crypto.randomUUID() },
    });
    const wh = await nextPush((x) => 'action' in x && x.action === 'show' && x.app === 'workhub', keys);
    const show = wh.item as Extract<PushAction, { action: 'show' }>;
    assert.deepEqual(show.route, { name: 'task', cardId: t.data!.id });
    results.push(`✔ normal Workhub assignment → same subscription, route=task ${t.data!.id}, FCM priority=${wh.msg.android.priority}, apns-priority=${wh.msg.apns.headers['apns-priority']}`);

    // Unassign → delete control push for that notification
    await workhubApi.updateTask(A, t.data!.id, { assignees: [] });
    const del = await nextPush((x) => 'action' in x && x.action === 'dismiss' && x.notificationIds.includes(show.notificationId), keys);
    assert.equal(del.msg.data.topic, `nid${show.notificationId}`);
    results.push(`✔ unassign → delete push for nid ${show.notificationId} (topic=${del.msg.data.topic}) — app removes the OS notification`);

    await A.request(`${WH}/tasks/${t.data!.id}`, { method: 'DELETE' });
    const { items } = await listNotifications(B);
    for (const n of items ?? []) await dismissNotification(B, n.id);
    await unregisterWebPush(B);
    results.push(`✔ cleanup: task deleted, B inbox dismissed, subscription unregistered`);
    results.push(`relay HTTP statuses returned to Nextcloud: ${[...new Set(statusLog)].join(',')} (${statusLog.length} pushes)`);
  } finally {
    server.close();
    console.log(results.join('\n'));
  }
}

main().catch((e) => {
  console.error('e2e failed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
