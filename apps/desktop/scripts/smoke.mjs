// Headless desktop UI smoke against a real Nextcloud (see docs/dev-server.md).
// Env: WH_SERVER, WH_A_USER, WH_A_PASS (app password used to approve the login flow),
//      WH_SMOKE_ROOM (display name of a room the user has). Writes screenshots to WH_SMOKE_OUT.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');
const out = resolve(process.env.WH_SMOKE_OUT ?? 'smoke-out');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'workhub-smoke-'));
const child = spawn(electron, ['.', `--user-data-dir=${profile}`, '--ozone-platform=headless', '--disable-gpu', '--no-sandbox'], {
  env: {
    ...process.env,
    WORKHUB_SMOKE_OUT: out,
    WORKHUB_ALLOW_HTTP: '1',
    WORKHUB_TEST_INSECURE_STORE: '1',
    WORKHUB_SMOKE_SERVER: process.env.WH_SERVER,
    WORKHUB_SMOKE_ROOM: process.env.WH_SMOKE_ROOM ?? '',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const urlFile = join(out, 'login-url.txt');
const deadline = Date.now() + 60_000;
while (!existsSync(urlFile) && Date.now() < deadline && child.exitCode === null) await new Promise((r) => setTimeout(r, 300));
if (existsSync(urlFile)) {
  execFileSync(process.execPath, [join(import.meta.dirname, 'approve-login.mjs'), readFileSync(urlFile, 'utf8'), process.env.WH_A_USER], {
    env: { ...process.env, WH_APPROVE_PASS: process.env.WH_A_PASS },
    stdio: 'inherit',
  });
}
const code = await new Promise((r) => child.on('exit', r));
rmSync(profile, { recursive: true, force: true });
const result = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'));
for (const s of result.steps) console.log(`${s.ok ? '✔' : '✘'} ${s.step}${s.note ? ` — ${s.note}` : ''}`);
process.exitCode = result.steps.every((s) => s.ok) && result.steps.length >= 9 ? 0 : 1;
console.log(`electron exit ${code}; screenshots in ${out}`);
