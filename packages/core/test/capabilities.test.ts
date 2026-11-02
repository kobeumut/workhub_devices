import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCompatibility, parseServerCapabilities, parseWorkhubBootstrap } from '../src/capabilities';

test('parses server capabilities and reports compatibility issues', () => {
  const caps = parseServerCapabilities({
    version: { major: 34, string: '34.0.1' },
    capabilities: {
      spreed: { features: ['conversation-v4', 'chat-v2', 'chat-reference-id'], version: '21.1.0' },
      notifications: { 'ocs-endpoints': ['list', 'delete'], push: ['devices'] },
      workhub: { version: '0.5.0', apiVersion: '1' },
    },
  });
  assert.equal(caps.nextcloudMajor, 34);
  assert.ok(caps.talk.features.has('chat-reference-id'));
  assert.deepEqual(checkCompatibility(caps), []);

  const bad = parseServerCapabilities({ capabilities: { spreed: { features: ['chat-v2'] } } });
  assert.deepEqual(checkCompatibility(bad), [
    { kind: 'talk_feature_missing', feature: 'conversation-v4' },
    { kind: 'notifications_missing' },
    { kind: 'workhub_missing' },
  ]);
});

test('workhub bootstrap fails closed for unknown/missing modules', () => {
  const b = parseWorkhubBootstrap({ apiVersion: '1', user: { uid: 'ali', isAdmin: 'yes' }, modules: { projects: true, ai: 'true' }, deck: { backend: 'deck' } });
  assert.equal(b.modules.projects, true);
  assert.equal(b.modules.ai, false);
  assert.equal(b.modules.time, false);
  assert.equal(b.user.isAdmin, false);
  assert.equal(b.backend, 'deck');
  assert.equal(parseWorkhubBootstrap(null).backend, 'native');
});
