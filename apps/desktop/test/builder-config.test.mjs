// Packaging identity comes only from config/app-identity.json (GENE-59).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { builderConfig } = require('../scripts/builder-config.cjs');
const identity = JSON.parse(readFileSync(new URL('../../../config/app-identity.json', import.meta.url), 'utf8'));

test('desktop package identity and version mirror app-identity.json', () => {
  const c = require('../electron-builder.config.cjs');
  assert.equal(c.appId, identity.desktop.appId);
  assert.equal(c.productName, identity.displayName);
  assert.equal(c.extraMetadata.version, identity.version);
  assert.equal(c.executableName, identity.desktop.executableName);
  assert.match(c.electronVersion, /^\d+\.\d+\.\d+$/, 'exact Electron version for packaging');
  assert.deepEqual(c.linux.target, ['AppImage', 'deb']);
  assert.ok(c.deb.depends.includes('libsecret-1-0'), 'credential store is a hard dependency');
  assert.ok(c.files.includes('!node_modules/**/*'), 'bundled app ships no node_modules');
});

test('invalid identity fails closed', () => {
  assert.throws(() => builderConfig({ ...identity, version: '1.0' }), /version must be x\.y\.z/);
  assert.throws(() => builderConfig({ ...identity, version: undefined }), /version/);
  assert.throws(() => builderConfig({ ...identity, desktop: { appId: 'x' } }), /required/);
});

test('every surface reads the same version (no hard-coded copies)', () => {
  for (const f of ['../src/renderer/main.tsx', '../src/main/main.ts', '../../mobile/src/App.tsx']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(src, /identity\.version/, f);
    assert.doesNotMatch(src, /appVersion: '\d/, f);
  }
  const gradle = readFileSync(new URL('../../mobile/android/app/build.gradle', import.meta.url), 'utf8');
  assert.match(gradle, /versionName appIdentity\.version/);
  assert.match(gradle, /applicationId appIdentity\.android\.applicationId/);
});
