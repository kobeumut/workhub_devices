import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectBackend, dispatchWire, isValidTimeEntryInput, isValidTimeEntryPatch, type PlainStore } from '../src/backend';
import type { SecretStore } from '../src/accounts';
import { OcsClient, OcsError } from '../src/ocs';
import { buildTimeEntry, entryEditable, periodActions, timeApi, timeEntryFormOf, utcToZoned, zonedToUtc, type TimeEntry, type TimeWeek } from '../src/workhub';
import { headerOf, json, ocs, scriptedFetch, type Call } from './helpers';

class Mem implements SecretStore, PlainStore {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
  async deletePrefix(p: string) { for (const k of [...this.m.keys()]) if (k.startsWith(p)) this.m.delete(k); }
}

const KEY = '0f8b6c1e-3a52-4c9e-9a51-2b1c0d7e8f90';
const IST = 'Europe/Istanbul';
const BAD = { ok: false, error: { kind: 'client', message: 'invalid arguments' } };
const bootstrap = (time: boolean, reviewer: boolean) => json(200, ocs({ apiVersion: '1', modules: { time }, permissions: { canViewTeamReport: reviewer } }));

async function loggedIn(...rest: Array<Response | ((c: Call) => Response)>) {
  const f = scriptedFetch(
    json(200, { login: 'https://ex.com/index.php/login/v2/flow/x', poll: { token: 't', endpoint: 'https://ex.com/index.php/login/v2/poll' } }),
    json(200, { server: 'https://ex.com', loginName: 'ali', appPassword: 'secret-app-pw' }),
    ...rest,
  );
  const b = createDirectBackend({ secrets: new Mem(), plain: new Mem(), fetch: f });
  const { flowId } = await b.beginLogin('ex.com');
  const acc = await b.completeLogin(flowId);
  return { b, f, id: acc.id };
}

const entry = (over: Partial<TimeEntry> = {}): TimeEntry => ({
  id: 7, kind: 'range', cardId: null, card: null, startUtc: '2026-11-02T06:00:00Z', endUtc: '2026-11-02T07:30:00Z', localDate: '2026-11-02',
  durationSec: 5400, zone: IST, description: 'Analiz', billable: false, origin: 'manual', periodId: 2, version: 3, locked: false, slices: [], ...over,
});
const opts = { maxEntrySeconds: 86400, allowTaskless: true };

test('zone conversion: Istanbul wall clock ↔ UTC, DST zone round-trips', () => {
  assert.equal(zonedToUtc('2026-11-02', '09:00', IST), '2026-11-02T06:00:00Z');
  assert.deepEqual(utcToZoned('2026-11-02T06:00:00Z', IST), { date: '2026-11-02', time: '09:00' });
  // Europe/Berlin: CET in winter, CEST in summer.
  assert.equal(zonedToUtc('2026-01-15', '09:00', 'Europe/Berlin'), '2026-01-15T08:00:00Z');
  assert.equal(zonedToUtc('2026-07-15', '09:00', 'Europe/Berlin'), '2026-07-15T07:00:00Z');
});

test('entry form → create body: range, overnight, duration, validation', () => {
  const base = { kind: 'range' as const, date: '2026-11-02', start: '09:00', end: '10:30', hours: '', description: ' Analiz ', billable: true };
  assert.deepEqual(buildTimeEntry(base, IST, opts), {
    create: { kind: 'range', startUtc: '2026-11-02T06:00:00Z', endUtc: '2026-11-02T07:30:00Z', timezone: IST, description: 'Analiz', billable: true },
  });
  const night = buildTimeEntry({ ...base, start: '23:00', end: '01:00' }, IST, opts);
  assert.ok('create' in night && night.create.kind === 'range' && night.create.endUtc === '2026-11-02T22:00:00Z');
  assert.deepEqual(buildTimeEntry({ ...base, kind: 'duration', hours: '1:30' }, IST, opts), {
    create: { kind: 'duration', localDate: '2026-11-02', durationSeconds: 5400, timezone: IST, description: 'Analiz', billable: true },
  });
  const dur = buildTimeEntry({ ...base, kind: 'duration', hours: '2,5' }, IST, opts);
  assert.ok('create' in dur && dur.create.kind === 'duration' && dur.create.durationSeconds === 9000);
  assert.deepEqual(buildTimeEntry({ ...base, description: '' }, IST, opts), { error: 'description_required' });
  assert.ok('create' in buildTimeEntry({ ...base, description: '' }, IST, { ...opts, cardId: 5 }), 'a card makes the description optional');
  assert.deepEqual(buildTimeEntry({ ...base, date: '2026-02-30' }, IST, opts), { error: 'date_invalid' });
  assert.deepEqual(buildTimeEntry({ ...base, start: '9:00' }, IST, opts), { error: 'time_invalid' });
  assert.deepEqual(buildTimeEntry({ ...base, kind: 'duration', hours: 'abc' }, IST, opts), { error: 'duration_invalid' });
  assert.deepEqual(buildTimeEntry({ ...base, kind: 'duration', hours: '30' }, IST, opts), { error: 'too_long' });
});

test('entry form → minimal PATCH with version; unchanged form is version-only', () => {
  const e = entry();
  const form = timeEntryFormOf(e, IST, '2026-11-02');
  assert.deepEqual(form, { kind: 'range', date: '2026-11-02', start: '09:00', end: '10:30', hours: '', description: 'Analiz', billable: false });
  assert.deepEqual(buildTimeEntry(form, IST, opts, e), { patch: { version: 3 } });
  assert.deepEqual(buildTimeEntry({ ...form, end: '11:00', billable: true }, IST, opts, e), { patch: { version: 3, endUtc: '2026-11-02T08:00:00Z', billable: true } });
  const d = entry({ kind: 'duration', startUtc: null, endUtc: null, durationSec: 3600 });
  assert.deepEqual(buildTimeEntry({ ...timeEntryFormOf(d, IST, ''), hours: '2', description: '' }, IST, opts, d), { error: 'description_required' });
  assert.deepEqual(buildTimeEntry({ ...timeEntryFormOf(d, IST, ''), hours: '2' }, IST, opts, d), { patch: { version: 3, durationSeconds: 7200 } });
});

test('locks and period actions come from server state only', () => {
  const period = { id: 2, userUid: 'ali', localStartDate: '2026-11-02', localEndDate: '2026-11-08', zone: IST, state: 'draft' as const, open: true, revision: 0, version: 1 };
  const w = { period, submissions: [] } as Pick<TimeWeek, 'period' | 'submissions'>;
  assert.equal(entryEditable(w, entry()), true);
  assert.equal(entryEditable(w, entry({ locked: true })), false);
  assert.deepEqual(periodActions(w), { canEdit: true, canSubmit: true, withdrawable: null });
  const sub = { id: 9, periodId: 2, revision: 1, status: 'pending' as const, submittedBy: 'ali', submittedAt: '', totalSec: 0, billableSec: 0, reviews: [] };
  const submitted = { period: { ...period, state: 'submitted' as const, open: false, revision: 1, version: 2 }, submissions: [sub] };
  assert.equal(entryEditable(submitted, entry()), false);
  assert.deepEqual(periodActions(submitted), { canEdit: false, canSubmit: false, withdrawable: sub });
  const approved = { ...submitted, period: { ...submitted.period, state: 'approved' as const }, submissions: [{ ...sub, status: 'approved' as const }] };
  assert.equal(periodActions(approved).withdrawable, null);
});

test('time API: paths, bodies, Idempotency-Key, DELETE carries version', async () => {
  const f = scriptedFetch(
    json(201, ocs({ entries: [], warnings: [] })),
    json(200, ocs({ entries: [], warnings: [] })),
    json(200, ocs({ deleted: 7 })),
    json(200, ocs({ period: {}, submission: {} })),
    json(200, ocs({ period: {}, submission: {} })),
    json(200, ocs({ period: {}, submission: {} })),
    json(200, ocs({ period: {}, submission: {} })),
  );
  const c = new OcsClient({ serverBase: 'https://ex.com' as never, getCredentials: async () => ({ loginName: 'u', appPassword: 'p' }), fetch: f });
  await timeApi.createEntry(c, { kind: 'duration', localDate: '2026-11-02', durationSeconds: 60, timezone: IST, description: 'x' }, KEY);
  await timeApi.updateEntry(c, 7, { version: 3, billable: true });
  await timeApi.deleteEntry(c, 7, 3);
  await timeApi.submit(c, 2, 1, KEY);
  await timeApi.withdraw(c, 9, 2, KEY);
  await timeApi.decide(c, 9, 'request_changes', 2, 'Eksik', KEY);
  await timeApi.decide(c, 9, 'approve', 2, null, KEY);
  const W = 'https://ex.com/ocs/v2.php/apps/workhub/api/v1/time';
  assert.deepEqual(f.calls.map((x) => `${x.init.method} ${x.url.replace(W, '').replace('?format=json', '')}`), [
    'POST /entries', 'PATCH /entries/7', 'DELETE /entries/7', 'POST /periods/2/submit', 'POST /submissions/9/withdraw', 'POST /submissions/9/request-changes', 'POST /submissions/9/approve',
  ]);
  assert.deepEqual(JSON.parse(String(f.calls[0]!.init.body)), { entryKind: 'duration', localDate: '2026-11-02', durationSeconds: 60, timezone: IST, description: 'x' });
  assert.equal(headerOf(f.calls[0], 'Idempotency-Key'), KEY);
  assert.deepEqual(JSON.parse(String(f.calls[2]!.init.body)), { version: 3 });
  assert.deepEqual(JSON.parse(String(f.calls[5]!.init.body)), { version: 2, reason: 'Eksik' });
  assert.deepEqual(JSON.parse(String(f.calls[6]!.init.body)), { version: 2 });
  await assert.rejects(timeApi.deleteEntry(c, -1, 0), (e: unknown) => e instanceof OcsError && e.kind === 'client');
});

test('CSV download: plain route, own server only, no format=json, JSON error → OcsError, body untouched', async () => {
  const csv = '﻿entry_id,user_uid\n1,ali\n';
  const f = scriptedFetch(
    new Response(csv, { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8' } }),
    json(403, { error: 'TEAM_REPORT_FORBIDDEN', message: 'Only managers can view the team report.' }),
    new Response('', { status: 302, headers: { Location: 'https://evil.example/' } }),
  );
  const c = new OcsClient({ serverBase: 'https://ex.com' as never, getCredentials: async () => ({ loginName: 'u', appPassword: 'p' }), fetch: f });
  const r = await timeApi.csv(c, 'own', '2026-10-01', '2026-11-02');
  assert.equal(r.filename, 'workhub-time-own-2026-10-01_2026-11-02.csv');
  assert.equal(r.csv, csv);
  assert.equal(f.calls[0]!.url, 'https://ex.com/index.php/apps/workhub/csv/time?scope=own&from=2026-10-01&to=2026-11-02');
  assert.equal(f.calls[0]!.init.redirect, 'manual');
  assert.equal(f.calls[0]!.init.credentials, 'omit');
  await assert.rejects(timeApi.csv(c, 'team', '2026-10-01', '2026-11-02'), (e: unknown) => e instanceof OcsError && e.kind === 'forbidden' && e.errorCode === 'TEAM_REPORT_FORBIDDEN');
  await assert.rejects(timeApi.csv(c, 'own', '2026-10-01', '2026-11-02'), (e: unknown) => e instanceof OcsError && e.kind === 'redirect');
});

test('backend gate: time off → 403 without calling the API; reviewer calls need canViewTeamReport', async () => {
  {
    const { b, f, id } = await loggedIn(bootstrap(false, true));
    await assert.rejects(b.timeWeek(id), (e: unknown) => e instanceof OcsError && e.errorCode === 'TIME_DISABLED');
    assert.equal(f.calls.length, 3, 'only login + bootstrap');
  }
  {
    const { b, f, id } = await loggedIn(bootstrap(true, false), json(200, ocs({ period: {} })));
    await assert.rejects(b.timeReviews(id, 'pending'), (e: unknown) => e instanceof OcsError && e.errorCode === 'TEAM_REPORT_FORBIDDEN');
    await assert.rejects(b.timeDecide(id, 9, 'approve', 1, null, KEY), (e: unknown) => e instanceof OcsError && e.errorCode === 'TEAM_REPORT_FORBIDDEN');
    await assert.rejects(b.timeTeam(id, '2026-11-01', '2026-11-02'), (e: unknown) => e instanceof OcsError && e.errorCode === 'TEAM_REPORT_FORBIDDEN');
    await assert.rejects(b.timeCsv(id, 'team', '2026-11-01', '2026-11-02'), (e: unknown) => e instanceof OcsError && e.errorCode === 'TEAM_REPORT_FORBIDDEN');
    await b.timeWeek(id); // own data still allowed; bootstrap is cached (one fetch)
    assert.equal(f.calls.filter((x) => x.url.includes('/capabilities')).length, 1);
  }
  {
    const csv = 'entry_id\n1\n';
    const { b, f, id } = await loggedIn(bootstrap(true, true), new Response(csv, { status: 200, headers: { 'Content-Type': 'text/csv' } }));
    const r = await b.timeCsv(id, 'team', '2026-11-01', '2026-11-02');
    assert.equal(r.csv, `\uFEFF${csv}`);
    assert.ok(!r.csv.includes('secret-app-pw') && !r.filename.includes('secret-app-pw'));
    assert.ok(!f.calls.at(-1)!.url.includes('secret-app-pw'), 'credentials only in the Authorization header');
  }
});

test('IPC validation: time entry bodies, patches, decisions and ranges', async () => {
  const b = createDirectBackend({ secrets: new Mem(), plain: new Mem(), fetch: scriptedFetch() });
  const range = { kind: 'range', startUtc: '2026-11-02T06:00:00Z', endUtc: '2026-11-02T07:00:00Z', timezone: IST };
  assert.equal(isValidTimeEntryInput(range), true);
  assert.equal(isValidTimeEntryInput({ ...range, description: null, billable: true, cardId: 4 }), true);
  assert.equal(isValidTimeEntryInput({ ...range, userUid: 'other' }), false, 'unknown field');
  assert.equal(isValidTimeEntryInput({ ...range, localDate: '2026-11-02' }), false, 'duration field on range');
  assert.equal(isValidTimeEntryInput({ ...range, startUtc: '2026-11-02 06:00' }), false);
  assert.equal(isValidTimeEntryInput({ kind: 'duration', localDate: '2026-11-02', durationSeconds: 0, timezone: IST }), false);
  assert.equal(isValidTimeEntryInput({ kind: 'duration', localDate: '2026-11-02', durationSeconds: 60, timezone: '../etc' }), false);
  assert.equal(isValidTimeEntryPatch({ version: 1 }), true);
  assert.equal(isValidTimeEntryPatch({ billable: true }), false, 'version is required');
  assert.equal(isValidTimeEntryPatch({ version: 1, startUtc: '2026-11-02T06:00:00Z', durationSeconds: 60 }), false, 'kind mix');
  assert.deepEqual(await dispatchWire(b, 'timeEntryCreate', ['acc', range, 'not a key!']), BAD);
  assert.deepEqual(await dispatchWire(b, 'timeEntryDelete', ['acc', 7]), BAD);
  assert.deepEqual(await dispatchWire(b, 'timeDecide', ['acc', 9, 'request_changes', 1, '  ', KEY]), BAD, 'reason required');
  assert.deepEqual(await dispatchWire(b, 'timeDecide', ['acc', 9, 'delete', 1, null, KEY]), BAD);
  assert.deepEqual(await dispatchWire(b, 'timeReviews', ['acc', 'all']), BAD);
  assert.deepEqual(await dispatchWire(b, 'timeTeam', ['acc', '2026-11-02', '2026-11-01']), BAD, 'from after to');
  assert.deepEqual(await dispatchWire(b, 'timeTeam', ['acc', '2026-01-01', '2026-11-01']), BAD, 'over 93 days');
  assert.deepEqual(await dispatchWire(b, 'timeCsv', ['acc', 'all', '2026-11-01', '2026-11-02']), BAD);
  // Valid shape reaches the backend (unknown account → unauthorized, not "invalid arguments").
  const ok = await dispatchWire(b, 'timeCsv', ['acc', 'own', '2026-01-01', '2026-11-02']);
  assert.equal(ok.ok === false && ok.error.kind, 'unauthorized');
});

test('task link: create with a task, change / remove the link on edit, allowTaskless=false policy', () => {
  const base = { kind: 'range' as const, date: '2026-11-02', start: '09:00', end: '10:30', hours: '', description: '', billable: false };
  const created = buildTimeEntry(base, IST, { ...opts, cardId: 50 });
  assert.ok('create' in created && created.create.cardId === 50 && created.create.description === null);
  assert.deepEqual(buildTimeEntry(base, IST, { ...opts, allowTaskless: false }), { error: 'task_required' });
  const e = entry();
  const form = timeEntryFormOf(e, IST, '');
  assert.deepEqual(buildTimeEntry(form, IST, opts, e), { patch: { version: 3 } });
  assert.deepEqual(buildTimeEntry(form, IST, { ...opts, cardId: 51 }, e), { patch: { version: 3, cardId: 51 } });
  const linked = entry({ cardId: 51 });
  assert.deepEqual(buildTimeEntry(form, IST, { ...opts, cardId: null }, linked), { patch: { version: 3, cardId: null } });
  // Removing the task needs a description (server: DESCRIPTION_REQUIRED) and is refused under allowTaskless=false.
  assert.deepEqual(buildTimeEntry({ ...form, description: '' }, IST, { ...opts, cardId: null }, linked), { error: 'description_required' });
  assert.deepEqual(buildTimeEntry(form, IST, { ...opts, allowTaskless: false, cardId: null }, linked), { error: 'task_required' });
  // An existing taskless entry stays editable under the stricter policy.
  assert.deepEqual(buildTimeEntry({ ...form, billable: true }, IST, { ...opts, allowTaskless: false }, e), { patch: { version: 3, billable: true } });
});
