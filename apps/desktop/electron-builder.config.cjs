// electron-builder configuration. App id, product name, executable name and version come only
// from config/app-identity.json (single, human-approved identity source — GENE-48).
// Used by `npm run dist` / `npm run dist:linux`.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { builderConfig } = require('./scripts/builder-config.cjs');

module.exports = builderConfig(
  JSON.parse(readFileSync(join(__dirname, '..', '..', 'config', 'app-identity.json'), 'utf8')),
  require('electron/package.json').version,
);
