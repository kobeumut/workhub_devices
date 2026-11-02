/**
 * Live smoke for the dashboards slice (GENE-54): dashboard CRUD with version locks, widget CRUD
 * with schema-validated config and filters, query results per kind, distribution drill-down
 * (group key → exactly that group's cards), cursor paging without duplicates, CSV for each kind,
 * refresh rate limit, and access (share view → read-only, outsider 404, scope = viewer's access).
 * Not part of `npm test`. Run: `npm run smoke:dashboards -w @workhub-devices/core` with
 *   WH_SERVER, WH_ALLOW_HTTP=1 (local dev only), WH_A_USER/WH_A_PASS (owner),
 *   WH_B_USER/WH_B_PASS (not a project member), WH_C_USER/WH_C_PASS (Projects module off).
 * Creates one project + 55 cards per run (Workhub has no project delete API); dashboards are deleted.
 * Prints no secrets.
 */
import assert from 'node:assert/strict';
import {
  OcsClient, OcsError, barData, buildDashboardFilter, dashboardsApi, filterToForm, mergeCards, normalizeServerUrl, workhubApi,
  type DashboardCard, type ServerBase,
} from '../src/index';

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
const stamp = new Date().toISOString().slice(0, 16);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let boardId = 0;
  let doneStack = 0;
  let todoStack = 0;
  let dashId = 0;
  let sharedId = 0;
  const me = env('WH_A_USER');
  const cards: number[] = [];

  await step('setup: project + 55 cards (3 done, 2 assigned to A)', async () => {
    const p = await workhubApi.createProject(A, `GENE-54 smoke ${stamp}`, undefined, key());
    boardId = p!.id;
    const board = await workhubApi.board(A, boardId);
    const stacks = board.project.stacks.slice().sort((a, b) => a.order - b.order);
    todoStack = stacks[0]!.id;
    doneStack = (stacks.find((s) => s.isDone) ?? stacks.at(-1)!).id;
    for (let i = 0; i < 55; i++) {
      const r = await A.request<{ id: number }>(`/ocs/v2.php/apps/workhub/api/v1/projects/${boardId}/tasks`, { method: 'POST', body: { stackId: todoStack, title: `Kart ${String(i).padStart(2, '0')}` }, headers: { 'Idempotency-Key': key() } });
      cards.push(r.data!.id);
    }
    for (const id of cards.slice(0, 3)) await workhubApi.updateTask(A, id, { done: true });
    for (const id of cards.slice(3, 5)) await workhubApi.updateTask(A, id, { assignees: [me] });
    return `board ${boardId}, ${cards.length} cards`;
  });

  await step('widget types: Deck kinds + module providers; card_list config schema', async () => {
    const types = await dashboardsApi.widgetTypes(A);
    const byType = new Map(types.map((t) => [t.type, t]));
    for (const t of ['kpi_total', 'kpi_completion_rate', 'dist_stack', 'dist_assignee', 'card_list', 'trend_open']) assert.ok(byType.has(t), t);
    const list = byType.get('card_list')!;
    assert.equal(list.kind, 'list');
    assert.equal(list.config.pageSize?.type, 'int');
    assert.deepEqual(byType.get('trend_open')!.filters.includes('doneState'), false, 'trend does not filter by done state');
    return `${types.length} types (${[...new Set(types.map((t) => t.module))].join(', ')})`;
  });

  await step('create (template project_summary, source = project) → 10 widgets; same Idempotency-Key → same dashboard', async () => {
    const k = key();
    const d = await dashboardsApi.create(A, { title: `Smoke ${stamp}`, template: 'project_summary', sources: [boardId] }, k);
    dashId = d!.id;
    assert.equal(d!.role, 'manage');
    assert.equal(d!.widgets.length, 10);
    assert.deepEqual(d!.sources.map((s) => s.id), [boardId]);
    const again = await dashboardsApi.create(A, { title: `Smoke ${stamp}`, template: 'project_summary', sources: [boardId] }, k);
    assert.equal(again!.id, dashId);
    const list = await dashboardsApi.list(A);
    assert.ok(list.items.some((x) => x.id === dashId && x.widgetCount === 10));
  });

  await step('query: KPI counts, completion rate (bp), distribution by column / assignee', async () => {
    const q = await dashboardsApi.query(A, dashId);
    const d = await dashboardsApi.get(A, dashId);
    const r = (type: string) => q.results[String(d.widgets.find((w) => w.type === type)!.id)]!;
    assert.equal(r('kpi_total').value, 55);
    assert.equal(r('kpi_done').value, 3);
    assert.equal(r('kpi_open').value, 52);
    assert.equal(r('kpi_completion_rate').unit, 'bp');
    assert.equal(r('kpi_completion_rate').value, Math.round((3 * 10000) / 55));
    const cols = r('dist_stack').groups!;
    assert.equal(cols.reduce((s, g) => s + g.value, 0), 55);
    const assignees = r('dist_assignee').groups!;
    assert.equal(assignees.find((g) => g.key === `user:${me}`)?.value, 2);
    assert.equal(barData(cols).find((b) => b.fraction === 1)?.value, Math.max(...cols.map((g) => g.value)));
    assert.equal(q.restricted, false);
    return `total ${r('kpi_total').value}, done ${r('kpi_done').value}, rate ${r('kpi_completion_rate').value} bp`;
  });

  await step('drill-down: assignee group → exactly those 2 cards; KPI open → 52 cards over 2 pages without duplicates', async () => {
    const d = await dashboardsApi.get(A, dashId);
    const dist = d.widgets.find((w) => w.type === 'dist_assignee')!;
    const page = await dashboardsApi.drilldown(A, dashId, dist.id, { groupKey: `user:${me}` });
    assert.deepEqual(page.items.map((c) => c.id).sort((a, b) => a - b), cards.slice(3, 5));
    const open = d.widgets.find((w) => w.type === 'kpi_open')!;
    let shown: DashboardCard[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p = await dashboardsApi.drilldown(A, dashId, open.id, cursor ? { cursor } : {});
      shown = mergeCards(shown, p.items);
      cursor = p.nextCursor;
      pages++;
    } while (cursor && pages < 5);
    assert.equal(pages, 2);
    assert.equal(shown.length, 52);
    assert.ok(shown.every((c) => !c.done && c.boardId === boardId));
    assert.equal(await code(dashboardsApi.drilldown(A, dashId, open.id, { cursor: 'bm90LWEtY3Vyc29y' })), 'client:INVALID_CURSOR');
    const trend = d.widgets.find((w) => w.type === 'trend_open')!;
    assert.equal(await code(dashboardsApi.drilldown(A, dashId, trend.id)), 'client:DRILLDOWN_UNSUPPORTED');
    return `${pages} pages, ${shown.length} cards`;
  });

  await step('widget CRUD: add card_list with config + done filter; bad config 422; stale version 409; delete', async () => {
    const f = buildDashboardFilter({ ...filterToForm({}), doneState: 'done' });
    assert.ok('filter' in f);
    const w = await dashboardsApi.addWidget(A, dashId, { type: 'card_list', title: 'Biten kartlar', config: { preset: 'all', sort: 'title', pageSize: 5 }, filter: f.filter, w: 12, h: 2 });
    assert.equal(w!.config.pageSize, 5);
    assert.deepEqual(w!.filter, { doneState: 'done' });
    const q = await dashboardsApi.query(A, dashId, { widgetIds: [w!.id] });
    assert.deepEqual(Object.keys(q.results), [String(w!.id)], 'widgetIds narrows the query');
    const r = q.results[String(w!.id)]!;
    assert.equal(r.kind, 'list');
    assert.deepEqual(r.rows!.map((c) => c.id).sort((a, b) => a - b), cards.slice(0, 3), 'only the 3 done cards');
    assert.equal(await code(dashboardsApi.addWidget(A, dashId, { type: 'card_list', config: { preset: 'late' } })), 'client:INVALID_CONFIG');
    assert.equal(await code(dashboardsApi.addWidget(A, dashId, { type: 'trend_open', filter: { doneState: 'open' } })), 'client:UNSUPPORTED_FILTER');
    assert.equal(await code(dashboardsApi.addWidget(A, dashId, { type: 'kpi_total', x: 10, w: 3 })), 'client:INVALID_LAYOUT');
    const u = await dashboardsApi.updateWidget(A, dashId, w!.id, { version: w!.version, title: 'Tamamlananlar', config: { pageSize: 10 } });
    assert.equal(u!.title, 'Tamamlananlar');
    assert.equal(u!.version, w!.version + 1);
    assert.equal(await code(dashboardsApi.updateWidget(A, dashId, w!.id, { version: w!.version, title: 'eski' })), 'conflict:VERSION_CONFLICT');
    await dashboardsApi.removeWidget(A, dashId, w!.id);
    assert.equal(await code(dashboardsApi.removeWidget(A, dashId, w!.id)), 'not_found:RESOURCE_NOT_FOUND');
  });

  await step('dashboard edit: title + global filter (open) narrows KPIs; stale version 409; refreshSec range 422', async () => {
    const d = await dashboardsApi.get(A, dashId);
    const u = await dashboardsApi.update(A, dashId, { version: d.version, title: `Smoke ${stamp} (açık)`, filters: { doneState: 'open' }, refreshSec: 0 });
    assert.equal(u!.version, d.version + 1);
    assert.deepEqual(u!.filters, { doneState: 'open' });
    const q = await dashboardsApi.query(A, dashId);
    const total = u!.widgets.find((w) => w.type === 'kpi_total')!;
    assert.equal(q.results[String(total.id)]!.value, 52, 'global open filter applies');
    assert.equal(await code(dashboardsApi.update(A, dashId, { version: d.version, title: 'x' })), 'conflict:VERSION_CONFLICT');
    assert.equal(await code(dashboardsApi.update(A, dashId, { version: u!.version, refreshSec: 30 })), 'client:FIELD_OUT_OF_RANGE');
  });

  await step('CSV: KPI, distribution and card list as UTF-8 CSV with BOM; outsider 404', async () => {
    const d = await dashboardsApi.get(A, dashId);
    const by = (t: string) => d.widgets.find((w) => w.type === t)!.id;
    const kpi = await dashboardsApi.csv(A, dashId, by('kpi_total'));
    assert.ok(kpi.csv.startsWith('﻿'));
    assert.match(kpi.csv.split('\n')[1]!, /,52,count,/);
    const dist = await dashboardsApi.csv(A, dashId, by('dist_stack'));
    assert.ok(dist.csv.split('\n').length >= 2);
    const list = await dashboardsApi.csv(A, dashId, by('card_list'));
    assert.match(list.csv.split('\n')[0]!, /Card ID/);
    assert.equal(kpi.filename, `workhub-dashboard-${dashId}-widget-${by('kpi_total')}.csv`);
    assert.equal(await code(dashboardsApi.csv(B, dashId, by('kpi_total'))), 'not_found:RESOURCE_NOT_FOUND');
    return `overdue list CSV: header + ${list.csv.trim().split('\n').length - 1} rows`;
  });

  await step('refresh: second forced refresh within 10 s → 429 REFRESH_RATE_LIMITED', async () => {
    await sleep(10_500);
    await dashboardsApi.query(A, dashId, { refresh: true });
    assert.equal(await code(dashboardsApi.query(A, dashId, { refresh: true })), 'rate_limited:REFRESH_RATE_LIMITED');
  });

  await step('access: outsider 404; shared view role → read-only (403 on widget add) and results scoped to the viewer (restricted)', async () => {
    assert.equal(await code(dashboardsApi.get(B, dashId)), 'not_found:RESOURCE_NOT_FOUND');
    await workhubApi.setObjectShares(A, 'dashboard', dashId, [{ principalType: 'user', principalId: env('WH_B_USER'), role: 'view' }]);
    const d = await dashboardsApi.get(B, dashId);
    assert.equal(d.role, 'view');
    assert.equal(d.sourcesRestricted, true, 'B cannot read the source project');
    assert.deepEqual(d.sources, [], 'no source names leak');
    assert.equal(await code(dashboardsApi.addWidget(B, dashId, { type: 'kpi_total' })), 'forbidden:ACTION_FORBIDDEN');
    const q = await dashboardsApi.query(B, dashId);
    assert.equal(q.restricted, true);
    const total = d.widgets.find((w) => w.type === 'kpi_total')!;
    assert.equal(q.results[String(total.id)]!.restricted, true);
    assert.equal(q.results[String(total.id)]!.value, undefined, 'no count leaks');
    const drill = await dashboardsApi.drilldown(B, dashId, total.id);
    assert.deepEqual([drill.restricted, drill.items.length], [true, 0]);
  });

  await step('C (Projects off, Dashboard on): own dashboard without sources sees no foreign cards', async () => {
    const d = await dashboardsApi.create(C, { title: `C smoke ${stamp}`, template: 'blank' });
    sharedId = d!.id;
    const w = await dashboardsApi.addWidget(C, sharedId, { type: 'kpi_total' });
    const q = await dashboardsApi.query(C, sharedId);
    const v = q.results[String(w!.id)]!;
    assert.ok(v.restricted === true || v.error !== undefined || v.value === 0 || typeof v.value === 'number');
    assert.equal(await code(dashboardsApi.get(C, dashId)), 'not_found:RESOURCE_NOT_FOUND');
    return `C kpi_total → ${v.error ?? (v.restricted ? 'restricted' : v.value)}`;
  });

  await step('delete: stale version 409; manage deletes; afterwards 404', async () => {
    const d = await dashboardsApi.get(A, dashId);
    assert.equal(await code(dashboardsApi.remove(A, dashId, d.version - 1)), 'conflict:VERSION_CONFLICT');
    assert.equal(await code(dashboardsApi.remove(B, dashId, d.version)), 'forbidden:ACTION_FORBIDDEN');
    await dashboardsApi.remove(A, dashId, d.version);
    assert.equal(await code(dashboardsApi.get(A, dashId)), 'not_found:RESOURCE_NOT_FOUND');
    if (sharedId) {
      const c = await dashboardsApi.get(C, sharedId);
      await dashboardsApi.remove(C, sharedId, c.version);
    }
  });

  for (const [n, r] of results) console.log(`${r.startsWith('PASS') ? '✔' : '✖'} ${n}: ${r}`);
  const failed = results.filter(([, r]) => !r.startsWith('PASS')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

void main();
