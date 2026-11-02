import test from 'node:test';
import assert from 'node:assert/strict';
import { isWithinServer, normalizeServerUrl, ServerUrlError } from '../src/serverUrl';

test('normalizes host, defaults to https, keeps sub-directory', () => {
  assert.equal(normalizeServerUrl(' Cloud.Example.com '), 'https://cloud.example.com');
  assert.equal(normalizeServerUrl('https://example.com/nextcloud/'), 'https://example.com/nextcloud');
  assert.equal(normalizeServerUrl('https://example.com:8443/nc/index.php/apps/workhub/projects'), 'https://example.com:8443/nc');
  assert.equal(normalizeServerUrl('https://example.com/apps/spreed'), 'https://example.com');
});

test('rejects insecure, userinfo, query and fragment', () => {
  const code = (s: string, o = {}) => {
    try {
      normalizeServerUrl(s, o);
      return 'ok';
    } catch (e) {
      return (e as ServerUrlError).code;
    }
  };
  assert.equal(code('http://example.com'), 'insecure');
  assert.equal(code('http://localhost:8080', { allowInsecureHttp: true }), 'ok');
  assert.equal(code('ftp://example.com'), 'insecure');
  assert.equal(code('https://user:pw@example.com'), 'userinfo');
  assert.equal(code('https://example.com/?a=1'), 'query');
  assert.equal(code('https://example.com/?'), 'query');
  assert.equal(code('https://example.com/#x'), 'fragment');
  assert.equal(code('   '), 'empty');
});

test('isWithinServer enforces origin and path prefix', () => {
  const base = normalizeServerUrl('https://example.com/nc');
  assert.ok(isWithinServer(base, 'https://example.com/nc/index.php/login/v2/flow/abc'));
  assert.ok(isWithinServer(base, 'https://example.com/nc'));
  assert.ok(!isWithinServer(base, 'https://example.com/ncevil/login'));
  assert.ok(!isWithinServer(base, 'https://evil.example.com/nc/login'));
  assert.ok(!isWithinServer(base, 'http://example.com/nc/login'));
  assert.ok(!isWithinServer(base, 'https://a:b@example.com/nc/login'));
  assert.ok(!isWithinServer(base, 'not a url'));
});
