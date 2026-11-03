// `npm run smoke:call-loopback -w @workhub-devices/desktop`: bundles the shared call engine and
// runs two engines against real Chromium WebRTC (no server needed). Exit code 0 = passed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'dist', 'call-loopback');
mkdirSync(out, { recursive: true });
require('esbuild').buildSync({ entryPoints: [join(here, 'call-loopback', 'page.ts')], bundle: true, format: 'iife', target: 'chrome120', outfile: join(out, 'page.js') });
writeFileSync(join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><title>call loopback</title><script src="page.js"></script>');
copyFileSync(join(here, 'call-loopback', 'main.cjs'), join(out, 'main.cjs'));
// Same flags as the UI smoke (dev machines lack the setuid chrome-sandbox helper).
const args = [join(out, 'main.cjs'), '--no-sandbox'];
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) args.push('--ozone-platform=headless', '--disable-gpu');
const r = spawnSync(require('electron'), args, { stdio: 'inherit', env: { ...process.env } });
process.exit(r.status ?? 1);
