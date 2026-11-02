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

type Section = 'projects' | 'workload' | 'time' | 'requests' | 'goals' | 'more';

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
      ['time', 'Zaman', workhub.modules.time],
      ['requests', 'Talepler', workhub.modules.requests],
      ['goals', 'Hedefler', workhub.modules.goals],
      ['more', 'Diğer', true],
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
      {section === 'time' ? <TimeScreen accountId={accountId} canReview={workhub.permissions.canViewTeamReport} /> : null}
      {section === 'requests' ? <RequestsScreen accountId={accountId} timeEnabled={workhub.modules.time} /> : null}
      {section === 'goals' ? <GoalsScreen accountId={accountId} /> : null}
      {section === 'more' ? <MoreScreen serverBase={serverBase} workhub={workhub} /> : null}
    </View>
  );
}

/** Modules without a native screen yet: explicit gap + safe web fallback (opens the user's own server). */
export function MoreScreen({ serverBase, workhub }: { serverBase: ServerBase; workhub: WorkhubBootstrap }) {
  const { platform } = useServices();
  const items: Array<[string, string, string, boolean]> = [
    ['Dashboard\'lar ve widget\'lar', 'dashboards', 'Widget sorguları, drilldown, CSV', workhub.modules.dashboard],
    ['İş akışları', 'workflows', 'Şablonlar, çalıştırmalar, devir', workhub.modules.projects],
    ['Zaman: görev bağlama ve panolar', 'time', 'Kayda görev bağlama, zaman widget\'ları', workhub.modules.time],
    ['Hedef widget\'ları', 'dashboards', 'Dashboard\'da hedef ilerleme widget\'ı', workhub.modules.goals && workhub.modules.dashboard],
    ['AI', 'ai', 'Öneri ve taslaklar', workhub.modules.ai],
    ['Yönetim', 'settings', 'Modül, iş yükü, zaman politikası, AI sağlayıcı', workhub.user.isAdmin],
  ];
  return (
    <ScrollView>
      <Text style={{ padding: space(4), color: colors.muted }}>
        Bu bölümler henüz uygulama içinde değil. Sunucunuzun Workhub web arayüzünde açılır (geçici çözüm, kayıtlı açık iş).
      </Text>
      {items
        .filter(([, , , on]) => on)
        .map(([title, path, sub]) => (
          <Row key={path + title} title={`${title} ↗`} subtitle={sub} onPress={() => void platform.openExternal(`${serverBase}/apps/workhub/${path}`)} />
        ))}
    </ScrollView>
  );
}
