import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { type AccountId, type ProjectSummary, type ServerBase, type WorkhubBootstrap } from '@workhub-devices/core';
import { useServices } from './services';
import { ProjectsScreen } from './workhub';
import { Row } from './ui';
import { colors, space } from './theme';
import { TimeScreen } from './time';
import { RequestsScreen } from './requests';
import { GoalsScreen } from './goals';
import { WorkloadScreen } from './views';
import { DashboardsScreen } from './dashboards';
import { WorkflowsScreen } from './workflows';
import { AiScreen } from './ai';

type Section = 'projects' | 'workload' | 'workflows' | 'dashboards' | 'time' | 'requests' | 'goals' | 'ai' | 'more';

/** Workhub home: every enabled module, gated per user by the Workhub bootstrap (fail closed). */
export function WorkhubHome({ accountId, serverBase, workhub, selectedProject, onOpenProject, onOpenTask, version }: {
  version?: number;
  accountId: AccountId;
  serverBase: ServerBase;
  workhub: WorkhubBootstrap;
  selectedProject?: number;
  onOpenProject: (p: Pick<ProjectSummary, 'id' | 'title'>) => void;
  onOpenTask?: (cardId: number) => void;
}) {
  const sections = (
    [
      ['projects', 'Projeler', workhub.modules.projects],
      ['workload', 'İş yükü', workhub.modules.projects],
      ['workflows', 'İş akışları', workhub.modules.projects],
      ['dashboards', 'Dashboard', workhub.modules.dashboard],
      ['time', 'Zaman', workhub.modules.time],
      ['requests', 'Talepler', workhub.modules.requests],
      ['goals', 'Hedefler', workhub.modules.goals],
      ['ai', 'AI', workhub.modules.ai],
      // Only server administration remains on the web (password confirmation; see docs/workhub-modules.md).
      ['more', 'Yönetim', workhub.user.isAdmin],
    ] as const
  ).filter(([, , on]) => on);
  const [section, setSection] = useState<Section>(sections[0]?.[0] ?? 'more');
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, borderBottomWidth: 1, borderColor: colors.border }} contentContainerStyle={{ paddingHorizontal: space(2) }}>
        {sections.map(([key, label]) => (
          <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected: section === key }} onPress={() => setSection(key)} style={{ paddingHorizontal: space(3), paddingVertical: space(3), borderBottomWidth: 2, borderColor: section === key ? colors.primary : 'transparent' }}>
            <Text style={{ color: section === key ? colors.primary : colors.muted, fontWeight: section === key ? '700' : '400' }}>{label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {section === 'projects' ? <ProjectsScreen accountId={accountId} {...(selectedProject ? { selected: selectedProject } : {})} {...(version !== undefined ? { version } : {})} onOpen={onOpenProject} /> : null}
      {section === 'workload' ? <WorkloadScreen accountId={accountId} {...(onOpenTask ? { onOpenTask } : {})} /> : null}
      {section === 'workflows' ? <WorkflowsScreen accountId={accountId} {...(onOpenTask ? { onOpenTask } : {})} /> : null}
      {section === 'dashboards' ? <DashboardsScreen accountId={accountId} projectsEnabled={workhub.modules.projects} {...(onOpenTask ? { onOpenTask } : {})} /> : null}
      {section === 'time' ? <TimeScreen accountId={accountId} canReview={workhub.permissions.canViewTeamReport} projectsEnabled={workhub.modules.projects} /> : null}
      {section === 'requests' ? <RequestsScreen accountId={accountId} timeEnabled={workhub.modules.time} /> : null}
      {section === 'goals' ? <GoalsScreen accountId={accountId} /> : null}
      {section === 'ai' ? <AiScreen accountId={accountId} projectsEnabled={workhub.modules.projects} {...(onOpenTask ? { onOpenTask } : {})} /> : null}
      {section === 'more' ? <MoreScreen serverBase={serverBase} workhub={workhub} /> : null}
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
