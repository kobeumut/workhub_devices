import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import {
  OcsError, barData, buildDashboardFilter, buildDashboardPatch, buildWidgetConfig, buildWidgetPatch, canDrilldown, canExportCsv, configToForm, dashboardRoleAtLeast, filterToForm,
  mergeCards, sortWidgets, widgetState, widgetTitle, DASHBOARD_FILTER_FIELDS,
  type AccountId, type ConfigFieldSchema, type ConfigForm, type Dashboard, type DashboardCard, type DashboardFilterForm, type DashboardSummary,
  type DashboardTemplate, type DashboardWidget, type WidgetResult, type WidgetTypeDef, type WidgetUnit,
} from '@workhub-devices/core';
import { useAsync, useServices } from './services';
import { Button, Field, Loading, card, styles as ui } from './ui';
import { Chip } from './taskEdit';
import { ProgressBar } from './goals';
import { SharesEditor } from './projectAdmin';
import { colors, font, space } from './theme';
import { describeError, formatDate, intlTag, messages, t } from './i18n';

const m = messages.dashboards;

/** Hex UUID v4 (Idempotency-Key must pass the IPC key check even without crypto.randomUUID). */
const uuid = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const h = () => Math.floor(Math.random() * 16).toString(16);
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, h);
};
const dateTime = (iso: string) => `${formatDate(iso)} ${new Date(iso).toLocaleTimeString(intlTag(), { hour: '2-digit', minute: '2-digit' })}`;

// Label tables are functions (not module constants) so the text follows the active language at render time.
const roleName = (role: string): string => {
  const names: Record<string, string> = { view: m.roleView, edit: m.roleEdit, manage: m.roleManage };
  return names[role] ?? role;
};
const kindName = (kind: string): string | undefined => {
  const names: Record<string, string> = { kpi: m.kindKpi, distribution: m.kindDistribution, trend: m.kindTrend, progress: m.kindProgress, list: m.kindList, text: m.kindText };
  return names[kind];
};
const filterName = (field: string): string => {
  const names: Record<string, string> = {
    boardIds: m.filterProject, stackIds: m.filterColumn, assigneeUids: m.filterAssignee, labelIds: m.filterLabel, doneState: m.filterStatus, dueFrom: m.filterDueStart, dueTo: m.filterDueEnd,
    createdFrom: m.filterCreatedStart, createdTo: m.filterCreatedEnd, includeArchived: m.filterArchive,
  };
  return names[field] ?? field;
};
const filterError = (code: 'date_invalid' | 'date_order' | 'unsupported'): string => {
  const texts = { date_invalid: m.filterDateInvalid, date_order: m.filterDateOrder, unsupported: m.filterUnsupported };
  return texts[code];
};
const configError = (code: 'int_range' | 'enum' | 'id_list' | 'too_many'): string => {
  const texts = { int_range: m.configIntRange, enum: m.configEnum, id_list: m.configIdList, too_many: m.configTooMany };
  return texts[code];
};

/** A widget value in its unit for the active language: count `12,345`, share `45.5%`, hours `3.5 h`. */
function widgetValue(value: number | null | undefined, unit: WidgetUnit | undefined = 'count'): string {
  if (value === null || value === undefined) return '—';
  const tag = intlTag();
  if (unit === 'bp') return m.percent((value / 100).toLocaleString(tag, { maximumFractionDigits: 1 }));
  if (unit === 'seconds') {
    const h = Math.round((value / 3600) * 10) / 10;
    return m.hours(value > 0 && h === 0 ? `<${(0.1).toLocaleString(tag)}` : h.toLocaleString(tag, { maximumFractionDigits: 1 }));
  }
  return value.toLocaleString(tag);
}

export function dashboardError(e: unknown): string {
  if (e instanceof OcsError) {
    switch (e.errorCode) {
      case 'VERSION_CONFLICT':
        return m.errVersionConflict;
      case 'DASHBOARD_DISABLED':
        return m.errDisabled;
      case 'DASHBOARD_EDIT_REQUIRED':
        return m.errEditRequired;
      case 'DASHBOARD_MANAGE_REQUIRED':
        return m.errManageRequired;
      case 'TOO_MANY_WIDGETS':
        return m.errTooManyWidgets;
      case 'TOO_MANY_SOURCES':
        return m.errTooManySources;
      case 'INVALID_SOURCE':
        return m.errInvalidSource;
      case 'INVALID_FILTER':
      case 'UNSUPPORTED_FILTER':
      case 'UNKNOWN_FILTER_FIELD':
        return e.ocsMessage ? m.errInvalidFilterDetail(e.ocsMessage) : m.errInvalidFilter;
      case 'INVALID_CONFIG':
      case 'UNKNOWN_CONFIG_FIELD':
        return e.ocsMessage ? m.errInvalidConfigDetail(e.ocsMessage) : m.errInvalidConfig;
      case 'UNKNOWN_WIDGET_TYPE':
        return m.errUnknownWidgetType;
      case 'INVALID_LAYOUT':
        return m.errInvalidLayout;
      case 'INVALID_ZONE':
        return m.errInvalidZone;
      case 'FIELD_OUT_OF_RANGE':
        return m.errRefreshRange;
      case 'REFRESH_RATE_LIMITED':
        return m.errRefreshRateLimited;
      case 'DRILLDOWN_UNSUPPORTED':
        return m.errDrilldownUnsupported;
      case 'CSV_UNSUPPORTED':
        return m.errCsvUnsupported;
      case 'WIDGET_UNAVAILABLE':
        return m.errWidgetUnavailable;
      case 'INVALID_CURSOR':
        return m.errInvalidCursor;
    }
    if (e.kind === 'not_found') return m.errDashboardNotFound;
    if (e.kind === 'forbidden') return t.errForbidden;
    if (e.kind === 'client' && e.ocsMessage) return e.ocsMessage;
  }
  return describeError(e);
}

function Alert({ text, ok }: { text?: string | undefined; ok?: boolean | undefined }) {
  return text ? <Text accessibilityRole="alert" style={{ color: ok ? colors.ok : colors.danger, marginVertical: space(1) }}>{text}</Text> : null;
}
const H = ({ children }: { children: string }) => <Text accessibilityRole="header" style={{ fontWeight: '700', color: colors.text, marginBottom: space(2) }}>{children}</Text>;
const Muted = ({ children }: { children: ReactNode }) => <Text style={{ color: colors.muted, fontSize: font.small }}>{children}</Text>;

// ---- List + create ---------------------------------------------------------------------------

/**
 * Native dashboards: list (own + shared, server-paged), create (blank / project summary
 * template, source projects), and the dashboard view with widget results, drill-down, CSV,
 * widget CRUD, header edit, sharing and delete — every action gated by the server's role.
 */
export function DashboardsScreen({ accountId, projectsEnabled, onOpenTask }: { accountId: AccountId; projectsEnabled: boolean; onOpenTask?: (cardId: number) => void }) {
  const { backend } = useServices();
  const [open, setOpen] = useState<number | null>(null);
  const [more, setMore] = useState<DashboardSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [moreErr, setMoreErr] = useState<string>();
  const list = useAsync(async () => {
    const page = await backend.dashboards(accountId, null);
    setMore([]);
    setCursor(page.nextCursor);
    return page.items;
  }, [accountId]);
  const items = [...(list.data ?? []), ...more];
  const loadMore = async () => {
    if (!cursor) return;
    try {
      const page = await backend.dashboards(accountId, cursor);
      setMore((m) => [...m, ...page.items.filter((x) => !items.some((y) => y.id === x.id))]);
      setCursor(page.nextCursor);
    } catch (e) {
      setMoreErr(dashboardError(e));
    }
  };

  if (open !== null) {
    return (
      <DashboardView
        accountId={accountId}
        id={open}
        projectsEnabled={projectsEnabled}
        {...(onOpenTask ? { onOpenTask } : {})}
        onChanged={list.reload}
        onClose={() => setOpen(null)}
      />
    );
  }
  return (
    <ScrollView contentContainerStyle={{ padding: space(3) }}>
      {list.error ? <Alert text={dashboardError(list.error)} /> : null}
      {list.loading && !list.data ? <Loading /> : null}
      {items.length === 0 && !list.loading && !list.error ? <Text style={{ color: colors.muted, marginBottom: space(3) }}>{m.empty}</Text> : null}
      {items.map((d) => (
        <View key={d.id} style={card}>
          <Text style={{ fontWeight: '700', color: colors.text }}>{d.title}</Text>
          <Muted>
            {m.summaryMeta(d.owner.displayName, d.widgetCount, roleName(d.role), dateTime(d.updatedAt))}
          </Muted>
          {d.description ? <Text style={{ color: colors.text, marginTop: space(1) }} numberOfLines={2}>{d.description}</Text> : null}
          <Button title={m.open} accessibilityLabel={m.openDashboardLabel(d.title)} kind="secondary" onPress={() => setOpen(d.id)} />
        </View>
      ))}
      {cursor ? <Button title={m.loadMore} kind="secondary" onPress={() => void loadMore()} /> : null}
      <Alert text={moreErr} />
      <CreateDashboard accountId={accountId} projectsEnabled={projectsEnabled} onCreated={(id) => { list.reload(); setOpen(id); }} />
    </ScrollView>
  );
}

/** Readable, non-archived projects as source choices (only when the Projects module is on). */
function SourcePicker({ accountId, value, onChange, hidden }: { accountId: AccountId; value: number[]; onChange: (ids: number[]) => void; hidden?: Array<{ id: number; title: string }> }) {
  const { backend } = useServices();
  const projects = useAsync(() => backend.projects(accountId), [accountId]);
  const [q, setQ] = useState('');
  const all = [...(projects.data ?? []).filter((p) => !p.archived).map((p) => ({ id: p.id, title: p.title })), ...(hidden ?? []).filter((h) => !(projects.data ?? []).some((p) => p.id === h.id))];
  const shown = all.filter((p) => value.includes(p.id) || p.title.toLocaleLowerCase(intlTag()).includes(q.trim().toLocaleLowerCase(intlTag()))).slice(0, 24);
  const toggle = (id: number) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <View style={{ marginBottom: space(2) }}>
      <Text style={ui.label}>{m.sourceProjects(value.length)}</Text>
      <TextInput accessibilityLabel={m.searchProjects} placeholder={m.searchProjects} placeholderTextColor={colors.muted} value={q} onChangeText={setQ} style={[ui.input, { marginBottom: space(2) }]} />
      {projects.error ? <Alert text={dashboardError(projects.error)} /> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
        {shown.map((p) => <Chip key={p.id} label={p.title} selected={value.includes(p.id)} onPress={() => toggle(p.id)} />)}
      </View>
    </View>
  );
}

function CreateDashboard({ accountId, projectsEnabled, onCreated }: { accountId: AccountId; projectsEnabled: boolean; onCreated: (id: number) => void }) {
  const { backend } = useServices();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState<DashboardTemplate>('project_summary');
  const [sources, setSources] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  // One key per form submission: a retried create after a timeout is not duplicated.
  const [key, setKey] = useState(uuid);
  const create = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const d = await backend.dashboardCreate(accountId, { title: title.trim(), template, ...(description.trim() ? { description: description.trim() } : {}), ...(sources.length ? { sources } : {}) }, key);
      setTitle('');
      setDescription('');
      setSources([]);
      setKey(uuid());
      if (d) onCreated(d.id);
    } catch (e) {
      setErr(dashboardError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={card}>
      <H>{m.newDashboard}</H>
      <TextInput accessibilityLabel={m.dashboardTitleLabel} placeholder={m.title} placeholderTextColor={colors.muted} value={title} onChangeText={setTitle} maxLength={200} style={[ui.input, { marginBottom: space(2) }]} />
      <TextInput accessibilityLabel={m.dashboardDescriptionLabel} placeholder={m.descriptionOptional} placeholderTextColor={colors.muted} value={description} onChangeText={setDescription} maxLength={2000} multiline style={[ui.input, { minHeight: 60, paddingTop: 10, marginBottom: space(2) }]} />
      <Text style={ui.label}>{m.template}</Text>
      <View style={{ flexDirection: 'row', gap: space(2), marginBottom: space(2) }}>
        <Chip label={m.templateProjectSummary} selected={template === 'project_summary'} onPress={() => setTemplate('project_summary')} />
        <Chip label={m.templateBlank} selected={template === 'blank'} onPress={() => setTemplate('blank')} />
      </View>
      {projectsEnabled ? <SourcePicker accountId={accountId} value={sources} onChange={setSources} /> : null}
      <Alert text={err} />
      <Button title={m.createDashboard} busy={busy} disabled={!title.trim()} onPress={() => void create()} />
    </View>
  );
}

// ---- Dashboard view --------------------------------------------------------------------------

type Panel = { kind: 'edit' } | { kind: 'share' } | { kind: 'add' } | { kind: 'widget'; id: number } | { kind: 'drill'; widgetId: number; groupKey?: string; groupLabel?: string } | null;

export function DashboardView({ accountId, id, projectsEnabled, onOpenTask, onChanged, onClose }: {
  accountId: AccountId;
  id: number;
  projectsEnabled: boolean;
  onOpenTask?: (cardId: number) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { backend } = useServices();
  const detail = useAsync(() => backend.dashboard(accountId, id), [accountId, id]);
  const d = detail.data;
  const [tick, setTick] = useState(0);
  // A forced refresh bypasses the server cache once (rate limited: one per user per 10 s).
  const force = useRef(false);
  const results = useAsync(() => {
    if (!d) return Promise.resolve(undefined);
    const refresh = force.current;
    force.current = false;
    return backend.dashboardQuery(accountId, id, refresh ? { refresh: true } : {});
  }, [accountId, id, d?.version, d?.widgets.map((w) => `${w.id}:${w.version}`).join(','), tick]);
  const [panel, setPanel] = useState<Panel>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  // Auto refresh at the dashboard's interval (cached server results; never the forced refresh).
  useEffect(() => {
    if (!d || d.refreshSec <= 0) return;
    const t = setInterval(() => setTick((n) => n + 1), d.refreshSec * 1000);
    return () => clearInterval(t);
  }, [d?.refreshSec, d]);

  const fail = (e: unknown) => {
    setMsg({ ok: false, text: dashboardError(e) });
    if (e instanceof OcsError && (e.kind === 'conflict' || e.kind === 'not_found')) detail.reload();
  };
  const changed = (text: string) => {
    setMsg({ ok: true, text });
    detail.reload();
    onChanged();
  };

  if (detail.loading && !d) return <Loading />;
  if (!d) {
    return (
      <ScrollView contentContainerStyle={{ padding: space(3) }}>
        <Alert text={dashboardError(detail.error)} />
        <Button title={m.backToList} kind="secondary" onPress={onClose} />
      </ScrollView>
    );
  }
  const canEdit = dashboardRoleAtLeast(d.role, 'edit');
  const canManage = dashboardRoleAtLeast(d.role, 'manage');
  const q = results.data;
  const widgets = sortWidgets(d.widgets);
  const drillWidget = panel?.kind === 'drill' ? d.widgets.find((w) => w.id === panel.widgetId) : undefined;
  const editWidget = panel?.kind === 'widget' ? d.widgets.find((w) => w.id === panel.id) : undefined;

  const remove = async () => {
    setBusy(true);
    try {
      await backend.dashboardDelete(accountId, d.id, d.version);
      onChanged();
      onClose();
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  };

  if (drillWidget && panel?.kind === 'drill') {
    return (
      <DrilldownView
        accountId={accountId}
        dashboardId={d.id}
        widget={drillWidget}
        projectsEnabled={projectsEnabled}
        {...(panel.groupKey !== undefined ? { groupKey: panel.groupKey } : {})}
        {...(panel.groupLabel ? { groupLabel: panel.groupLabel } : {})}
        {...(onOpenTask ? { onOpenTask } : {})}
        onClose={() => setPanel(null)}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: space(3), paddingBottom: space(8) }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), alignItems: 'center' }}>
        <Button title={m.backToDashboards} kind="secondary" onPress={onClose} />
        <Button title={m.refresh} kind="secondary" busy={results.loading && !!q} onPress={() => { force.current = true; setTick((n) => n + 1); }} accessibilityHint={m.refreshHint} />
        {canEdit ? <Button title={t.edit} kind="secondary" onPress={() => setPanel(panel?.kind === 'edit' ? null : { kind: 'edit' })} /> : null}
        {canEdit ? <Button title={m.addWidget} kind="secondary" onPress={() => setPanel(panel?.kind === 'add' ? null : { kind: 'add' })} /> : null}
        {canManage ? <Button title={m.share} kind="secondary" onPress={() => setPanel(panel?.kind === 'share' ? null : { kind: 'share' })} /> : null}
        {canManage ? <Button title={m.delete} kind="danger" onPress={() => setConfirmDelete(true)} /> : null}
      </View>
      <View style={[card, { marginTop: space(2) }]}>
        <Text accessibilityRole="header" style={{ fontSize: font.title, fontWeight: '700', color: colors.text }}>{d.title}</Text>
        {d.description ? <Text style={{ color: colors.text, marginTop: space(1) }}>{d.description}</Text> : null}
        <Muted>
          {d.refreshSec ? m.headerMetaRefresh(d.owner.displayName, roleName(d.role), d.zone, Math.round(d.refreshSec / 60)) : m.headerMetaNoRefresh(d.owner.displayName, roleName(d.role), d.zone)}
        </Muted>
        <Muted>
          {m.sourcesLine(d.sources.length ? d.sources.map((s) => s.title).join(', ') : d.sourcesRestricted ? '—' : m.sourcesAll, d.sourcesPartial)}
        </Muted>
        {d.sourcesRestricted ? <Text style={{ color: colors.danger, marginTop: space(1) }}>{m.sourcesRestricted}</Text> : null}
        {q ? (
          <Muted>
            {m.resultsNote(dateTime(q.generatedAt), !!q.partial)}
          </Muted>
        ) : null}
      </View>
      <Alert text={msg?.text} ok={msg?.ok} />
      {results.error ? <Alert text={dashboardError(results.error)} /> : null}
      {confirmDelete ? (
        <View style={card}>
          <Text style={{ color: colors.text, marginBottom: space(2) }}>{m.confirmDelete(d.title)}</Text>
          <View style={{ flexDirection: 'row', gap: space(2) }}>
            <Button title={m.confirmDeleteYes} kind="danger" busy={busy} onPress={() => void remove()} />
            <Button title={m.cancel} kind="secondary" onPress={() => setConfirmDelete(false)} />
          </View>
        </View>
      ) : null}
      {panel?.kind === 'edit' ? (
        <DashboardEditor accountId={accountId} d={d} projectsEnabled={projectsEnabled} onDone={(ok) => { setPanel(null); if (ok) changed(m.dashboardSaved); }} onError={fail} />
      ) : null}
      {panel?.kind === 'share' ? (
        <View style={card}>
          <SharesEditor accountId={accountId} type="dashboard" objectId={d.id} onClose={() => setPanel(null)} />
        </View>
      ) : null}
      {panel?.kind === 'add' ? (
        <WidgetEditor accountId={accountId} d={d} onDone={(ok) => { setPanel(null); if (ok) changed(m.widgetAdded); }} onError={fail} />
      ) : null}
      {editWidget ? (
        <WidgetEditor accountId={accountId} d={d} widget={editWidget} onDone={(ok) => { setPanel(null); if (ok) changed(m.widgetSaved); }} onError={fail} />
      ) : null}
      {widgets.length === 0 ? <Text style={{ color: colors.muted, marginVertical: space(3) }}>{m.noWidgets(canEdit)}</Text> : null}
      {results.loading && !q && widgets.length ? <Loading /> : null}
      {widgets.map((w) => (
        <WidgetCard
          key={w.id}
          accountId={accountId}
          dashboardId={d.id}
          widget={w}
          result={q?.results[String(w.id)]}
          canEdit={canEdit}
          projectsEnabled={projectsEnabled}
          {...(onOpenTask ? { onOpenTask } : {})}
          onDrill={(groupKey, groupLabel) => setPanel({ kind: 'drill', widgetId: w.id, ...(groupKey !== undefined ? { groupKey } : {}), ...(groupLabel ? { groupLabel } : {}) })}
          onEdit={() => setPanel({ kind: 'widget', id: w.id })}
          onRemoved={() => changed(m.widgetRemoved)}
          onError={fail}
        />
      ))}
    </ScrollView>
  );
}

// ---- Widget rendering --------------------------------------------------------------------------

/** Decorative proportional bar; the value is always in the adjacent text (not colour/length only). */
function Bar({ fraction, color }: { fraction: number; color?: string | undefined }) {
  return (
    <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={{ height: 10, backgroundColor: colors.surface, borderRadius: 3, overflow: 'hidden', flex: 1 }}>
      <View style={{ height: 10, width: `${Math.round(fraction * 100)}%`, backgroundColor: color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : colors.primary }} />
    </View>
  );
}

const pct = (share: number) => m.percent((Math.round(share * 1000) / 10).toLocaleString(intlTag()));

/** Distribution as an accessible table (group, value, share) with an optional bar column. */
function DistributionTable({ title, r, onDrill }: { title: string; r: WidgetResult; onDrill?: ((key: string, label: string) => void) | undefined }) {
  const rows = barData(r.groups ?? []);
  const colors2 = new Map((r.groups ?? []).map((g) => [g.key, g.color]));
  return (
    <View role="table" aria-label={title} style={{ marginTop: space(1) }}>
      <View role="row" style={{ flexDirection: 'row', borderBottomWidth: 1, borderColor: colors.border, paddingVertical: space(1) }}>
        <Text role="columnheader" style={{ flex: 3, fontWeight: '700', color: colors.text }}>{m.colGroup}</Text>
        <Text role="columnheader" style={{ width: 64, textAlign: 'right', fontWeight: '700', color: colors.text }}>{m.colValue}</Text>
        <Text role="columnheader" style={{ width: 56, textAlign: 'right', fontWeight: '700', color: colors.text }}>{m.colShare}</Text>
        <Text role="columnheader" aria-hidden style={{ flex: 1, minWidth: 40, paddingLeft: space(2), color: colors.muted }} />
      </View>
      {rows.map((g) => {
        const value = widgetValue(g.value, r.unit);
        // RN Web: `role` overrides `accessibilityRole`, so the button lives INSIDE the row header cell.
        return (
          <View key={g.key} role="row" style={{ flexDirection: 'row', alignItems: 'center', minHeight: 40, borderBottomWidth: 1, borderColor: colors.border }}>
            <View role="rowheader" style={{ flex: 3 }}>
              {onDrill ? (
                <Pressable accessibilityRole="button" accessibilityLabel={m.groupDrillLabel(g.label, value, pct(g.share))} onPress={() => onDrill(g.key, g.label)} style={{ minHeight: 40, justifyContent: 'center' }}>
                  <Text numberOfLines={2} style={{ color: colors.primary, fontWeight: '600' }}>{g.label}</Text>
                </Pressable>
              ) : (
                <Text numberOfLines={2} style={{ color: colors.text }}>{g.label}</Text>
              )}
            </View>
            <Text role="cell" style={{ width: 64, textAlign: 'right', color: colors.text }}>{value}</Text>
            <Text role="cell" style={{ width: 56, textAlign: 'right', color: colors.muted }}>{pct(g.share)}</Text>
            <View role="cell" style={{ flex: 1, minWidth: 40, paddingLeft: space(2), justifyContent: 'center' }}><Bar fraction={g.fraction} color={colors2.get(g.key)} /></View>
          </View>
        );
      })}
    </View>
  );
}

function TrendTable({ title, r }: { title: string; r: WidgetResult }) {
  const pts = r.points ?? [];
  const bars = barData(pts.map((p) => ({ key: p.date, label: p.date, value: p.value ?? 0 })));
  return (
    <View role="table" aria-label={title} style={{ marginTop: space(1) }}>
      <View role="row" style={{ flexDirection: 'row', borderBottomWidth: 1, borderColor: colors.border, paddingVertical: space(1) }}>
        <Text role="columnheader" style={{ width: 96, fontWeight: '700', color: colors.text }}>{m.colDay}</Text>
        <Text role="columnheader" style={{ width: 80, textAlign: 'right', fontWeight: '700', color: colors.text }}>{m.colOpenTasks}</Text>
        <Text role="columnheader" aria-hidden style={{ flex: 1 }} />
      </View>
      {pts.map((p, i) => (
        <View key={p.date} role="row" style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 2, borderBottomWidth: 1, borderColor: colors.border }}>
          <Text role="rowheader" style={{ width: 96, color: colors.text }}>{formatDate(p.date)}</Text>
          <Text role="cell" style={{ width: 80, textAlign: 'right', color: p.value === null ? colors.muted : colors.text }}>{p.value === null ? m.noSnapshot : widgetValue(p.value, r.unit)}</Text>
          <View role="cell" style={{ flex: 1, paddingLeft: space(2) }}>{p.value === null ? null : <Bar fraction={bars[i]!.fraction} />}</View>
        </View>
      ))}
    </View>
  );
}

function CardTable({ title, cards, onOpen }: { title: string; cards: DashboardCard[]; onOpen?: ((id: number) => void) | undefined }) {
  return (
    <View role="table" aria-label={title} style={{ marginTop: space(1) }}>
      <View role="row" style={{ flexDirection: 'row', borderBottomWidth: 1, borderColor: colors.border, paddingVertical: space(1) }}>
        <Text role="columnheader" style={{ flex: 3, fontWeight: '700', color: colors.text }}>{m.colCard}</Text>
        <Text role="columnheader" style={{ flex: 2, fontWeight: '700', color: colors.text, paddingHorizontal: space(1) }}>{m.colProject}</Text>
        <Text role="columnheader" style={{ width: 72, fontWeight: '700', color: colors.text }}>{t.due}</Text>
        <Text role="columnheader" style={{ width: 72, fontWeight: '700', color: colors.text }}>{m.status}</Text>
      </View>
      {cards.map((c) => {
        const state = c.done ? m.stateDoneOn(formatDate(c.done)) : c.archived ? m.stateArchived : m.stateOpen;
        return (
          <View key={c.id} role="row" style={{ flexDirection: 'row', alignItems: 'center', minHeight: 40, borderBottomWidth: 1, borderColor: colors.border }}>
            <View role="rowheader" style={{ flex: 3 }}>
              {onOpen ? (
                <Pressable accessibilityRole="button" accessibilityLabel={m.cardOpenLabel(c.title, c.boardTitle, c.stackTitle, c.due ? formatDate(c.due) : null, state)} onPress={() => onOpen(c.id)} style={{ minHeight: 40, justifyContent: 'center' }}>
                  <Text numberOfLines={2} style={{ color: colors.primary, fontWeight: '600' }}>{c.title}</Text>
                </Pressable>
              ) : (
                <Text numberOfLines={2} style={{ color: colors.text, fontWeight: '600' }}>{c.title}</Text>
              )}
            </View>
            <Text role="cell" numberOfLines={2} style={{ flex: 2, color: colors.muted, fontSize: font.small, paddingHorizontal: space(1) }}>{c.boardTitle} · {c.stackTitle}</Text>
            <Text role="cell" style={{ width: 72, color: colors.text, fontSize: font.small }}>{c.due ? formatDate(c.due) : '—'}</Text>
            <Text role="cell" style={{ width: 72, color: c.done ? colors.ok : colors.text, fontSize: font.small }}>{c.done ? m.stateDone : c.archived ? m.stateArchived : m.stateOpen}</Text>
          </View>
        );
      })}
    </View>
  );
}

function WidgetBody({ w, r, onDrill, onOpenTask }: { w: DashboardWidget; r: WidgetResult | undefined; onDrill?: ((key?: string, label?: string) => void) | undefined; onOpenTask?: ((id: number) => void) | undefined }) {
  const title = widgetTitle(w);
  const state = widgetState(r);
  if (!w.available || state === 'unavailable') return <Muted>{m.widgetUnavailable}</Muted>;
  if (!r) return <Muted>{m.awaitingResult}</Muted>;
  if (state === 'error') return <Text style={{ color: colors.danger }}>{r.message || m.widgetFailed}</Text>;
  if (state === 'restricted') return <Muted>{m.restrictedNoData}</Muted>;
  switch (r.kind) {
    case 'kpi': {
      const v = widgetValue(r.value, r.unit);
      return (
        <View accessible aria-label={r.value === null || r.value === undefined ? m.kpiLabelUnknown(title) : m.kpiLabel(title, v)}>
          <Text style={{ fontSize: font.h1, fontWeight: '700', color: colors.text }}>{v}</Text>
          {r.detail ? <Muted>{m.kpiCards(r.detail.done, r.detail.total)}</Muted> : null}
          {r.billableSec !== undefined ? <Muted>{m.billable(widgetValue(r.billableSec, 'seconds'))}</Muted> : null}
        </View>
      );
    }
    case 'distribution':
      return state === 'empty' ? <Muted>{m.noRecords}</Muted> : <DistributionTable title={title} r={r} onDrill={onDrill && r.drilldown ? (k, l) => onDrill(k, l) : undefined} />;
    case 'trend':
      return (
        <>
          {state === 'empty' ? <Muted>{m.noData}</Muted> : <TrendTable title={title} r={r} />}
          {r.coverage?.gaps.length ? <Muted>{m.snapshotGaps(r.coverage.gaps.length)}</Muted> : null}
        </>
      );
    case 'progress':
      return state === 'empty' ? <Muted>{m.noGoals}</Muted> : (
        <View>
          {(r.items ?? []).map((g) => (
            <View key={g.id} style={{ marginBottom: space(2) }}>
              <Text style={{ color: colors.text, fontWeight: '600' }}>{m.goalTitle(g.title, g.due ? formatDate(g.due) : null)}</Text>
              <ProgressBar bp={g.progressBp} label={g.title} />
              {g.state !== 'ok' ? <Muted>{g.state === 'restricted' ? m.goalRestricted : g.state === 'not_calculable' ? m.goalNotCalculable : g.state}</Muted> : null}
            </View>
          ))}
        </View>
      );
    case 'list':
      return state === 'empty' ? <Muted>{m.noCardsMatch}</Muted> : (
        <>
          <CardTable title={title} cards={r.rows ?? []} onOpen={onOpenTask} />
          {r.nextCursor && onDrill ? <Button title={m.openAllCards} kind="secondary" onPress={() => onDrill()} /> : null}
        </>
      );
    case 'text':
      // AI summary markdown is shown as plain text (never rendered as HTML).
      return state === 'empty' ? <Muted>{m.noSummary}</Muted> : <Text selectable style={{ color: colors.text }}>{r.markdown}</Text>;
    default:
      return <Muted>{m.widgetNotRenderable}</Muted>;
  }
}

function WidgetCard({ accountId, dashboardId, widget: w, result: r, canEdit, projectsEnabled, onOpenTask, onDrill, onEdit, onRemoved, onError }: {
  accountId: AccountId;
  dashboardId: number;
  widget: DashboardWidget;
  result: WidgetResult | undefined;
  canEdit: boolean;
  projectsEnabled: boolean;
  onOpenTask?: (cardId: number) => void;
  onDrill: (groupKey?: string, groupLabel?: string) => void;
  onEdit: () => void;
  onRemoved: () => void;
  onError: (e: unknown) => void;
}) {
  const { backend, platform } = useServices();
  const [busy, setBusy] = useState<'csv' | 'remove' | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [csvMsg, setCsvMsg] = useState<{ ok: boolean; text: string }>();
  const title = widgetTitle(w);
  const drill = canDrilldown(w);
  const openTask = projectsEnabled ? onOpenTask : undefined;

  const csv = async () => {
    setBusy('csv');
    setCsvMsg(undefined);
    try {
      const { filename, csv: text } = await backend.dashboardCsv(accountId, dashboardId, w.id, null);
      const res = await platform.saveFile!(filename, text, 'text/csv');
      setCsvMsg(res === 'saved' ? { ok: true, text: platform.kind === 'desktop' ? m.savedFile(filename) : m.shareSheetOpened } : { ok: false, text: t.errAborted });
    } catch (e) {
      setCsvMsg({ ok: false, text: dashboardError(e) });
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy('remove');
    try {
      await backend.dashboardWidgetDelete(accountId, dashboardId, w.id);
      onRemoved();
    } catch (e) {
      onError(e);
      setBusy(null);
    }
  };

  return (
    <View style={card}>
      <Text accessibilityRole="header" style={{ fontWeight: '700', color: colors.text }}>{title}</Text>
      <Muted>
        {m.widgetMeta(kindName(w.kind ?? '') ?? w.type, w.title ? w.label : null, !!r?.cached, r?.generatedAt ? dateTime(r.generatedAt) : null)}
      </Muted>
      <View style={{ marginVertical: space(2) }}>
        <WidgetBody w={w} r={r} onDrill={drill ? onDrill : undefined} onOpenTask={openTask} />
      </View>
      {r?.note ? <Muted>{r.note}</Muted> : null}
      {r?.partial ? <Muted>{m.partialResult}</Muted> : null}
      {r?.ignoredFilters?.length ? <Muted>{m.ignoredFilters(r.ignoredFilters.map((f) => filterName(f)).join(', '))}</Muted> : null}
      {drill && !projectsEnabled ? <Muted>{m.drillNeedsProjects}</Muted> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
        {drill && w.kind !== 'list' ? <Button title={m.openCards} accessibilityLabel={m.openCardsLabel(title)} kind="secondary" onPress={() => onDrill()} /> : null}
        {canExportCsv(w) && platform.saveFile ? <Button title="CSV" accessibilityLabel={m.downloadCsvLabel(title)} kind="secondary" busy={busy === 'csv'} onPress={() => void csv()} /> : null}
        {canEdit ? <Button title={t.edit} accessibilityLabel={m.editWidgetLabel(title)} kind="secondary" disabled={!w.available} onPress={onEdit} /> : null}
        {canEdit ? <Button title={m.remove} accessibilityLabel={m.removeWidgetLabel(title)} kind="danger" onPress={() => setConfirm(true)} /> : null}
      </View>
      {csvMsg ? <Alert text={csvMsg.text} ok={csvMsg.ok} /> : null}
      {confirm ? (
        <View style={{ marginTop: space(2) }}>
          <Text style={{ color: colors.text }}>{m.confirmRemoveWidget(title)}</Text>
          <View style={{ flexDirection: 'row', gap: space(2) }}>
            <Button title={m.confirmRemoveYes} kind="danger" busy={busy === 'remove'} onPress={() => void remove()} />
            <Button title={m.cancel} kind="secondary" onPress={() => setConfirm(false)} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

// ---- Drill-down --------------------------------------------------------------------------------

/** Cards behind a widget (or one distribution group): 50 per page, "Load more", row → task. */
export function DrilldownView({ accountId, dashboardId, widget, groupKey, groupLabel, projectsEnabled, onOpenTask, onClose }: {
  accountId: AccountId;
  dashboardId: number;
  widget: DashboardWidget;
  groupKey?: string;
  groupLabel?: string;
  projectsEnabled: boolean;
  onOpenTask?: (cardId: number) => void;
  onClose: () => void;
}) {
  const { backend } = useServices();
  const first = useAsync(() => backend.dashboardDrilldown(accountId, dashboardId, widget.id, groupKey !== undefined ? { groupKey } : {}), [accountId, dashboardId, widget.id, groupKey]);
  const [cards, setCards] = useState<DashboardCard[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => {
    if (first.data) {
      setCards(first.data.items);
      setCursor(first.data.nextCursor);
    }
  }, [first.data]);
  const more = async () => {
    if (!cursor) return;
    setBusy(true);
    setErr(undefined);
    try {
      const page = await backend.dashboardDrilldown(accountId, dashboardId, widget.id, { ...(groupKey !== undefined ? { groupKey } : {}), cursor });
      setCards((c) => mergeCards(c, page.items));
      setCursor(page.nextCursor);
    } catch (e) {
      setErr(dashboardError(e));
    } finally {
      setBusy(false);
    }
  };
  const title = `${widgetTitle(widget)}${groupLabel ? ` · ${groupLabel}` : ''}`;
  return (
    <ScrollView contentContainerStyle={{ padding: space(3), paddingBottom: space(8) }}>
      <Button title={m.backToDashboard} kind="secondary" onPress={onClose} />
      <View style={[card, { marginTop: space(2) }]}>
        <Text accessibilityRole="header" style={{ fontSize: font.title, fontWeight: '700', color: colors.text }}>{title}</Text>
        {first.data ? (
          <Muted>
            {m.drillMeta(cards.length, !!cursor, dateTime(first.data.asOf), first.data.partial)}
          </Muted>
        ) : null}
        {!projectsEnabled ? <Muted>{m.drillReadOnly}</Muted> : null}
        {first.error ? <Alert text={dashboardError(first.error)} /> : null}
        {first.loading && !first.data ? <Loading /> : null}
        {first.data?.restricted ? <Muted>{m.restrictedNoCards}</Muted> : null}
        {first.data && !first.data.restricted && cards.length === 0 ? <Muted>{m.noCards}</Muted> : null}
        {cards.length ? <CardTable title={title} cards={cards} onOpen={projectsEnabled ? onOpenTask : undefined} /> : null}
        <Alert text={err} />
        {cursor ? <Button title={m.loadMore} kind="secondary" busy={busy} onPress={() => void more()} /> : null}
      </View>
    </ScrollView>
  );
}

// ---- Editors -----------------------------------------------------------------------------------

/** Filter fields the app edits (others — column, label, assignee — are kept as they are). */
function FilterEditor({ value, onChange, boards, allowed }: { value: DashboardFilterForm; onChange: (f: DashboardFilterForm) => void; boards: Array<{ id: number; title: string }>; allowed: readonly string[] }) {
  const has = (k: string) => allowed.includes(k);
  const set = <K extends keyof DashboardFilterForm>(k: K, v: DashboardFilterForm[K]) => onChange({ ...value, [k]: v });
  const kept = Object.keys(value.keep ?? {});
  return (
    <View style={{ marginBottom: space(2) }}>
      {has('boardIds') && boards.length ? (
        <>
          <Text style={ui.label}>{m.filterProjects}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginBottom: space(2) }}>
            {boards.map((b) => (
              <Chip key={b.id} label={b.title} selected={value.boardIds.includes(b.id)} onPress={() => set('boardIds', value.boardIds.includes(b.id) ? value.boardIds.filter((x) => x !== b.id) : [...value.boardIds, b.id])} />
            ))}
          </View>
        </>
      ) : null}
      {has('doneState') ? (
        <>
          <Text style={ui.label}>{m.status}</Text>
          <View style={{ flexDirection: 'row', gap: space(2), marginBottom: space(2) }}>
            {([['any', m.filterAll], ['open', m.filterOpen], ['done', m.filterDone]] as const).map(([k, l]) => <Chip key={k} label={l} selected={value.doneState === k} onPress={() => set('doneState', k)} />)}
          </View>
        </>
      ) : null}
      {has('dueFrom') ? (
        <View style={{ flexDirection: 'row', gap: space(2) }}>
          <View style={{ flex: 1 }}><Field label={m.dueFromLabel} value={value.dueFrom} onChangeText={(v) => set('dueFrom', v)} maxLength={10} /></View>
          <View style={{ flex: 1 }}><Field label={m.dueToLabel} value={value.dueTo} onChangeText={(v) => set('dueTo', v)} maxLength={10} /></View>
        </View>
      ) : null}
      {has('createdFrom') ? (
        <View style={{ flexDirection: 'row', gap: space(2) }}>
          <View style={{ flex: 1 }}><Field label={m.createdFromLabel} value={value.createdFrom} onChangeText={(v) => set('createdFrom', v)} maxLength={10} /></View>
          <View style={{ flex: 1 }}><Field label={m.createdToLabel} value={value.createdTo} onChangeText={(v) => set('createdTo', v)} maxLength={10} /></View>
        </View>
      ) : null}
      {has('includeArchived') ? <Chip label={m.includeArchived} selected={value.includeArchived} onPress={() => set('includeArchived', !value.includeArchived)} /> : null}
      {kept.length ? <Muted>{m.keptFilters(kept.map((k) => filterName(k)).join(', '))}</Muted> : null}
      {!allowed.length ? <Muted>{m.noFilterSupport}</Muted> : null}
    </View>
  );
}

function DashboardEditor({ accountId, d, projectsEnabled, onDone, onError }: { accountId: AccountId; d: Dashboard; projectsEnabled: boolean; onDone: (ok: boolean) => void; onError: (e: unknown) => void }) {
  const { backend } = useServices();
  const [title, setTitle] = useState(d.title);
  const [description, setDescription] = useState(d.description);
  const [zone, setZone] = useState(d.zone);
  const [refreshSec, setRefreshSec] = useState(String(d.refreshSec));
  const [sources, setSources] = useState(d.sources.map((s) => s.id));
  const [filter, setFilter] = useState(() => filterToForm(d.filters));
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setErr(undefined);
    const f = buildDashboardFilter(filter);
    if ('error' in f) return setErr(m.filterFieldError(filterError(f.error), filterName(f.field)));
    const r = buildDashboardPatch(d, { title, description, zone, refreshSec, sources, filters: f.filter });
    if ('error' in r) {
      const text = { title_required: m.titleRequired, title_too_long: m.titleTooLong, description_too_long: m.descriptionTooLong, refresh_range: m.errRefreshRange, zone_invalid: m.errInvalidZone, too_many_sources: m.limitSources }[r.error];
      return setErr(text);
    }
    if (!r.patch) return onDone(false);
    setBusy(true);
    try {
      await backend.dashboardUpdate(accountId, d.id, r.patch);
      onDone(true);
    } catch (e) {
      setBusy(false);
      onError(e);
    }
  };
  return (
    <View style={card}>
      <H>{m.editDashboard}</H>
      <Field label={m.title} value={title} onChangeText={setTitle} maxLength={200} />
      <Field label={m.description} value={description} onChangeText={setDescription} maxLength={2000} multiline />
      <Field label={m.fieldZone} value={zone} onChangeText={setZone} maxLength={64} autoCapitalize="none" />
      <Field label={m.fieldRefresh} value={refreshSec} onChangeText={setRefreshSec} keyboardType="number-pad" maxLength={6} />
      {projectsEnabled ? <SourcePicker accountId={accountId} value={sources} onChange={setSources} hidden={d.sources} /> : <Muted>{m.sourcesNeedProjects}</Muted>}
      {d.sourcesPartial ? <Muted>{m.sourcesHiddenKept}</Muted> : null}
      <H>{m.globalFilter}</H>
      <FilterEditor value={filter} onChange={setFilter} boards={d.sources} allowed={DASHBOARD_FILTER_FIELDS} />
      <Alert text={err} />
      <View style={{ flexDirection: 'row', gap: space(2) }}>
        <Button title={t.save} busy={busy} onPress={() => void save()} />
        <Button title={m.cancel} kind="secondary" onPress={() => onDone(false)} />
      </View>
    </View>
  );
}

function ConfigFields({ schema, value, onChange }: { schema: Record<string, ConfigFieldSchema>; value: ConfigForm; onChange: (v: ConfigForm) => void }) {
  const entries = Object.entries(schema);
  if (!entries.length) return null;
  return (
    <View style={{ marginBottom: space(2) }}>
      {entries.map(([k, f]) => {
        if (f.type === 'enum') {
          return (
            <View key={k} style={{ marginBottom: space(2) }}>
              <Text style={ui.label}>{f.label}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
                {f.options.map((o) => <Chip key={o.value} label={o.label} selected={value[k] === o.value} onPress={() => onChange({ ...value, [k]: o.value })} />)}
              </View>
            </View>
          );
        }
        if (f.type === 'bool') return <Chip key={k} label={f.label} selected={value[k] === true} onPress={() => onChange({ ...value, [k]: value[k] !== true })} />;
        if (f.type === 'int') return <Field key={k} label={`${f.label} (${f.min}–${f.max})`} value={String(value[k] ?? '')} onChangeText={(v) => onChange({ ...value, [k]: v })} keyboardType="number-pad" maxLength={10} />;
        return <Field key={k} label={m.idListFieldLabel(f.label, f.max)} value={String(value[k] ?? '')} onChangeText={(v) => onChange({ ...value, [k]: v })} maxLength={1000} />;
      })}
    </View>
  );
}

/** Add (type picker) or edit a widget: title, schema-driven settings, widget filter, size. */
function WidgetEditor({ accountId, d, widget, onDone, onError }: { accountId: AccountId; d: Dashboard; widget?: DashboardWidget; onDone: (ok: boolean) => void; onError: (e: unknown) => void }) {
  const { backend } = useServices();
  const types = useAsync(() => backend.dashboardWidgetTypes(accountId), [accountId]);
  const [type, setType] = useState<string | null>(widget?.type ?? null);
  const def: WidgetTypeDef | undefined = types.data?.find((t) => t.type === type);
  const [title, setTitle] = useState(widget?.title ?? '');
  const [config, setConfig] = useState<ConfigForm | null>(null);
  const [filter, setFilter] = useState<DashboardFilterForm>(() => filterToForm(widget?.filter ?? {}));
  const [w, setW] = useState(widget?.w ?? 6);
  const [h, setH] = useState(widget?.h ?? 2);
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  // Config form follows the chosen type's schema (existing values when editing).
  useEffect(() => {
    if (def) setConfig(configToForm(def.config ?? {}, widget && widget.type === def.type ? widget.config : {}));
  }, [def?.type]);
  const pick = (t: WidgetTypeDef) => {
    setType(t.type);
    if (!widget) {
      setW(t.kind === 'kpi' ? 3 : 6);
      setH(t.kind === 'kpi' ? 1 : 2);
    }
  };

  const save = async () => {
    if (!def || !config) return;
    setErr(undefined);
    const c = buildWidgetConfig(def.config ?? {}, config);
    if ('error' in c) return setErr(m.configFieldError(def.config[c.field]?.label ?? c.field, configError(c.error)));
    const f = buildDashboardFilter(filter, def.filters);
    if ('error' in f) return setErr(m.filterFieldError(filterError(f.error), filterName(f.field)));
    setBusy(true);
    try {
      if (widget) {
        const patch = buildWidgetPatch(widget, { title, config: c.config, filter: f.filter, w, h });
        if (!patch) return onDone(false);
        await backend.dashboardWidgetUpdate(accountId, d.id, widget.id, patch);
      } else {
        await backend.dashboardWidgetAdd(accountId, d.id, {
          type: def.type, w, h,
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(Object.keys(c.config).length ? { config: c.config } : {}),
          ...(Object.keys(f.filter).length ? { filter: f.filter } : {}),
        });
      }
      onDone(true);
    } catch (e) {
      setBusy(false);
      onError(e);
    }
  };

  const full = !widget && d.widgets.length >= (d.limits?.widgets ?? 20);
  return (
    <View style={card}>
      <H>{widget ? m.editWidgetTitle(widgetTitle(widget)) : m.addWidget}</H>
      {full ? <Alert text={m.errTooManyWidgets} /> : null}
      {types.error ? <Alert text={dashboardError(types.error)} /> : null}
      {types.loading && !types.data ? <Loading /> : null}
      {!widget && types.data ? (
        <>
          <Text style={ui.label}>{m.type}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginBottom: space(2) }}>
            {types.data.map((t) => <Chip key={t.type} label={`${t.label} (${kindName(t.kind) ?? t.kind})`} selected={type === t.type} onPress={() => pick(t)} />)}
          </View>
        </>
      ) : null}
      {widget && types.data && !def ? <Alert text={m.widgetTypeGone} /> : null}
      {def && config ? (
        <>
          <Field label={m.widgetTitleField(def.label)} value={title} onChangeText={setTitle} maxLength={200} />
          <ConfigFields schema={def.config ?? {}} value={config} onChange={setConfig} />
          {def.filters.length ? <H>{m.widgetFilter}</H> : null}
          <FilterEditor value={filter} onChange={setFilter} boards={d.sources} allowed={def.filters} />
          <Text style={ui.label}>{m.widthLabel}</Text>
          <View style={{ flexDirection: 'row', gap: space(2), marginBottom: space(2) }}>
            {([[3, m.widthQuarter], [6, m.widthHalf], [12, m.widthFull]] as const).map(([n, l]) => <Chip key={n} label={l} selected={w === n} onPress={() => setW(n)} />)}
          </View>
          <Text style={ui.label}>{m.height}</Text>
          <View style={{ flexDirection: 'row', gap: space(2), marginBottom: space(2) }}>
            {[1, 2, 3, 4].map((n) => <Chip key={n} label={String(n)} selected={h === n} onPress={() => setH(n)} />)}
          </View>
        </>
      ) : null}
      <Alert text={err} />
      <View style={{ flexDirection: 'row', gap: space(2) }}>
        <Button title={widget ? t.save : m.add} busy={busy} disabled={!def || !config || full} onPress={() => void save()} />
        <Button title={m.cancel} kind="secondary" onPress={() => onDone(false)} />
      </View>
    </View>
  );
}

