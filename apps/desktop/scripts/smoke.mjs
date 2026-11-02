// Headless desktop UI smoke against a real Nextcloud (see docs/dev-server.md).
// Env: WH_SERVER, WH_A_USER, WH_A_PASS (app password used to approve the login flow),
//      WH_SMOKE_ROOM (display name of a room the user has). Writes screenshots to WH_SMOKE_OUT.
//      Optional WH_C_USER/WH_C_PASS: a user whose Nextcloud manager is WH_A_USER — seeds a pending
//      timesheet for the review step (display name WH_SMOKE_SUBJECT, default "Carol") and two
//      pending requests to WH_A_USER. Optional WH_B_USER/WH_B_PASS (manager of WH_A_USER): seeds two
//      open requests to WH_C_USER that WH_A_USER manages (convert / resolve).
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
// A goal owned by the smoke user so the share editor has something to manage; removed afterwards.
const ocs = async (method, path, body) => {
  const r = await fetch(`${process.env.WH_SERVER}/ocs/v2.php/apps/workhub/api/v1${path}`, {
    method,
    headers: { Authorization: `Basic ${Buffer.from(`${process.env.WH_A_USER}:${process.env.WH_A_PASS}`).toString('base64')}`, 'OCS-APIRequest': 'true', Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return (await r.json()).ocs?.data;
};
const goalTitle = `Masaüstü hedefi ${new Date().toISOString().slice(11, 19)}`;
const goal = process.env.WH_A_PASS ? await ocs('POST', '/goals', { title: goalTitle }).catch(() => null) : null;
// A pending timesheet of a subject (WH_C_*, whose Nextcloud manager is WH_A_USER) for the review step.
const ocsAs = async (user, pass, method, path, body, extra = {}) => {
  const r = await fetch(`${process.env.WH_SERVER}/ocs/v2.php/apps/workhub/api/v1${path}`, {
    method,
    headers: { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`, 'OCS-APIRequest': 'true', Accept: 'application/json', 'Content-Type': 'application/json', ...extra },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return (await r.json()).ocs?.data;
};
let subjectName = '';
if (process.env.WH_C_USER && process.env.WH_C_PASS) {
  const C = (m, p, b, h) => ocsAs(process.env.WH_C_USER, process.env.WH_C_PASS, m, p, b, h).catch(() => null);
  let week = await C('GET', '/time/week');
  const pending = week?.submissions?.find((s) => s.status === 'pending' && s.revision === week.period.revision);
  const approved = week?.period?.state === 'approved' ? week.submissions.find((s) => s.status === 'approved') : null;
  if (approved) {
    // Left approved by an interrupted run: the manager (A) reopens it.
    await ocsAs(process.env.WH_A_USER, process.env.WH_A_PASS, 'POST', `/time/submissions/${approved.id}/reopen`, { version: week.period.version, reason: 'smoke reset' }, { 'Idempotency-Key': crypto.randomUUID() }).catch(() => null);
    week = await C('GET', '/time/week');
  }
  if (pending) {
    await C('POST', `/time/submissions/${pending.id}/withdraw`, { version: week.period.version }, { 'Idempotency-Key': crypto.randomUUID() });
    week = await C('GET', '/time/week');
  }
  if (week?.period?.open) {
    await C('POST', '/time/entries', { entryKind: 'duration', localDate: week.navigation.today, durationSeconds: 3600, timezone: week.period.zone, description: 'Smoke review entry' }, { 'Idempotency-Key': crypto.randomUUID() });
    week = await C('GET', '/time/week');
    const sub = await C('POST', `/time/periods/${week.period.id}/submit`, { version: week.period.version }, { 'Idempotency-Key': crypto.randomUUID() });
    if (sub?.submission) subjectName = process.env.WH_SMOKE_SUBJECT ?? 'Carol';
  }
}
// Requests step: two pending requests C → A (A is the recipient: approve / reject) and two open
// requests B → C (A manages C: convert / resolve from "Ekibim"). Workhub has no delete; every
// seeded request ends in a terminal state through the UI.
const reqStamp = new Date().toISOString().slice(11, 19);
const reqTitles = { approve: '', reject: '', convert: '', resolve: '' };
if (process.env.WH_C_USER && process.env.WH_C_PASS) {
  for (const k of ['approve', 'reject']) {
    const t = `Masaüstü talebi ${k} ${reqStamp}`;
    const r = await ocsAs(process.env.WH_C_USER, process.env.WH_C_PASS, 'POST', '/requests', { title: t, description: 'smoke' }, { 'Idempotency-Key': crypto.randomUUID() }).catch(() => null);
    if (r?.state === 'pending') reqTitles[k] = t;
  }
}
if (process.env.WH_B_USER && process.env.WH_B_PASS && process.env.WH_C_USER) {
  for (const k of ['convert', 'resolve']) {
    const t = `Ekip talebi ${k} ${reqStamp}`;
    const r = await ocsAs(process.env.WH_B_USER, process.env.WH_B_PASS, 'POST', '/requests', { title: t, description: 'smoke', recipientUid: process.env.WH_C_USER }, { 'Idempotency-Key': crypto.randomUUID() }).catch(() => null);
    if (r?.state === 'open') reqTitles[k] = t;
  }
}
const profile = mkdtempSync(join(tmpdir(), 'workhub-smoke-'));
const child = spawn(electron, ['.', `--user-data-dir=${profile}`, '--ozone-platform=headless', '--disable-gpu', '--no-sandbox'], {
  env: {
    ...process.env,
    WORKHUB_SMOKE_OUT: out,
    WORKHUB_ALLOW_HTTP: '1',
    WORKHUB_TEST_INSECURE_STORE: '1',
    WORKHUB_SMOKE_SERVER: process.env.WH_SERVER,
    WORKHUB_SMOKE_ROOM: process.env.WH_SMOKE_ROOM ?? '',
    WORKHUB_SMOKE_MEMBER: process.env.WH_SMOKE_MEMBER ?? 'Bob',
    // Talk step: the second participant acts over REST while the UI is open (never logged).
    WORKHUB_SMOKE_B_USER: process.env.WH_B_USER ?? '',
    WORKHUB_SMOKE_B_PASS: process.env.WH_B_PASS ?? '',
    WORKHUB_SMOKE_GROUP: process.env.WH_SMOKE_GROUP ?? 'staff',
    WORKHUB_SMOKE_GOAL: goal?.id ? goalTitle : '',
    WORKHUB_SMOKE_SUBJECT: subjectName,
    WORKHUB_SMOKE_REQ_APPROVE: reqTitles.approve,
    WORKHUB_SMOKE_REQ_REJECT: reqTitles.reject,
    WORKHUB_SMOKE_REQ_CONVERT: reqTitles.convert,
    WORKHUB_SMOKE_REQ_RESOLVE: reqTitles.resolve,
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
if (goal?.id) {
  const shares = await ocs('GET', `/objects/goal/${goal.id}/shares`).catch(() => null);
  console.log(`goal shares on server after UI save: ${(shares?.shares ?? []).map((s) => `${s.principalType}:${s.principalId}=${s.role}`).join(', ') || 'none'}`);
  const current = await ocs('GET', `/goals/${goal.id}`).catch(() => null);
  const t = current?.targets?.find((x) => x.type === 'currency');
  console.log(`goal on server after UI: owner=${current?.owner?.uid ?? '—'} callerRole=${current?.role ?? '—'} targets=${(current?.targets ?? []).map((x) => x.type).join('+') || 'none'} current=${t?.current ?? '—'}`);
  await ocs('DELETE', `/goals/${goal.id}`, { version: current?.version ?? goal.version }).catch(() => null);
}
if (process.env.WH_C_USER && process.env.WH_C_PASS) {
  // Leave the subject's week open and without the smoke entry.
  const C = (m, p, b, h) => ocsAs(process.env.WH_C_USER, process.env.WH_C_PASS, m, p, b, h).catch(() => null);
  const week = await C('GET', '/time/week');
  const pending = week?.submissions?.find((s) => s.status === 'pending' && s.revision === week.period.revision);
  if (pending) await C('POST', `/time/submissions/${pending.id}/withdraw`, { version: week.period.version }, { 'Idempotency-Key': crypto.randomUUID() });
  const now = await C('GET', '/time/week');
  for (const e of now?.entries ?? []) if (e.description === 'Smoke review entry') await C('DELETE', `/time/entries/${e.id}`, { version: e.version });
}
if (reqTitles.convert || reqTitles.approve) {
  const mine = await ocsAs(process.env.WH_C_USER, process.env.WH_C_PASS, 'GET', '/requests?scope=mine&state=any').catch(() => null);
  const team = process.env.WH_B_USER ? await ocsAs(process.env.WH_B_USER, process.env.WH_B_PASS, 'GET', '/requests?scope=mine&state=any').catch(() => null) : null;
  const stateOf = (list, t) => list?.items?.find((x) => x.title === t)?.state ?? '—';
  console.log(`requests on server after UI: approve=${stateOf(mine, reqTitles.approve)} reject=${stateOf(mine, reqTitles.reject)} convert=${stateOf(team, reqTitles.convert)} resolve=${stateOf(team, reqTitles.resolve)}`);
}
// CSV files saved by the UI: BOM + header, and never any credential.
const { readdirSync } = await import('node:fs');
for (const f of readdirSync(out).filter((x) => x.endsWith('.csv'))) {
  const text = readFileSync(join(out, f), 'utf8');
  const leaks = [process.env.WH_A_PASS, process.env.WH_B_PASS, process.env.WH_C_PASS].filter((p) => p && text.includes(p)).length + (/Authorization|Basic /.test(text) ? 1 : 0);
  console.log(`csv ${f}: ${text.trim().split('\n').length - 1} rows, bom=${text.startsWith('\uFEFF')}, header=${f.startsWith('workhub-dashboard-') ? JSON.stringify(text.replace('\uFEFF', '').split('\n')[0].slice(0, 40)) : text.replace('\uFEFF', '').startsWith('entry_id,user_uid,')}, credential leaks=${leaks}`);
  if (leaks || !text.startsWith('\uFEFF')) process.exitCode = 1;
}
const result = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'));
for (const s of result.steps) console.log(`${s.ok ? '✔' : '✘'} ${s.step}${s.note ? ` — ${s.note}` : ''}`);
process.exitCode = process.exitCode || (result.steps.every((s) => s.ok) && result.steps.length >= 10 ? 0 : 1);
console.log(`electron exit ${code}; screenshots in ${out}`);
