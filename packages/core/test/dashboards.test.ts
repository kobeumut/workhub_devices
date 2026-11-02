import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDirectBackend, dispatchWire, isValidDashboardFilter, isValidDashboardInput, isValidDashboardPatch, isValidDrilldownOptions, isValidWidgetConfig, isValidWidgetInput, isValidWidgetPatch,
  type PlainStore,
} from '../src/backend';
import type { SecretStore } from '../src/accounts';
import { OcsError } from '../src/ocs';
import {
  barData, buildDashboardFilter, buildDashboardPatch, buildWidgetConfig, buildWidgetPatch, canDrilldown, configToForm, dashboardRoleAtLeast, filterToForm, formatWidgetValue,
  mergeCards, sortWidgets, widgetState, widgetTitle,
  type ConfigFieldSchema, type Dashboard, type DashboardCard, type DashboardWidget,
} from '../src/workhub';
import { headerOf, json, ocs, scriptedFetch, type Call } from './helpers';

class Mem implements SecretStore, PlainStore {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
  async deletePrefix(p: string) { for (const k of [...this.m.keys()]) if (k.startsWith(p)) this.m.delete(k); }
}
const BAD = { ok: false, error: { kind: 'client', message: 'invalid arguments' } };
const bootstrap = (dashboard: boolean) => json(200, ocs({ apiVersion: '1', modules: { projects: true, dashboard }, permissions: { canViewTeamReport: false } }));

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

const widget = (id: number, over: Partial<DashboardWidget> = {}): DashboardWidget => ({
  id, type: 'kpi_total', title: null, label: 'Total work', module: 'dashboard', kind: 'kpi', available: true, config: {}, filter: {},
  x: 0, y: 0, w: 3, h: 1, sortOrder: id, schemaVer: 1, version: 1, ...over,
});
const dash = (over: Partial<Dashboard> = {}): Dashboard => ({
  id: 7, title: 'Ekip', description: '', owner: { uid: 'ali', displayName: 'Ali' }, role: 'manage', filters: {}, zone: 'Europe/Istanbul', refreshSec: 60, version: 3,
  createdAt: '', updatedAt: '', sources: [{ id: 4, title: 'P', color: '0082c9' }], sourcesPartial: false, sourcesRestricted: false, widgets: [widget(1)], limits: { widgets: 20, sources: 100 }, ...over,
});

test('dashboard gate is fail-closed: module off → DASHBOARD_DISABLED, no dashboard request', async () => {
  const { b, f, id } = await loggedIn(bootstrap(false));
  await assert.rejects(b.dashboards(id, null), (e: unknown) => e instanceof OcsError && e.errorCode === 'DASHBOARD_DISABLED');
  assert.equal(f.calls.filter((c) => c.url.includes('/dashboards')).length, 0);
});

test('role gate reads the CURRENT dashboard: view cannot edit widgets, edit cannot delete', async () => {
  const { b, f, id } = await loggedIn(
    bootstrap(true),
    json(200, ocs(dash({ role: 'view' }))),
    json(200, ocs(dash({ role: 'edit' }))),
  );
  await assert.rejects(b.dashboardWidgetAdd(id, 7, { type: 'kpi_total' }), (e: unknown) => e instanceof OcsError && e.errorCode === 'DASHBOARD_EDIT_REQUIRED');
  await assert.rejects(b.dashboardDelete(id, 7, 3), (e: unknown) => e instanceof OcsError && e.errorCode === 'DASHBOARD_MANAGE_REQUIRED');
  assert.ok(!f.calls.some((c) => c.url.includes('/dashboards') && c.init.method !== 'GET'));
});

test('widget writes: unknown widget id → 404 before any write; delete sends DELETE; full dashboard → TOO_MANY_WIDGETS', async () => {
  const full = dash({ widgets: Array.from({ length: 20 }, (_, i) => widget(i + 1)) });
  const { b, f, id } = await loggedIn(
    bootstrap(true),
    json(200, ocs(dash())),
    json(200, ocs(dash())),
    json(200, ocs({ id: 1, deleted: true })),
    json(200, ocs(full)),
  );
  await assert.rejects(b.dashboardWidgetUpdate(id, 7, 99, { version: 1, title: 'x' }), (e: unknown) => e instanceof OcsError && e.kind === 'not_found');
  await b.dashboardWidgetDelete(id, 7, 1);
  const del = f.calls.at(-1)!;
  assert.equal(del.init.method, 'DELETE');
  assert.ok(del.url.endsWith('/dashboards/7/widgets/1?format=json'));
  await assert.rejects(b.dashboardWidgetAdd(id, 7, { type: 'kpi_total' }), (e: unknown) => e instanceof OcsError && e.errorCode === 'TOO_MANY_WIDGETS');
});

test('create sends Idempotency-Key; query maps {} results to a map; drilldown/CSV pass filters as JSON', async () => {
  const { b, f, id } = await loggedIn(
    bootstrap(true),
    json(201, ocs(dash())),
    json(200, ocs({ dashboardId: 7, generatedAt: '', asOf: '', scopedToViewer: true, restricted: false, partial: false, results: [] })),
    json(200, ocs({ widgetId: 1, generatedAt: '', asOf: '', restricted: false, partial: false, columns: [], items: [], nextCursor: null })),
    new Response('Widget,Value\n"Total",3\n', { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8' } }),
  );
  await b.dashboardCreate(id, { title: '  Ekip ', template: 'project_summary', sources: [4] }, 'abcdef12-3456');
  const create = f.calls.at(-1)!;
  assert.equal(headerOf(create, 'Idempotency-Key'), 'abcdef12-3456');
  assert.equal(JSON.parse(create.init.body as string).title, 'Ekip');
  const q = await b.dashboardQuery(id, 7, { refresh: true });
  assert.deepEqual(q.results, {});
  assert.deepEqual(JSON.parse(f.calls.at(-1)!.init.body as string), { refresh: true });
  await b.dashboardDrilldown(id, 7, 1, { groupKey: 'user:bob', filters: { doneState: 'open' } });
  const u = new URL(f.calls.at(-1)!.url);
  assert.equal(u.searchParams.get('groupKey'), 'user:bob');
  assert.equal(u.searchParams.get('filters'), '{"doneState":"open"}');
  const csv = await b.dashboardCsv(id, 7, 1, null);
  assert.equal(csv.filename, 'workhub-dashboard-7-widget-1.csv');
  assert.ok(csv.csv.startsWith('﻿Widget,Value'));
  assert.ok(f.calls.at(-1)!.url.startsWith('https://ex.com/index.php/apps/workhub/csv/dashboards/7/widgets/1'));
});

test('CSV error JSON (e.g. 404 for a dashboard you lost) becomes an OcsError, not a file', async () => {
  const { b, id } = await loggedIn(bootstrap(true), json(404, { error: 'RESOURCE_NOT_FOUND', message: 'Record not found.' }));
  await assert.rejects(b.dashboardCsv(id, 7, 1, null), (e: unknown) => e instanceof OcsError && e.kind === 'not_found' && e.errorCode === 'RESOURCE_NOT_FOUND');
});

test('IPC validators: filter fields/limits/dates, config shape, layout, cursor, group key', async () => {
  assert.ok(isValidDashboardFilter({}));
  assert.ok(isValidDashboardFilter({ boardIds: [1, 2], doneState: 'open', dueFrom: '2026-11-01', dueTo: '2026-11-30', includeArchived: true, assigneeUids: ['bob', 'a.b@c'] }));
  assert.ok(!isValidDashboardFilter({ search: 'x' }), 'unknown field');
  assert.ok(!isValidDashboardFilter({ boardIds: [1, 1] }), 'duplicate id');
  assert.ok(!isValidDashboardFilter({ boardIds: [0] }));
  assert.ok(!isValidDashboardFilter({ dueFrom: '2026-13-01' }), 'not a calendar day');
  assert.ok(!isValidDashboardFilter({ dueFrom: '2026-12-02', dueTo: '2026-12-01' }), 'reversed range');
  assert.ok(!isValidDashboardFilter({ assigneeUids: ['bob,carol'] }), 'uid charset');
  assert.ok(!isValidDashboardFilter({ doneState: 'closed' }));
  assert.ok(!isValidDashboardFilter({ stackIds: Array.from({ length: 201 }, (_, i) => i + 1) }), 'limit');

  assert.ok(isValidDashboardInput({ title: 'A', sources: [3], template: 'blank', refreshSec: 0 }));
  assert.ok(!isValidDashboardInput({ title: ' ' }));
  assert.ok(!isValidDashboardInput({ title: 'A', refreshSec: 30 }), 'refresh 0 or 60…86400');
  assert.ok(!isValidDashboardInput({ title: 'A', template: 'kanban' }));
  assert.ok(!isValidDashboardInput({ title: 'A', owner: 'x' }));
  assert.ok(isValidDashboardPatch({ version: 2, title: 'B' }));
  assert.ok(!isValidDashboardPatch({ version: 2 }), 'nothing to change');
  assert.ok(!isValidDashboardPatch({ title: 'B' }), 'version required');

  assert.ok(isValidWidgetConfig({ preset: 'open', pageSize: 10, goalIds: [1, 2], flag: true, boardId: null }));
  assert.ok(!isValidWidgetConfig({ nested: { a: 1 } }));
  assert.ok(!isValidWidgetConfig({ '__proto__x': 1, 'bad key': 1 }));
  assert.ok(isValidWidgetInput({ type: 'card_list', config: { preset: 'open' }, filter: { doneState: 'open' }, w: 6, h: 2 }));
  assert.ok(!isValidWidgetInput({ type: 'Card-List' }));
  assert.ok(!isValidWidgetInput({ type: 'kpi_total', x: 10, w: 3 }), 'exceeds 12 columns');
  assert.ok(!isValidWidgetInput({ type: 'kpi_total', w: 2 }), 'min width 3');
  assert.ok(isValidWidgetPatch({ version: 1, w: 12, x: 0 }));
  assert.ok(!isValidWidgetPatch({ version: 1 }));

  assert.ok(isValidDrilldownOptions({}));
  assert.ok(isValidDrilldownOptions({ groupKey: 'user:bob', cursor: 'eyJ0IjoxNzkzNjQ1MDQ2LCJjIjoiYWJjIn0' }));
  assert.ok(!isValidDrilldownOptions({ cursor: 'a+b/=' }), 'url-safe base64 only');
  assert.ok(!isValidDrilldownOptions({ groupKey: 'a\nb' }));
  assert.ok(!isValidDrilldownOptions({ groupKey: 'x'.repeat(81) }));

  const { b } = await loggedIn();
  assert.deepEqual(await dispatchWire(b, 'dashboardCreate', ['acc', { title: 'A' }, 'not a key!']), BAD);
  assert.deepEqual(await dispatchWire(b, 'dashboardQuery', ['acc', 7, { widgetIds: [1, 1] }]), BAD);
  assert.deepEqual(await dispatchWire(b, 'dashboardCsv', ['acc', 7, 1, { unknown: 1 }]), BAD);
  assert.deepEqual(await dispatchWire(b, 'dashboardDelete', ['acc', 7, -1]), BAD);
  assert.deepEqual(await dispatchWire(b, 'dashboards', ['acc', 'bad cursor!']), BAD);
});

test('formatting, bars, role order, ordering, drill-down support', () => {
  assert.equal(formatWidgetValue(1234), (1234).toLocaleString('tr-TR'));
  assert.equal(formatWidgetValue(4550, 'bp'), '%45,5');
  assert.equal(formatWidgetValue(5400, 'seconds'), '1,5 sa');
  assert.equal(formatWidgetValue(60, 'seconds'), '<0,1 sa');
  assert.equal(formatWidgetValue(null, 'bp'), '—');
  const bars = barData([{ key: 'a', label: 'A', value: 5 }, { key: 'b', label: 'B', value: 10 }, { key: 'c', label: 'C', value: 0 }]);
  assert.deepEqual(bars.map((x) => x.fraction), [0.5, 1, 0]);
  assert.deepEqual(bars.map((x) => Math.round(x.share * 100)), [33, 67, 0]);
  assert.deepEqual(barData([{ key: 'z', label: 'Z', value: 0 }]).map((x) => x.fraction), [0]);
  assert.ok(dashboardRoleAtLeast('manage', 'edit') && dashboardRoleAtLeast('edit', 'edit') && !dashboardRoleAtLeast('view', 'edit') && !dashboardRoleAtLeast(undefined, 'view'));
  assert.deepEqual(sortWidgets([widget(1, { y: 1, x: 6 }), widget(2, { y: 0, x: 3 }), widget(3, { y: 1, x: 0 }), widget(4, { y: 0, x: 0 })]).map((w) => w.id), [4, 2, 3, 1]);
  assert.equal(widgetTitle(widget(1, { title: 'Toplam' })), 'Toplam');
  assert.equal(widgetTitle(widget(1, { title: '  ' })), 'Total work');
  assert.ok(canDrilldown(widget(1)));
  assert.ok(canDrilldown(widget(1, { kind: 'distribution' })) && canDrilldown(widget(1, { kind: 'list' })));
  assert.ok(!canDrilldown(widget(1, { kind: 'trend' })), 'trend has no card preset');
  assert.ok(!canDrilldown(widget(1, { module: 'time', kind: 'distribution' })), 'time widgets are not cards');
  assert.ok(!canDrilldown(widget(1, { available: false })));
});

test('widgetState: error / unavailable / restricted / empty / ok per kind', () => {
  const base = { widgetId: 1, type: 'x' };
  assert.equal(widgetState(undefined), 'empty');
  assert.equal(widgetState({ ...base, error: 'WIDGET_UNAVAILABLE' }), 'unavailable');
  assert.equal(widgetState({ ...base, error: 'WIDGET_FAILED' }), 'error');
  assert.equal(widgetState({ ...base, kind: 'kpi', restricted: true }), 'restricted');
  assert.equal(widgetState({ ...base, kind: 'kpi', value: null, unit: 'bp' }), 'ok', 'N/A is shown with its note');
  assert.equal(widgetState({ ...base, kind: 'distribution', groups: [] }), 'empty');
  assert.equal(widgetState({ ...base, kind: 'progress', restricted: true, items: [{ id: 1, title: 'G', progressBp: null, state: 'restricted', due: null, owner: 'a', url: '' }] }), 'ok', 'goals list partial items');
  assert.equal(widgetState({ ...base, kind: 'text', markdown: '  ' }), 'empty');
  assert.equal(widgetState({ ...base, kind: 'list', rows: [{ id: 1 } as DashboardCard] }), 'ok');
});

test('filter form ↔ normalized filter: defaults dropped, sorted, dates checked, unsupported fields rejected', () => {
  const form = filterToForm({ boardIds: [5, 2], doneState: 'open', stackIds: [9] });
  assert.deepEqual(form.boardIds, [5, 2]);
  const r = buildDashboardFilter({ ...form, dueFrom: '2026-11-01', boardIds: [5, 2, 5] });
  assert.ok('filter' in r);
  assert.deepEqual(r.filter, { boardIds: [2, 5], doneState: 'open', dueFrom: '2026-11-01', stackIds: [9] });
  assert.deepEqual(Object.keys(r.filter), ['boardIds', 'doneState', 'dueFrom', 'stackIds'], 'keys sorted like the server');
  assert.deepEqual(buildDashboardFilter({ ...filterToForm({}), doneState: 'any' }), { filter: {} });
  assert.deepEqual(buildDashboardFilter({ ...filterToForm({}), dueFrom: '2026-02-30' }), { error: 'date_invalid', field: 'dueFrom' });
  assert.deepEqual(buildDashboardFilter({ ...filterToForm({}), createdFrom: '2026-03-02', createdTo: '2026-03-01' }), { error: 'date_order', field: 'createdFrom' });
  // trend_open supports only boardIds/stackIds/assigneeUids/labelIds/includeArchived.
  const trend = ['boardIds', 'stackIds', 'assigneeUids', 'labelIds', 'includeArchived'];
  assert.deepEqual(buildDashboardFilter({ ...filterToForm({}), doneState: 'done' }, trend), { error: 'unsupported', field: 'doneState' });
  assert.deepEqual(buildDashboardFilter({ ...filterToForm({}), includeArchived: true }, trend), { filter: { includeArchived: true } });
});

test('config form by schema: int range, enum, idList; empty → server default', () => {
  const schema: Record<string, ConfigFieldSchema> = {
    preset: { type: 'enum', label: 'Cards', default: 'all', options: [{ value: 'all', label: 'All' }, { value: 'open', label: 'Open' }] },
    pageSize: { type: 'int', label: 'Page size', min: 5, max: 100, default: 10 },
    goalIds: { type: 'idList', label: 'Goals', max: 3 },
    flag: { type: 'bool', label: 'Flag', default: false },
  };
  const form = configToForm(schema, { preset: 'open', goalIds: [3, 4] });
  assert.deepEqual(form, { preset: 'open', pageSize: '10', goalIds: '3, 4', flag: false });
  assert.deepEqual(buildWidgetConfig(schema, form), { config: { preset: 'open', pageSize: 10, goalIds: [3, 4], flag: false } });
  assert.deepEqual(buildWidgetConfig(schema, { ...form, pageSize: '' }), { config: { preset: 'open', goalIds: [3, 4], flag: false } });
  assert.deepEqual(buildWidgetConfig(schema, { ...form, pageSize: '4' }), { field: 'pageSize', error: 'int_range' });
  assert.deepEqual(buildWidgetConfig(schema, { ...form, pageSize: '1e2' }), { field: 'pageSize', error: 'int_range' });
  assert.deepEqual(buildWidgetConfig(schema, { ...form, preset: 'late' }), { field: 'preset', error: 'enum' });
  assert.deepEqual(buildWidgetConfig(schema, { ...form, goalIds: '1, x' }), { field: 'goalIds', error: 'id_list' });
  assert.deepEqual(buildWidgetConfig(schema, { ...form, goalIds: '1 2 3 4' }), { field: 'goalIds', error: 'too_many' });
});

test('dashboard / widget patches carry only changed fields + version', () => {
  const d = dash();
  const same = { title: 'Ekip', description: '', zone: 'Europe/Istanbul', refreshSec: '60', sources: [4], filters: {} };
  assert.deepEqual(buildDashboardPatch(d, same), { patch: null });
  assert.deepEqual(buildDashboardPatch(d, { ...same, title: ' Yeni ', refreshSec: '0', sources: [9, 4, 9] }), { patch: { version: 3, title: 'Yeni', refreshSec: 0, sources: [4, 9] } });
  assert.deepEqual(buildDashboardPatch(d, { ...same, filters: { doneState: 'open' } }), { patch: { version: 3, filters: { doneState: 'open' } } });
  assert.deepEqual(buildDashboardPatch(d, { ...same, title: '' }), { error: 'title_required' });
  assert.deepEqual(buildDashboardPatch(d, { ...same, refreshSec: '30' }), { error: 'refresh_range' });
  assert.deepEqual(buildDashboardPatch(d, { ...same, zone: '+03:00' }), { error: 'zone_invalid' });

  const w = widget(1, { config: { days: 7, pageSize: 10, preset: 'all', sort: 'due' }, x: 6, w: 6 });
  assert.equal(buildWidgetPatch(w, { title: '', config: { preset: 'all' }, filter: {}, w: 6, h: 1 }), null);
  assert.deepEqual(buildWidgetPatch(w, { title: 'Açık', config: { preset: 'open' }, filter: { doneState: 'open' }, w: 12, h: 2 }), {
    version: 1, title: 'Açık', config: { preset: 'open' }, filter: { doneState: 'open' }, w: 12, x: 0, h: 2,
  });
});

test('mergeCards drops cards already shown', () => {
  const c = (id: number) => ({ id } as DashboardCard);
  assert.deepEqual(mergeCards([c(1), c(2)], [c(2), c(3)]).map((x) => x.id), [1, 2, 3]);
});
