import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { type AccountId, type ProjectSummary, type ServerBase, type WorkhubBootstrap } from '@workhub-devices/core';
import { useAsync, useServices } from './services';
import { Icon, type IconName } from './icons';
import { ProjectsScreen } from './workhub';
import { Row } from './ui';
import { colors, font, hexColor, radius, space } from './theme';
import { TimeScreen } from './time';
import { RequestsScreen } from './requests';
import { GoalsScreen } from './goals';
import { WorkloadScreen } from './views';
import { DashboardsScreen } from './dashboards';
import { WorkflowsScreen } from './workflows';
import { AiScreen } from './ai';

export type Section = 'projects' | 'workload' | 'workflows' | 'dashboards' | 'time' | 'requests' | 'goals' | 'ai' | 'more';

/** Module navigation in the web app's order (`App.vue`), each gated by the per-user bootstrap. */
export function workhubSections(workhub: WorkhubBootstrap): { key: Section; label: string; icon: IconName }[] {
  return (
    [
      ['projects', 'Projeler', 'projects', workhub.modules.projects],
      ['workload', 'İş yükü', 'users', workhub.modules.projects],
      ['workflows', 'İş akışları', 'workflow', workhub.modules.projects],
      ['dashboards', 'Dashboard', 'dashboard', workhub.modules.dashboard],
      ['ai', 'AI asistanı', 'ai', workhub.modules.ai],
      ['goals', 'Hedefler', 'goals', workhub.modules.goals],
      ['requests', 'Talepler', 'requests', workhub.modules.requests],
      ['time', 'Zaman', 'clock', workhub.modules.time],
      // Only server administration remains on the web (password confirmation; see docs/workhub-modules.md).
      ['more', 'Yönetim', 'admin', workhub.user.isAdmin],
    ] as const
  )
    .filter(([, , , on]) => on)
    .map(([key, label, icon]) => ({ key, label, icon }));
}

interface ModuleProps {
  version?: number;
  accountId: AccountId;
  serverBase: ServerBase;
  workhub: WorkhubBootstrap;
  selectedProject?: number;
  onOpenProject: (p: Pick<ProjectSummary, 'id' | 'title'>) => void;
  onOpenTask?: (cardId: number) => void;
}

export function SectionContent({ section, accountId, serverBase, workhub, selectedProject, onOpenProject, onOpenTask, version }: ModuleProps & { section: Section }) {
  switch (section) {
    case 'projects':
      return <ProjectsScreen accountId={accountId} {...(selectedProject ? { selected: selectedProject } : {})} {...(version !== undefined ? { version } : {})} onOpen={onOpenProject} />;
    case 'workload':
      return <WorkloadScreen accountId={accountId} {...(onOpenTask ? { onOpenTask } : {})} />;
    case 'workflows':
      return <WorkflowsScreen accountId={accountId} {...(onOpenTask ? { onOpenTask } : {})} />;
    case 'dashboards':
      return <DashboardsScreen accountId={accountId} projectsEnabled={workhub.modules.projects} {...(onOpenTask ? { onOpenTask } : {})} />;
    case 'time':
      return <TimeScreen accountId={accountId} canReview={workhub.permissions.canViewTeamReport} projectsEnabled={workhub.modules.projects} />;
    case 'requests':
      return <RequestsScreen accountId={accountId} timeEnabled={workhub.modules.time} />;
    case 'goals':
      return <GoalsScreen accountId={accountId} />;
    case 'ai':
      return <AiScreen accountId={accountId} projectsEnabled={workhub.modules.projects} {...(onOpenTask ? { onOpenTask } : {})} />;
    case 'more':
      return <MoreScreen serverBase={serverBase} workhub={workhub} />;
  }
}

/** Phone / narrow Workhub home: icon tabs over the selected module. */
export function WorkhubHome(props: ModuleProps) {
  const sections = workhubSections(props.workhub);
  const [section, setSection] = useState<Section>(sections[0]?.key ?? 'more');
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="tablist" style={{ flexGrow: 0, borderBottomWidth: 1, borderColor: colors.border }} contentContainerStyle={{ paddingHorizontal: space(2) }}>
        {sections.map(({ key, label, icon }) => (
          <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected: section === key }} onPress={() => setSection(key)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space(3), paddingVertical: space(3), borderBottomWidth: 2, borderColor: section === key ? colors.primary : 'transparent' }}>
            <Icon name={icon} size={16} color={section === key ? colors.primary : colors.muted} />
            <Text style={{ color: section === key ? colors.primary : colors.muted, fontWeight: section === key ? '700' : '500' }}>{label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <SectionContent {...props} section={section} />
    </View>
  );
}

function NavItem({ icon, label, selected, onPress, dot, indent, right, a11y }: { icon?: IconName; label: string; selected: boolean; onPress: () => void; dot?: string; indent?: boolean; right?: string; a11y?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      {...(a11y ? { accessibilityLabel: a11y } : {})}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: 'row', alignItems: 'center', gap: space(2), minHeight: 40, marginHorizontal: space(2), paddingLeft: indent ? space(7) : space(3), paddingRight: space(3), borderRadius: radius.md,
        backgroundColor: selected ? colors.primarySoft : pressed || hovered ? colors.border : 'transparent',
      })}
    >
      {dot ? <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: dot, marginHorizontal: 5 }} /> : icon ? <Icon name={icon} size={18} color={selected ? colors.primary : colors.muted} /> : null}
      <Text numberOfLines={1} style={{ flex: 1, color: selected ? colors.primaryStrong : colors.text, fontWeight: selected ? '700' : '500', fontSize: 14 }}>
        {label}
      </Text>
      {right ? <Text style={{ color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] }}>{right}</Text> : null}
    </Pressable>
  );
}

/**
 * Wide (desktop / tablet) Workhub: the web app's left navigation — modules with icons, the
 * project list as coloured sub-items — next to the selected module or project workspace.
 * The project/task panes are rendered by the caller in `children`.
 */
export function WorkhubWide({ accountId, serverBase, workhub, version, project, onOpenProject, onOpenTask, children, drawer }: {
  accountId: AccountId;
  serverBase: ServerBase;
  workhub: WorkhubBootstrap;
  version?: number;
  project: number | null;
  onOpenProject: (p: Pick<ProjectSummary, 'id' | 'title'> | null) => void;
  onOpenTask: (cardId: number) => void;
  /** Project workspace when a project is open. */
  children?: ReactNode;
  /** Task detail shown as a right-hand drawer (web `TaskDrawer.vue`). */
  drawer?: ReactNode;
}) {
  const { backend } = useServices();
  const sections = workhubSections(workhub);
  const [section, setSection] = useState<Section>(sections[0]?.key ?? 'more');
  const [projectsOpen, setProjectsOpen] = useState(true);
  const projects = useAsync(() => (workhub.modules.projects ? backend.projects(accountId) : Promise.resolve([])), [accountId, version, workhub.modules.projects]);
  const navProjects = (projects.data ?? []).filter((p) => !p.archived).slice(0, 30);
  return (
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: colors.surface }}>
      <View accessibilityRole="navigation" accessibilityLabel="Workhub gezinmesi" style={{ width: 256, backgroundColor: colors.nav, borderRightWidth: 1, borderColor: colors.border }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), paddingHorizontal: space(4), minHeight: 56 }}>
          <Icon name="tasks" size={22} color={colors.primary} />
          <Text accessibilityRole="header" style={{ fontSize: font.title, fontWeight: '800', color: colors.textStrong }}>
            Workhub
          </Text>
        </View>
        <ScrollView contentContainerStyle={{ paddingBottom: space(4), gap: 2 }}>
          {sections.map(({ key, label, icon }) => (
            <View key={key}>
              <NavItem
                icon={icon}
                label={label}
                selected={section === key && (key !== 'projects' || project === null)}
                onPress={() => {
                  setSection(key);
                  onOpenProject(null);
                  if (key === 'projects') setProjectsOpen(true);
                }}
              />
              {key === 'projects' && projectsOpen
                ? navProjects.map((p) => (
                    <NavItem
                      key={p.id}
                      indent
                      dot={hexColor(p.color)}
                      label={p.title}
                      right={String(p.openCount)}
                      a11y={`${p.title}, ${p.openCount} açık görev`}
                      selected={project === p.id}
                      onPress={() => {
                        setSection('projects');
                        onOpenProject(p);
                      }}
                    />
                  ))
                : null}
            </View>
          ))}
        </ScrollView>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        {project !== null && children ? (
          children
        ) : (
          <View style={{ flex: 1, backgroundColor: colors.bg }}>
            <SectionContent
              section={section}
              accountId={accountId}
              serverBase={serverBase}
              workhub={workhub}
              {...(version !== undefined ? { version } : {})}
              onOpenProject={(p) => onOpenProject(p)}
              onOpenTask={onOpenTask}
            />
          </View>
        )}
      </View>
      {drawer ? <View style={{ width: 460, borderLeftWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, shadowColor: '#0f172a', shadowOpacity: 0.12, shadowRadius: 16, shadowOffset: { width: -4, height: 0 } }}>{drawer}</View> : null}
    </View>
  );
}

/**
 * Server administration (Nextcloud admins only). Every Workhub admin write is
 * `#[PasswordConfirmationRequired]`; with the per-device app password the server answers 403
 * "Password confirmation is required", and confirming would mean handling the admin's main
 * password in the app — which this app never does. So administration stays in the web UI of
 * the user's own server (approved decision, docs/workhub-modules.md → Yönetim).
 */
export function MoreScreen({ serverBase, workhub }: { serverBase: ServerBase; workhub: WorkhubBootstrap }) {
  const { platform } = useServices();
  if (!workhub.user.isAdmin) return null;
  // Nextcloud admin settings → Workhub section (`OCA\Workhub\Settings\AdminSection`); `/index.php/` works with and without pretty URLs.
  const url = `${serverBase}/index.php/settings/admin/workhub`;
  return (
    <ScrollView>
      <Text style={{ padding: space(4), color: colors.muted }}>
        Workhub yönetimi sunucunuzun web arayüzünde (Yönetim ayarları → Workhub) yapılır: her değişiklik Nextcloud parola onayı ister ve bu uygulama yönetici parolanızı almaz, saklamaz.
      </Text>
      <Row title="Workhub yönetim ayarları ↗" subtitle="Modüller ve grup kısıtları, AI sağlayıcısı ve kullanım, zaman politikası, iş yükü kapasitesi, Deck içe aktarma" onPress={() => void platform.openExternal(url)} />
    </ScrollView>
  );
}
