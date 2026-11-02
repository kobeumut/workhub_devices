import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeApiPath, encodeBasicAuth, OcsClient, OcsError, parseRetryAfter } from '../src/ocs';
import { normalizeServerUrl } from '../src/serverUrl';
import { headerOf, json, ocs, scriptedFetch } from './helpers';

const serverBase = normalizeServerUrl('https://cloud.example.com/nc');
const client = (fetch: ReturnType<typeof scriptedFetch>, timeoutMs?: number) =>
  new OcsClient({ serverBase, getCredentials: async () => ({ loginName: 'ayşe', appPassword: 'app-pw' }), fetch, ...(timeoutMs ? { timeoutMs } : {}) });

const kindOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof OcsError ? e : (e as Error).message;
  }
};

test('sends OCS headers, UTF-8 basic auth, no redirects, json body', async () => {
  const f = scriptedFetch(json(200, ocs({ ok: 1 })));
  const r = await client(f).request<{ ok: number }>('/ocs/v2.php/apps/workhub/api/v1/tasks/5', { method: 'PATCH', body: { title: 'Ş' } });
  assert.deepEqual(r.data, { ok: 1 });
  const c = f.calls[0]!;
  assert.equal(c.url, 'https://cloud.example.com/nc/ocs/v2.php/apps/workhub/api/v1/tasks/5?format=json');
  assert.equal(c.init.method, 'PATCH');
  assert.equal(c.init.redirect, 'manual');
  assert.equal(c.init.credentials, 'omit');
  assert.equal(headerOf(c, 'OCS-APIRequest'), 'true');
  assert.equal(headerOf(c, 'Authorization'), encodeBasicAuth('ayşe', 'app-pw'));
  assert.equal(Buffer.from(encodeBasicAuth('ayşe', 'app-pw').slice(6), 'base64').toString('utf8'), 'ayşe:app-pw');
  assert.equal(c.init.body, '{"title":"Ş"}');
});

test('maps HTTP errors and keeps Workhub error code', async () => {
  const f = scriptedFetch(
    json(401, ocs(null, 401, 'failure')),
    json(403, ocs({ error: 'PROJECTS_DISABLED', message: 'x' }, 403, 'failure')),
    json(404, ocs({ error: 'RESOURCE_NOT_FOUND' }, 404, 'failure')),
    json(429, ocs(null, 429, 'failure'), { 'Retry-After': '7' }),
    json(409, {}),
    json(502, 'bad gateway'),
  );
  const c = client(f);
  const e1 = (await kindOf(c.get('/a'))) as OcsError;
  assert.equal(e1.kind, 'unauthorized');
  const e2 = (await kindOf(c.get('/a'))) as OcsError;
  assert.equal(e2.kind, 'forbidden');
  assert.equal(e2.errorCode, 'PROJECTS_DISABLED');
  assert.equal(((await kindOf(c.get('/a'))) as OcsError).kind, 'not_found');
  const e4 = (await kindOf(c.get('/a'))) as OcsError;
  assert.equal(e4.kind, 'rate_limited');
  assert.equal(e4.retryAfterMs, 7000);
  assert.equal(((await kindOf(c.get('/a'))) as OcsError).kind, 'conflict');
  const e6 = (await kindOf(c.get('/a'))) as OcsError;
  assert.equal(e6.kind, 'server');
  assert.ok(e6.transient);
});

test('OCS v1 failure inside HTTP 200 is an error', async () => {
  const f = scriptedFetch(json(200, ocs(null, 997, 'failure')));
  assert.equal(((await kindOf(client(f).get('/ocs/v1.php/x'))) as OcsError).kind, 'unauthorized');
});

test('redirects are never followed with credentials', async () => {
  const f = scriptedFetch(new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }));
  assert.equal(((await kindOf(client(f).get('/a'))) as OcsError).kind, 'redirect');
  assert.equal(f.calls.length, 1);
});

test('304 and 204 return null data', async () => {
  const f = scriptedFetch(json(304, null), json(204, null));
  assert.equal((await client(f).request('/a')).data, null);
  assert.equal((await client(f).request('/a')).status, 204);
});

test('timeout and network errors are distinguished', async () => {
  const hang = scriptedFetch(
    (c) =>
      new Promise<Response>((_, reject) => {
        c.init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    new TypeError('offline'),
  );
  const c = client(hang, 20);
  assert.equal(((await kindOf(c.get('/a'))) as OcsError).kind, 'timeout');
  assert.equal(((await kindOf(c.get('/a'))) as OcsError).kind, 'network');
});

test('only relative safe API paths get credentials', () => {
  for (const bad of ['https://evil/x', '//evil/x', 'x', '/a/../b', '/a?b=1', '/a#b', '/a b', '/a\\b']) {
    assert.throws(() => assertSafeApiPath(bad), OcsError, bad);
  }
  assert.doesNotThrow(() => assertSafeApiPath('/ocs/v2.php/apps/spreed/api/v4/room'));
});

test('Retry-After seconds and HTTP-date', () => {
  assert.equal(parseRetryAfter('120'), 120_000);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6_000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter('soon'), undefined);
});
