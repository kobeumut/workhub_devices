import test from 'node:test';
import assert from 'node:assert/strict';
import { openTaskFromNotification, workhubApi } from '../src/workhub';
import { OcsClient } from '../src/ocs';
import { normalizeServerUrl } from '../src/serverUrl';
import { headerOf, json, ocs, scriptedFetch } from './helpers';

const client = (f: ReturnType<typeof scriptedFetch>) =>
  new OcsClient({ serverBase: normalizeServerUrl('https://example.com/nc'), getCredentials: async () => ({ loginName: 'a', appPassword: 'b' }), fetch: f });

test('opening a task from a notification always re-fetches with current ACL', async () => {
  const f = scriptedFetch(
    json(200, ocs({ id: 5, title: 'Güncel başlık' })),
    json(403, ocs({ error: 'ACTION_FORBIDDEN' }, 403, 'failure')),
    json(403, ocs({ error: 'PROJECTS_DISABLED' }, 403, 'failure')),
    json(404, ocs({ error: 'RESOURCE_NOT_FOUND' }, 404, 'failure')),
  );
  const c = client(f);
  const ok = await openTaskFromNotification(c, 5, true);
  assert.equal(ok.state === 'ok' && ok.task.title, 'Güncel başlık');
  assert.equal(f.calls[0]!.url, 'https://example.com/nc/ocs/v2.php/apps/workhub/api/v1/tasks/5?format=json');
  assert.deepEqual(await openTaskFromNotification(c, 5, true), { state: 'forbidden' });
  assert.deepEqual(await openTaskFromNotification(c, 5, true), { state: 'feature_off' });
  assert.deepEqual(await openTaskFromNotification(c, 5, true), { state: 'gone' });
  assert.deepEqual(await openTaskFromNotification(c, 5, false), { state: 'feature_off' });
  assert.equal(f.calls.length, 4);
});

test('ids are validated and comment create carries an Idempotency-Key', async () => {
  await assert.rejects(workhubApi.task(client(scriptedFetch()), -1));
  await assert.rejects(workhubApi.task(client(scriptedFetch()), 1.5));
  const f = scriptedFetch(json(201, ocs({ id: 1, message: 'x' })), json(200, ocs({ projects: [{ id: 1 }] })));
  await workhubApi.addComment(client(f), 5, 'x', 'key-1');
  assert.equal(headerOf(f.calls[0], 'Idempotency-Key'), 'key-1');
  assert.equal((await workhubApi.projects(client(f))).length, 1);
  assert.equal(new URL(f.calls[1]!.url).searchParams.get('includeArchived'), '0');
});
