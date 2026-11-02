import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { audienceMatches, buildFcmMessage, handleWebPush, MAX_INLINE_CT, parseVapidHeader, type FcmMessage, type RelayRequest, type SendResult } from '../src/relay';

const ORIGIN = 'https://push.example.com';
const NOW = 1_800_000_000_000;
const TOKEN = 'fcm-token_abc:123456789012345';

function vapidKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
  const jwt = (claims: object, alg = 'ES256') => {
    const h = Buffer.from(JSON.stringify({ typ: 'JWT', alg })).toString('base64url');
    const c = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const s = sign('sha256', Buffer.from(`${h}.${c}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return `${h}.${c}.${s}`;
  };
  return { raw, jwt };
}

const k = vapidKey();
const goodJwt = k.jwt({ aud: ORIGIN, exp: NOW / 1000 + 3600, sub: 'mailto:admin@example.com' });
const req = (over: Partial<RelayRequest> = {}, headers: Record<string, string> = {}): RelayRequest => ({
  method: 'POST',
  path: `/wp/${TOKEN}`,
  query: { k: k.raw },
  headers: { authorization: `vapid t=${goodJwt}, k=${k.raw}`, 'content-encoding': 'aes128gcm', topic: 'nid7', urgency: 'high', ttl: '2419200', ...headers },
  body: new Uint8Array(2900).fill(7),
  ...over,
});
const sender = (result: SendResult = { ok: true }) => {
  const sent: FcmMessage[] = [];
  return { sent, send: async (m: FcmMessage) => (sent.push(m), result) };
};

test('valid VAPID push is forwarded once with the encrypted body', async () => {
  const s = sender();
  const r = await handleWebPush(req(), { origin: ORIGIN, send: s.send, now: () => NOW });
  assert.equal(r.status, 201);
  assert.equal(s.sent.length, 1);
  const m = s.sent[0]!;
  assert.equal(m.token, TOKEN);
  assert.equal(Buffer.from(m.data.ct!, 'base64url').length, 2900);
  assert.equal(m.data.topic, 'nid7');
  assert.equal(m.android.priority, 'high');
  assert.equal(m.android.collapseKey, 'nid7');
  assert.equal(m.apns.headers['apns-priority'], '10');
  assert.equal(m.apns.payload.aps['mutable-content'], 1);
  assert.ok(!JSON.stringify(m.apns.payload).includes('\u0007'));
});

test('rejects unsigned, foreign-key, wrong-audience, expired and non-ES256 requests', async () => {
  const other = vapidKey();
  const cases: Array<[string, RelayRequest]> = [
    ['no auth', req({}, { authorization: '' })],
    ['other key not pinned', req({}, { authorization: `vapid t=${other.jwt({ aud: ORIGIN, exp: NOW / 1000 + 60 })}, k=${other.raw}` })],
    ['pinned key but forged signature', req({}, { authorization: `vapid t=${other.jwt({ aud: ORIGIN, exp: NOW / 1000 + 60 })}, k=${k.raw}` })],
    ['wrong aud', req({}, { authorization: `vapid t=${k.jwt({ aud: 'https://evil', exp: NOW / 1000 + 60 })}, k=${k.raw}` })],
    ['expired', req({}, { authorization: `vapid t=${k.jwt({ aud: ORIGIN, exp: NOW / 1000 - 1 })}, k=${k.raw}` })],
    ['exp too far', req({}, { authorization: `vapid t=${k.jwt({ aud: ORIGIN, exp: NOW / 1000 + 3 * 86400 })}, k=${k.raw}` })],
    ['alg none', req({}, { authorization: `vapid t=${k.jwt({ aud: ORIGIN, exp: NOW / 1000 + 60 }, 'none')}, k=${k.raw}` })],
  ];
  for (const [name, r] of cases) {
    const s = sender();
    assert.equal((await handleWebPush(r, { origin: ORIGIN, send: s.send, now: () => NOW })).status, 401, name);
    assert.equal(s.sent.length, 0, name);
  }
});

test('request shape validation', async () => {
  const d = { origin: ORIGIN, send: sender().send, now: () => NOW };
  assert.equal((await handleWebPush(req({ method: 'GET' }), d)).status, 405);
  assert.equal((await handleWebPush(req({ path: '/wp/a b' }), d)).status, 404);
  assert.equal((await handleWebPush(req({ path: '/other' }), d)).status, 404);
  assert.equal((await handleWebPush(req({ query: {} }), d)).status, 404);
  assert.equal((await handleWebPush(req({}, { 'content-encoding': 'aesgcm' }), d)).status, 415);
  assert.equal((await handleWebPush(req({ body: new Uint8Array(5000) }), d)).status, 413);
  assert.equal((await handleWebPush(req({ body: new Uint8Array(0) }), d)).status, 413);
});

test('FCM results map to Web Push status codes', async () => {
  const run = (r: SendResult) => handleWebPush(req(), { origin: ORIGIN, send: sender(r).send, now: () => NOW });
  assert.equal((await run({ ok: false, reason: 'unregistered' })).status, 410);
  assert.equal((await run({ ok: false, reason: 'invalid' })).status, 410);
  const q = await run({ ok: false, reason: 'quota', retryAfterSec: 9 });
  assert.equal(q.status, 429);
  assert.equal(q.headers?.['Retry-After'], '9');
  assert.equal((await run({ ok: false, reason: 'unavailable' })).status, 503);
});

test('oversized bodies are not inlined; app fetches by topic', () => {
  const m = buildFcmMessage(TOKEN, new Uint8Array(3100), { topic: 'nid9', urgency: 'normal' });
  assert.equal(m.data.ct, undefined);
  assert.equal(m.data.topic, 'nid9');
  assert.ok(Buffer.from(new Uint8Array(2923)).toString('base64url').length <= MAX_INLINE_CT);
  const bad = buildFcmMessage(TOKEN, new Uint8Array(10), { topic: 'x y\n', urgency: 'evil', ttl: '-5' });
  assert.equal(bad.data.topic, undefined);
  assert.equal(bad.data.urgency, 'normal');
  assert.equal(bad.android.ttl, '0s');
  assert.equal(bad.apns.headers['apns-priority'], '10'); // unknown urgency → normal → visible alert
  assert.equal(buildFcmMessage(TOKEN, new Uint8Array(10), { urgency: 'low' }).apns.headers['apns-priority'], '5');
  assert.equal(buildFcmMessage(TOKEN, new Uint8Array(10), { urgency: 'very-low' }).android.priority, 'normal');
});

test('parses RFC 8292 header', () => {
  assert.deepEqual(parseVapidHeader('vapid t=a.b.c, k=XYZ'), { jwt: 'a.b.c', key: 'XYZ' });
  assert.equal(parseVapidHeader('Bearer x'), null);
  assert.equal(parseVapidHeader(undefined), null);
});

test('VAPID aud: exact origin, or host without port (Nextcloud web-push library form)', () => {
  assert.ok(audienceMatches('https://push.example.com', 'https://push.example.com'));
  assert.ok(audienceMatches('https://relay', 'https://relay:8789'));
  assert.ok(!audienceMatches('https://relay.evil', 'https://relay:8789'));
  assert.ok(!audienceMatches('http://relay', 'https://relay:8789'));
  assert.ok(!audienceMatches(undefined, 'https://relay'));
});
