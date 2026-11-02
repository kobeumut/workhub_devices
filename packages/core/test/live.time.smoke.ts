/**
 * Live smoke for the native Time slice (GENE-50): entry create/edit/delete incl. overlap warning
 * and stale version, period submit/withdraw, period lock, reviewer queue + request changes /
 * approve / reopen, team report and CSV (own + team) with role gates.
 * Not part of `npm test`. Run: `npm run smoke:time -w @workhub-devices/core` with
 *   WH_SERVER, WH_ALLOW_HTTP=1 (local dev only),
 *   WH_A_USER/WH_A_PASS (subject; their Nextcloud manager must be WH_B_USER),
 *   WH_B_USER/WH_B_PASS (manager = reviewer), WH_C_USER/WH_C_PASS (manages nobody).
 * Uses a future week picked per run so earlier runs don't interfere; entries it creates are
 * deleted at the end (the period is left `reopened`). Prints no secrets or entry bodies.
 */
import assert from 'node:assert/strict';
import { OcsClient, OcsError, buildTimeEntry, normalizeServerUrl, periodActions, timeApi, timeEntryFormOf, type ServerBase, type TimeEntry, type TimeWeek } from '../src/index';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const base: ServerBase = normalizeServerUrl(env('WH_SERVER'), { allowInsecureHttp: process.env.WH_ALLOW_HTTP === '1' });
const client = (u: string, p: string) => new OcsClient({ serverBase: base, getCredentials: async () => ({ loginName: u, appPassword: p }) });
const A = client(env('WH_A_USER'), env('WH_A_PASS'));
const B = client(env('WH_B_USER'), env('WH_B_PASS'));
const C = client(env('WH_C_USER'), env('WH_C_PASS'));
const results: Array<[string, string]> = [];
const step = async (name: string, fn: () => Promise<string | void>) => {
  try {
    const note = await fn();
    results.push([name, `PASS${note ? ` — ${note}` : ''}`]);
  } catch (e) {
    results.push([name, `FAIL — ${e instanceof OcsError ? `${e.kind} ${e.status ?? ''} ${e.errorCode ?? ''}` : (e as Error).message}`]);
  }
};
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof OcsError ? `${e.kind}:${e.errorCode ?? ''}` : 'error'));
const key = () => crypto.randomUUID();
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

async function main() {
  let week!: TimeWeek;
  let day = '';
  let zone = '';
  const ids: number[] = [];
  const reload = async () => (week = await timeApi.week(A, day));
  const mine = (id: number) => week.entries.find((e) => e.id === id) as TimeEntry;

  await step('setup: future week, clean state', async () => {
    const now = await timeApi.week(A);
    zone = now.period.zone;
    // 20–69 weeks ahead, different per run.
    day = addDays(now.navigation.today, 7 * (20 + (Math.floor(Date.now() / 60000) % 50)));
    await reload();
    // A previous failed run may have left the week locked; unlock it so the run is repeatable.
    const w = periodActions(week).withdrawable;
    if (w) await timeApi.withdraw(A, w.id, week.period.version, key());
    await reload();
    const approved = week.period.state === 'approved' ? week.submissions.find((x) => x.status === 'approved') : undefined;
    if (approved) await timeApi.decide(B, approved.id, 'reopen', week.period.version, 'smoke cleanup', key());
    await reload();
    for (const e of week.entries) await timeApi.deleteEntry(A, e.id, e.version);
    await reload();
    assert.equal(week.period.open, true);
    return `period ${week.period.localStartDate}…${week.period.localEndDate} ${week.period.state}, zone=${zone}, reviewerConfigured=${week.reviewerConfigured}`;
  });

  await step('create: range + duration through the form builder; overlap → warning (policy warn)', async () => {
    const opts = { maxEntrySeconds: week.policy.maxEntrySeconds, allowTaskless: week.policy.allowTaskless };
    const r1 = buildTimeEntry({ kind: 'range', date: week.period.localStartDate, start: '09:00', end: '10:30', hours: '', description: 'GENE-50 smoke range', billable: true }, zone, opts);
    assert.ok('create' in r1);
    const e1 = await timeApi.createEntry(A, r1.create, key());
    ids.push(e1!.entries[0]!.id);
    const r2 = buildTimeEntry({ kind: 'duration', date: addDays(week.period.localStartDate, 1), start: '', end: '', hours: '1,5', description: 'GENE-50 smoke duration', billable: false }, zone, opts);
    assert.ok('create' in r2);
    ids.push((await timeApi.createEntry(A, r2.create, key()))!.entries[0]!.id);
    const r3 = buildTimeEntry({ kind: 'range', date: week.period.localStartDate, start: '10:00', end: '11:00', hours: '', description: 'GENE-50 overlap', billable: false }, zone, opts);
    assert.ok('create' in r3);
    const e3 = await timeApi.createEntry(A, r3.create, key());
    ids.push(e3!.entries[0]!.id);
    await reload();
    assert.equal(week.totals.totalSec, 5400 + 5400 + 3600);
    assert.equal(week.totals.billableSec, 5400);
    assert.equal(mine(ids[0]!).localDate, week.period.localStartDate, 'local wall clock → right day');
    return `entries=${week.entries.length}, overlap warnings=${e3!.warnings.map((w) => w.code).join(',') || 'none (policy allow)'}`;
  });

  await step('edit: minimal PATCH with version; stale version → 409 VERSION_CONFLICT', async () => {
    const e = mine(ids[0]!);
    const r = buildTimeEntry({ ...timeEntryFormOf(e, zone, ''), end: '11:00', description: 'GENE-50 smoke range (edited)' }, zone, { maxEntrySeconds: 86400, allowTaskless: true }, e);
    assert.ok('patch' in r);
    await timeApi.updateEntry(A, e.id, r.patch);
    await reload();
    assert.equal(mine(e.id).durationSec, 7200);
    assert.equal(mine(e.id).version, e.version + 1);
    assert.equal(await code(timeApi.updateEntry(A, e.id, { version: e.version, billable: false })), 'conflict:VERSION_CONFLICT');
    assert.equal(await code(timeApi.updateEntry(A, e.id, { version: mine(e.id).version, localDate: day, durationSeconds: 60 })), 'client:KIND_IMMUTABLE');
    return `patched=${Object.keys(r.patch).join(',')}`;
  });

  await step('delete: the overlapping entry; foreign user cannot see it (404)', async () => {
    const e = mine(ids[2]!);
    assert.equal(await code(timeApi.deleteEntry(B, e.id, e.version)), 'not_found:RESOURCE_NOT_FOUND');
    await timeApi.deleteEntry(A, e.id, e.version);
    ids.pop();
    await reload();
    assert.equal(week.entries.length, 2);
  });

  await step('submit → locked (entries read-only, PERIOD_LOCKED) → withdraw → open', async () => {
    const s = await timeApi.submit(A, week.period.id, week.period.version, key());
    assert.equal(s!.period.state, 'submitted');
    await reload();
    assert.ok(week.entries.every((e) => e.locked), 'server marks entries locked');
    const e = mine(ids[0]!);
    assert.equal(await code(timeApi.updateEntry(A, e.id, { version: e.version, billable: false })), 'conflict:PERIOD_LOCKED');
    assert.equal(await code(timeApi.deleteEntry(A, e.id, e.version)), 'conflict:PERIOD_LOCKED');
    const w = periodActions(week).withdrawable;
    assert.ok(w);
    const back = await timeApi.withdraw(A, w.id, week.period.version, key());
    assert.equal(back!.period.state, 'draft');
    await reload();
    assert.equal(week.period.open, true);
    return `submission ${s!.submission.id} total=${s!.submission.totalSec}s`;
  });

  let subId = 0;
  await step('reviewer gate: owner cannot decide (SELF_APPROVAL); C has no team / queue', async () => {
    const s = await timeApi.submit(A, week.period.id, week.period.version, key());
    subId = s!.submission.id;
    await reload();
    assert.equal(await code(timeApi.decide(A, subId, 'approve', week.period.version, null, key())), 'forbidden:SELF_APPROVAL');
    assert.equal(await code(timeApi.decide(C, subId, 'approve', week.period.version, null, key())), 'not_found:RESOURCE_NOT_FOUND');
    assert.equal(await code(timeApi.team(C)), 'forbidden:TEAM_REPORT_FORBIDDEN');
    assert.deepEqual(await timeApi.reviews(C, 'pending'), []);
  });

  await step('reviewer: queue → request changes (reason required) → owner edits + resubmits → approve', async () => {
    const queue = await timeApi.reviews(B, 'pending');
    const item = queue.find((i) => i.submission.id === subId);
    assert.ok(item, 'submission is in the manager queue');
    assert.equal(item.canReview, true);
    assert.equal(item.entries.length, 2);
    assert.equal(await code(timeApi.decide(B, subId, 'request_changes', item.period.version, null, key())), 'client:FIELD_REQUIRED');
    const rc = await timeApi.decide(B, subId, 'request_changes', item.period.version, 'Lütfen açıklamaları netleştir', key());
    assert.equal(rc!.period.state, 'changes_requested');
    await reload();
    assert.equal(week.period.open, true, 'changes_requested is open for edits');
    const e = mine(ids[1]!);
    await timeApi.updateEntry(A, e.id, { version: e.version, description: 'GENE-50 smoke duration (fixed)' });
    await reload();
    const s2 = await timeApi.submit(A, week.period.id, week.period.version, key());
    subId = s2!.submission.id;
    const queue2 = await timeApi.reviews(B, 'pending');
    const item2 = queue2.find((i) => i.submission.id === subId)!;
    const ok = await timeApi.decide(B, subId, 'approve', item2.period.version, null, key());
    assert.equal(ok!.period.state, 'approved');
    assert.ok((await timeApi.reviews(B, 'approved')).some((i) => i.submission.id === subId));
    return `revision=${ok!.submission.revision}, reviews=${ok!.submission.reviews.map((r) => r.action).join('→')}`;
  });

  await step('reopen: reason required; approved → reopened (open again)', async () => {
    await reload();
    assert.equal(await code(timeApi.decide(B, subId, 'reopen', week.period.version, null, key())), 'client:FIELD_REQUIRED');
    const r = await timeApi.decide(B, subId, 'reopen', week.period.version, 'Düzeltme gerekiyor', key());
    assert.equal(r!.period.state, 'reopened');
    await reload();
    assert.equal(week.period.open, true);
  });

  await step('team report: manager sees subject totals; non-manager C gets 403; nobody reports on themselves', async () => {
    const from = week.period.localStartDate;
    const to = week.period.localEndDate;
    const t = await timeApi.team(B, from, to);
    const u = t.users.find((x) => x.uid === env('WH_A_USER'));
    assert.ok(u);
    assert.equal(u.totalSec, 7200 + 5400);
    assert.equal(await code(timeApi.team(C, from, to)), 'forbidden:TEAM_REPORT_FORBIDDEN');
    // A may manage someone else, but never appears in their own team report.
    const own = await timeApi.team(A, from, to).catch(() => null);
    assert.ok(!own || !own.users.some((x) => x.uid === env('WH_A_USER')));
    return `users=${t.users.length}, A days=${u.days.length}, cards=${u.cards.length}`;
  });

  await step('CSV: own + team (BOM, header, rows), no credentials in the file, non-manager team → 403', async () => {
    const from = week.period.localStartDate;
    const to = week.period.localEndDate;
    const own = await timeApi.csv(A, 'own', from, to);
    assert.ok(own.csv.startsWith('﻿entry_id,user_uid,'));
    const team = await timeApi.csv(B, 'team', from, to);
    const rows = team.csv.trim().split('\n');
    assert.ok(rows.length >= 3, 'header + 2 slices');
    for (const secret of [env('WH_A_PASS'), env('WH_B_PASS')]) {
      assert.ok(!own.csv.includes(secret) && !team.csv.includes(secret), 'no app password in CSV');
    }
    assert.ok(!/Authorization|Basic /.test(team.csv));
    assert.equal(await code(timeApi.csv(C, 'team', from, to)), 'forbidden:TEAM_REPORT_FORBIDDEN');
    return `${own.filename}: ${own.csv.trim().split('\n').length - 1} rows; ${team.filename}: ${rows.length - 1} rows`;
  });

  await step('cleanup: delete created entries', async () => {
    await reload();
    for (const e of week.entries) await timeApi.deleteEntry(A, e.id, e.version);
    await reload();
    assert.equal(week.entries.length, 0);
  });

  for (const [name, r] of results) console.log(`${r.startsWith('PASS') ? '✔' : '✘'} ${name}: ${r}`);
  const failed = results.filter(([, r]) => !r.startsWith('PASS')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

void main();
