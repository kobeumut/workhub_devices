import test from 'node:test';
import assert from 'node:assert/strict';
import { activationTokenOf, b64url, decodeRelayedPush, decryptWebPush, generateSubscriptionKeys, WebPushDecryptError, type SubscriptionKeys } from '../src/webpush';

// RFC 8291 Appendix A test vector
const uaPublic = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const pub = b64url.decode(uaPublic);
const rfcKeys: SubscriptionKeys = {
  publicKey: uaPublic,
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  privateJwk: {
    kty: 'EC', crv: 'P-256', d: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    x: b64url.encode(pub.subarray(1, 33)), y: b64url.encode(pub.subarray(33)),
  },
};
const rfcBody = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';

test('decrypts the RFC 8291 test vector', async () => {
  assert.equal(await decryptWebPush(b64url.decode(rfcBody), rfcKeys), 'When I grow up, I want to be a watermelon');
});

test('rejects tampered bodies and wrong keys', async () => {
  const body = b64url.decode(rfcBody);
  body[body.length - 1] = body[body.length - 1]! ^ 1;
  await assert.rejects(decryptWebPush(body, rfcKeys), WebPushDecryptError);
  const other = await generateSubscriptionKeys();
  await assert.rejects(decryptWebPush(b64url.decode(rfcBody), other), WebPushDecryptError);
  await assert.rejects(decryptWebPush(new Uint8Array(10), rfcKeys), WebPushDecryptError);
});

test('generated keys have the formats the server validates', async () => {
  const k = await generateSubscriptionKeys();
  assert.match(k.publicKey, /^[A-Za-z0-9_-]{87}$/);
  assert.match(k.auth, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(b64url.decode(k.publicKey)[0], 4);
});

test('relayed push: inline ciphertext, nid fetch fallback, sync fallback', async () => {
  const r = await decodeRelayedPush({ ct: rfcBody.replace(/$/, '') }, rfcKeys).catch((e) => e);
  assert.ok(r instanceof SyntaxError); // vector plaintext is not JSON; real pushes are
  assert.deepEqual(await decodeRelayedPush({ topic: 'nid42' }, rfcKeys), { kind: 'fetch', notificationId: 42 });
  assert.deepEqual(await decodeRelayedPush({ topic: 'nid0' }, rfcKeys), { kind: 'sync' });
  assert.deepEqual(await decodeRelayedPush({}, rfcKeys), { kind: 'sync' });
  assert.equal(activationTokenOf({ activationToken: 'abc' }), 'abc');
  assert.equal(activationTokenOf({ nid: 1 }), null);
});
