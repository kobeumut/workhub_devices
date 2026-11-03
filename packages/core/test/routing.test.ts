import test from 'node:test';
import assert from 'node:assert/strict';
import {
  interpretPush, normalizeInboxNotification, parseServerLink, presentNotification, routeForObject, shouldRaiseOsAlert,
} from '../src/routing';
import { accountIdFor } from '../src/accounts';
import { normalizeServerUrl } from '../src/serverUrl';

test('dispatcher routes Talk and Workhub objects; unknown goes to inbox', () => {
  assert.deepEqual(routeForObject('spreed', 'chat', 'abc123/42'), { name: 'room', token: 'abc123', messageId: 42 });
  assert.deepEqual(routeForObject('spreed', 'room', 'abc123'), { name: 'room', token: 'abc123' });
  assert.deepEqual(routeForObject('workhub', 'card', '17'), { name: 'task', cardId: 17 });
  assert.deepEqual(routeForObject('workhub', 'card', '17; rm -rf'), { name: 'inbox' });
  assert.deepEqual(routeForObject('spreed', 'chat', '../x'), { name: 'inbox' });
  assert.deepEqual(routeForObject('deck', 'card', '17', 5), { name: 'inbox', notificationId: 5 });
});

test('inbox normalisation keeps shouldNotify=false items but marks them silent', () => {
  const n = normalizeInboxNotification({ notification_id: 3, app: 'workhub', object_type: 'card', object_id: '9', subject: 's', shouldNotify: false });
  assert.equal(n?.shouldNotify, false);
  assert.equal(normalizeInboxNotification({ app: 'x' }), null);
  const a = accountIdFor(normalizeServerUrl('https://a.example'), 'u');
  assert.equal(shouldRaiseOsAlert(n!, null, { accountId: a, route: { name: 'task', cardId: 9 } }), false);
});

test('push payload interpretation incl. delete control messages', () => {
  assert.deepEqual(interpretPush({ app: 'workhub', type: 'card', id: '9', nid: 12, subject: 'x' }), {
    action: 'show', notificationId: 12, app: 'workhub', route: { name: 'task', cardId: 9 },
  });
  assert.deepEqual(interpretPush({ nid: 12, delete: true }), { action: 'dismiss', notificationIds: [12] });
  assert.deepEqual(interpretPush({ 'delete-multiple': true, nids: [1, '2', 'x'] }), { action: 'dismiss', notificationIds: [1, 2] });
  assert.deepEqual(interpretPush({ 'delete-all': true }), { action: 'dismiss-all' });
  assert.equal(interpretPush('garbage').action, 'ignore');
  assert.equal(interpretPush({ app: 'spreed' }).action, 'ignore');
});

test('server links: pretty, index.php and sub-directory forms; foreign origins rejected', () => {
  const root = normalizeServerUrl('https://example.com');
  const sub = normalizeServerUrl('https://example.com/nc');
  assert.deepEqual(parseServerLink(root, 'https://example.com/apps/workhub/projects/task/42'), { name: 'task', cardId: 42 });
  assert.deepEqual(parseServerLink(root, 'https://example.com/index.php/apps/workhub/projects/task/42/'), { name: 'task', cardId: 42 });
  assert.deepEqual(parseServerLink(sub, 'https://example.com/nc/index.php/apps/workhub/projects/task/7'), { name: 'task', cardId: 7 });
  assert.deepEqual(parseServerLink(sub, 'https://example.com/nc/call/abc123'), { name: 'room', token: 'abc123' });
  assert.equal(parseServerLink(sub, 'https://example.com/apps/workhub/projects/task/7'), null);
  assert.equal(parseServerLink(root, 'https://evil.example/apps/workhub/projects/task/7'), null);
  assert.equal(parseServerLink(root, 'javascript:alert(1)'), null);
  assert.equal(parseServerLink(root, 'https://example.com/apps/workhub/projects/task/0'), null);
  // task DTO url form (seen live on Workhub 0.5.0)
  assert.deepEqual(parseServerLink(sub, 'https://example.com/nc/index.php/apps/workhub/projects/2/board?card=9'), { name: 'task', cardId: 9 });
  assert.equal(parseServerLink(root, 'https://example.com/apps/workhub/projects/2/board?card=x'), null);
  assert.equal(parseServerLink(root, 'https://example.com/apps/workhub/projects/2/evil?card=9'), null);
});

test('lock screen default hides content; foreground suppression is account-aware', () => {
  const n = { app: 'spreed', subject: 'Ali: gizli', message: 'detay', shouldNotify: true };
  assert.deepEqual(presentNotification(n, false), { title: 'Yeni mesaj', body: '', channel: 'chat' });
  assert.deepEqual(presentNotification(n, true), { title: 'Ali: gizli', body: 'detay', channel: 'chat' });
  const a = accountIdFor(normalizeServerUrl('https://a.example'), 'u');
  const b = accountIdFor(normalizeServerUrl('https://b.example'), 'u');
  const room = { name: 'room' as const, token: 'abc' };
  assert.equal(shouldRaiseOsAlert(n, { accountId: a, route: room }, { accountId: a, route: room }), false);
  assert.equal(shouldRaiseOsAlert(n, { accountId: a, route: room }, { accountId: b, route: room }), true);
});

test('calls: object_type=call routes to the ringing screen and its own notification channel', () => {
  assert.deepEqual(routeForObject('spreed', 'call', 'abc123'), { name: 'call', token: 'abc123' });
  assert.deepEqual(routeForObject('spreed', 'call', '../x', 3), { name: 'inbox', notificationId: 3 });
  assert.deepEqual(interpretPush({ nid: 9, app: 'spreed', type: 'call', id: 'abc123' }), { action: 'show', notificationId: 9, app: 'spreed', route: { name: 'call', token: 'abc123' } });
  assert.equal(presentNotification({ app: 'spreed', objectType: 'call', subject: 'Bob arıyor', message: '' }, false).channel, 'call');
  assert.equal(presentNotification({ app: 'spreed', objectType: 'call', subject: 'Bob arıyor', message: '' }, false).title, 'Gelen arama');
  assert.equal(presentNotification({ app: 'spreed', objectType: 'chat', subject: 's', message: '' }, false).channel, 'chat');
});
