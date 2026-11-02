import test from 'node:test';
import assert from 'node:assert/strict';
import { pollLoginFlow, startLoginFlow, LoginFlowError } from '../src/loginFlow';
import { accountIdFor, addAccount, createAccountClient, logout, MissingCredentialError, scopedKey, type SecretStore } from '../src/accounts';
import { normalizeServerUrl } from '../src/serverUrl';
import { headerOf, json, ocs, scriptedFetch } from './helpers';

const base = normalizeServerUrl('https://example.com/nc');
const noSleep = async () => {};
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e as LoginFlowError).code);

test('login flow start rejects endpoints outside the server', async () => {
  const good = { login: 'https://example.com/nc/index.php/login/v2/flow/x', poll: { token: 't', endpoint: 'https://example.com/nc/index.php/login/v2/poll' } };
  const f = scriptedFetch(json(200, good), json(200, { ...good, poll: { token: 't', endpoint: 'https://evil.example/poll' } }), json(200, { ...good, login: 'https://example.com/ncx/flow' }));
  const s = await startLoginFlow(base, { fetch: f });
  assert.equal(f.calls[0]!.url, 'https://example.com/nc/index.php/login/v2');
  assert.equal(f.calls[0]!.init.credentials, 'omit');
  assert.equal(s.pollToken, 't');
  assert.equal(await code(startLoginFlow(base, { fetch: f })), 'untrusted_endpoint');
  assert.equal(await code(startLoginFlow(base, { fetch: f })), 'untrusted_endpoint');
});

const start = { loginUrl: 'https://example.com/nc/index.php/login/v2/flow/x', pollEndpoint: 'https://example.com/nc/index.php/login/v2/poll', pollToken: 'secret-token' };

test('login flow poll waits through 404 / network errors, then returns app password', async () => {
  const f = scriptedFetch(json(404, []), new TypeError('offline'), json(200, { server: 'https://example.com/nc', loginName: 'ali', appPassword: 'pw' }));
  const r = await pollLoginFlow(base, start, { fetch: f, sleep: noSleep });
  assert.deepEqual(r, { serverBase: 'https://example.com/nc', loginName: 'ali', appPassword: 'pw' });
  assert.equal(f.calls[0]!.init.body, 'token=secret-token');
  assert.equal(f.calls.length, 3);
});

test('login flow poll rejects a result bound to another origin', async () => {
  const f = scriptedFetch(json(200, { server: 'https://evil.example', loginName: 'ali', appPassword: 'pw' }));
  assert.equal(await code(pollLoginFlow(base, start, { fetch: f, sleep: noSleep })), 'untrusted_endpoint');
});

test('login flow poll is cancellable and bounded', async () => {
  const ac = new AbortController();
  ac.abort();
  assert.equal(await code(pollLoginFlow(base, start, { fetch: scriptedFetch(), signal: ac.signal })), 'cancelled');
  let t = 0;
  const f = scriptedFetch(json(404, []), json(404, []), json(404, []));
  const r = pollLoginFlow(base, start, { fetch: f, sleep: async () => void (t += 1000), now: () => t, maxDurationMs: 2500 });
  assert.equal(await code(r), 'expired');
});

class MemoryStore implements SecretStore {
  data = new Map<string, string>();
  async get(k: string) {
    return this.data.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.data.set(k, v);
  }
  async delete(k: string) {
    this.data.delete(k);
  }
}

test('same username on two servers stays isolated; logout wipes only one account', async () => {
  const store = new MemoryStore();
  const a = await addAccount(store, { serverBase: normalizeServerUrl('https://one.example'), loginName: 'ali', appPassword: 'pw-1' });
  const b = await addAccount(store, { serverBase: normalizeServerUrl('https://two.example'), loginName: 'ali', appPassword: 'pw-2' });
  assert.notEqual(a.id, b.id);
  assert.notEqual(scopedKey(a.id, 'room', 'abc'), scopedKey(b.id, 'room', 'abc'));

  const f = scriptedFetch(json(200, ocs([])), json(200, ocs([])));
  await createAccountClient(a, store, { fetch: f }).get('/x');
  await createAccountClient(b, store, { fetch: f }).get('/x');
  assert.ok(f.calls[0]!.url.startsWith('https://one.example/'));
  assert.equal(Buffer.from(headerOf(f.calls[0], 'Authorization')!.slice(6), 'base64').toString(), 'ali:pw-1');
  assert.ok(f.calls[1]!.url.startsWith('https://two.example/'));
  assert.equal(Buffer.from(headerOf(f.calls[1], 'Authorization')!.slice(6), 'base64').toString(), 'ali:pw-2');

  const wiped: string[] = [];
  // offline logout: revoke fails, local wipe still happens
  const report = await logout(a, store, { fetch: scriptedFetch(new TypeError('offline')), wipeLocalData: async (id) => void wiped.push(id) });
  assert.deepEqual(report, { pushDeregistered: 'skipped', appPasswordRevoked: false, localWiped: true });
  assert.deepEqual(wiped, [a.id]);
  await assert.rejects(createAccountClient(a, store).get('/x'), MissingCredentialError);
  assert.equal(await store.get(scopedKey(b.id, 'app-password')), 'pw-2');
});

test('logout revokes the app password online', async () => {
  const store = new MemoryStore();
  const a = await addAccount(store, { serverBase: base, loginName: 'ali', appPassword: 'pw' });
  const f = scriptedFetch(json(200, ocs([])));
  const r = await logout(a, store, { fetch: f, deregisterPush: async () => true, wipeLocalData: async () => {} });
  assert.equal(f.calls[0]!.url, 'https://example.com/nc/ocs/v2.php/core/apppassword?format=json');
  assert.equal(f.calls[0]!.init.method, 'DELETE');
  assert.deepEqual(r, { pushDeregistered: true, appPasswordRevoked: true, localWiped: true });
  assert.equal(accountIdFor(base, 'ali'), a.id);
});
