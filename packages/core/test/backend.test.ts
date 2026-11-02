import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectBackend, createWireBackend, dispatchWire, type PlainStore } from '../src/backend';
import type { SecretStore } from '../src/accounts';
import { OcsError } from '../src/ocs';
import { json, ocs, scriptedFetch } from './helpers';

class Mem implements SecretStore, PlainStore {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
  async deletePrefix(p: string) { for (const k of [...this.m.keys()]) if (k.startsWith(p)) this.m.delete(k); }
}

test('login → account persisted (secret separate) → rooms → logout wipes only that account', async () => {
  const secrets = new Mem();
  const plain = new Mem();
  const f = scriptedFetch(
    json(200, { login: 'https://ex.com/index.php/login/v2/flow/x', poll: { token: 't', endpoint: 'https://ex.com/index.php/login/v2/poll' } }),
    json(200, { server: 'https://ex.com', loginName: 'ali', appPassword: 'pw' }),
    json(200, ocs([{ token: 'abc' }]), { 'X-Nextcloud-Talk-Modified-Before': '100' }),
    json(200, ocs([])),
  );
  const b = createDirectBackend({ secrets, plain, fetch: f });
  const { flowId, loginUrl } = await b.beginLogin('ex.com');
  assert.equal(loginUrl, 'https://ex.com/index.php/login/v2/flow/x');
  const acc = await b.completeLogin(flowId);
  assert.equal(acc.loginName, 'ali');
  assert.deepEqual((await b.listAccounts()).map((a) => a.id), [acc.id]);
  assert.ok(![...plain.m.values()].some((v) => v.includes('pw')), 'app password must not be in plain store');
  await plain.set(`${acc.id}::draft::abc`, 'taslak');
  const r = await b.rooms(acc.id);
  assert.equal(r.rooms[0]!.token, 'abc');
  const rep = await b.logout(acc.id);
  assert.equal(rep.appPasswordRevoked, true);
  assert.deepEqual(await b.listAccounts(), []);
  assert.equal(plain.m.has(`${acc.id}::draft::abc`), false);
  assert.equal(secrets.m.size, 0);
});

test('wire dispatch rejects unknown methods / bad args and never leaks raw errors', async () => {
  const b = createDirectBackend({ secrets: new Mem(), plain: new Mem(), fetch: scriptedFetch() });
  assert.deepEqual(await dispatchWire(b, 'constructor', []), { ok: false, error: { kind: 'client', message: 'rejected' } });
  assert.deepEqual(await dispatchWire(b, 'board', ['acc', -1]), { ok: false, error: { kind: 'client', message: 'invalid arguments' } });
  assert.deepEqual(await dispatchWire(b, 'send', ['acc', 'abc']), { ok: false, error: { kind: 'client', message: 'invalid arguments' } });
  const r = await dispatchWire(b, 'beginLogin', ['http://insecure.example']);
  assert.deepEqual(r, { ok: false, error: { kind: 'url:insecure' } });
  const unknown = await dispatchWire(b, 'rooms', ['nope']);
  assert.equal(unknown.ok === false && unknown.error.kind, 'unauthorized');
});

test('wire backend rethrows OcsError on the renderer side', async () => {
  const wb = createWireBackend(async () => ({ ok: false, error: { kind: 'forbidden', status: 403, errorCode: 'PROJECTS_DISABLED' } }));
  await assert.rejects(wb.projects('a' as never), (e: unknown) => e instanceof OcsError && e.kind === 'forbidden' && e.errorCode === 'PROJECTS_DISABLED');
});

test('task PATCH over the wire: only known, well-typed fields pass', async () => {
  const b = createDirectBackend({ secrets: new Mem(), plain: new Mem(), fetch: scriptedFetch() });
  const bad = { ok: false, error: { kind: 'client', message: 'invalid arguments' } };
  for (const patch of [
    {},
    { title: '' },
    { title: 'x', url: 'https://evil' },
    { dueDate: 'tomorrow' },
    { priority: 'critical' },
    { assignees: 'bob' },
    { assignees: [''] },
    { labels: [1, -2] },
    { estimateSec: -1 },
    { estimateSec: 1.5 },
    { __proto__: { done: true } },
  ]) {
    assert.deepEqual(await dispatchWire(b, 'updateTask', ['acc', 1, patch]), bad, JSON.stringify(patch));
  }
  // valid shapes reach the backend (unknown account → unauthorized, not a validation error)
  for (const patch of [{ title: 'Yeni' }, { dueDate: null, startDate: '2026-11-03' }, { assignees: [], labels: [] }, { priority: null, estimateSec: 3600 }, { dueDate: '2026-11-03T09:00:00Z' }]) {
    const r = await dispatchWire(b, 'updateTask', ['acc', 1, patch]);
    assert.equal(r.ok === false && r.error.kind, 'unauthorized', JSON.stringify(patch));
  }
  assert.deepEqual(await dispatchWire(b, 'updateSubtask', ['acc', 1, 0, 'a', { text: 'b', url: 'x' }]), bad);
  assert.deepEqual(await dispatchWire(b, 'updateSubtask', ['acc', 1, -1, 'a', { done: true }]), bad);
  assert.deepEqual(await dispatchWire(b, 'addDependency', ['acc', 5, 5]), bad);
});

test('project management + shares over the wire: strict shapes, unknown keys rejected', async () => {
  const b = createDirectBackend({ secrets: new Mem(), plain: new Mem(), fetch: scriptedFetch() });
  const bad = { ok: false, error: { kind: 'client', message: 'invalid arguments' } };
  const key = '0b6f2c3e-1a2b-4c5d-8e9f-001122334455';
  const grant = { type: 'user', participant: 'bob', edit: true, share: false, manage: false };
  for (const [m, args] of [
    ['createProject', ['acc', '   ', null, key]],
    ['createProject', ['acc', 'x'.repeat(256), null, key]],
    ['createProject', ['acc', 'P', 'red', key]],
    ['createProject', ['acc', 'P', null, 'not a key']],
    ['renameProject', ['acc', 1, 'x'.repeat(101)]],
    ['renameProject', ['acc', 0, 'Yeni']],
    ['addProjectMember', ['acc', 1, { ...grant, type: 'circle' }, key]],
    ['addProjectMember', ['acc', 1, { ...grant, participant: '' }, key]],
    ['addProjectMember', ['acc', 1, { ...grant, edit: 'yes' }, key]],
    ['addProjectMember', ['acc', 1, { ...grant, admin: true }, key]],
    ['addProjectMember', ['acc', 1, { type: 'user', participant: 'bob' }, key]],
    ['createStack', ['acc', 1, '', 0]],
    ['createStack', ['acc', 1, 'Review', -1]],
    ['renameStack', ['acc', 1, '']],
    ['principals', ['acc', 'x'.repeat(65)]],
    ['objectShares', ['acc', 'project', 1]],
    ['objectShares', ['acc', 'goal', -1]],
    ['setObjectShares', ['acc', 'goal', 1, [{ principalType: 'user', principalId: 'bob', role: 'owner' }]]],
    ['setObjectShares', ['acc', 'goal', 1, [{ principalType: 'user', principalId: 'bob', role: 'view', extra: 1 }]]],
    ['setObjectShares', ['acc', 'goal', 1, { principalType: 'user', principalId: 'bob', role: 'view' }]],
    ['setObjectShares', ['acc', 'goal', 1, Array.from({ length: 101 }, (_, i) => ({ principalType: 'user', principalId: `u${i}`, role: 'view' }))]],
  ] as const) {
    assert.deepEqual(await dispatchWire(b, m, args as unknown as unknown[]), bad, `${m} ${JSON.stringify(args)}`);
  }
  for (const [m, args] of [
    ['createProject', ['acc', 'Proje', '#ff0000', key]],
    ['createProject', ['acc', 'Proje', null, key]],
    ['renameProject', ['acc', 1, 'Yeni ad']],
    ['addProjectMember', ['acc', 1, grant, key]],
    ['addProjectMember', ['acc', 1, { type: 'group', participant: 'staff', edit: false, share: false, manage: false }, key]],
    ['createStack', ['acc', 1, 'Review', 3]],
    ['renameStack', ['acc', 1, 'QA']],
    ['principals', ['acc', 'bo']],
    ['objectShares', ['acc', 'goal', 1]],
    ['setObjectShares', ['acc', 'dashboard', 1, []]],
    ['setObjectShares', ['acc', 'workflow', 1, [{ principalType: 'group', principalId: 'staff', role: 'edit' }]]],
  ] as const) {
    const r = await dispatchWire(b, m, args as unknown as unknown[]);
    assert.equal(r.ok === false && r.error.kind, 'unauthorized', `${m} ${JSON.stringify(args)}`);
  }
});
