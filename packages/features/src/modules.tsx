import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { type AccountId, type ProjectSummary, type ServerBase, type WorkhubBootstrap } from '@workhub-devices/core';
import { useAsync, useServices } from './services';
import { ProjectsScreen } from './workhub';
import { SharesEditor } from './projectAdmin';
import { Button, Empty, ErrorBanner, Loading, Row, card } from './ui';
import { colors, font, space } from './theme';
import { TimeScreen } from './time';
import { RequestsScreen } from './requests';

type Section = 'projects' | 'time' | 'requests' | 'goals' | 'more';

/** Workhub home: every enabled module, gated per user by the Workhub bootstrap (fail closed). */
export function WorkhubHome({ accountId, serverBase, workhub, selectedProject, onOpenProject, version }: {
  version?: number;
  accountId: AccountId;
  serverBase: ServerBase;
  workhub: WorkhubBootstrap;
  selectedProject?: number;
  onOpenProject: (p: Pick<ProjectSummary, 'id' | 'title'>) => void;
}) {
  const sections = (
    [
      ['projects', 'Projeler', workhub.modules.projects],
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
      {section === 'time' ? <TimeScreen accountId={accountId} canReview={workhub.permissions.canViewTeamReport} /> : null}
      {section === 'requests' ? <RequestsScreen accountId={accountId} timeEnabled={workhub.modules.time} /> : null}
      {section === 'goals' ? <GoalsScreen accountId={accountId} /> : null}
      {section === 'more' ? <MoreScreen serverBase={serverBase} workhub={workhub} /> : null}
    </View>
  );
}

export function GoalsScreen({ accountId }: { accountId: AccountId }) {
  const { backend } = useServices();
  const s = useAsync(() => backend.goals(accountId), [accountId]);
  const [sharing, setSharing] = useState<number | null>(null);
  if (s.loading && !s.data) return <Loading />;
  return (
    <ScrollView contentContainerStyle={{ padding: space(3) }}>
      <ErrorBanner error={s.error} onRetry={s.reload} />
      {(s.data ?? []).length === 0 && !s.error ? <Empty text="Hedef yok." /> : null}
      {(s.data ?? []).map((g) => {
        const pct = g.progressBp === null ? null : Math.round(g.progressBp / 100);
        return (
          <View key={g.id} style={card} accessible accessibilityLabel={`${g.title}, ilerleme ${pct ?? 'bilinmiyor'} yüzde`}>
            <Text style={{ fontWeight: '700', color: colors.text }}>{g.title}</Text>
            <Text style={{ color: colors.muted }}>
              {g.owner.displayName} · {g.state}
            </Text>
            <View style={{ height: 8, backgroundColor: colors.surface, borderRadius: 4, marginTop: space(2), overflow: 'hidden' }}>
              <View style={{ height: 8, width: `${Math.min(100, Math.max(0, pct ?? 0))}%`, backgroundColor: colors.primary }} />
            </View>
            <Text style={{ color: colors.muted, fontSize: font.small, marginTop: 2 }}>{pct === null ? '—' : `%${pct}`}</Text>
            {g.canManage && sharing !== g.id ? <Button title="Paylaş" accessibilityLabel={`Paylaş: ${g.title}`} kind="secondary" onPress={() => setSharing(g.id)} /> : null}
            {sharing === g.id ? <SharesEditor accountId={accountId} type="goal" objectId={g.id} onClose={() => setSharing(null)} /> : null}
          </View>
        );
      })}
      <Text style={{ color: colors.muted, fontSize: font.small }}>Hedef oluşturma, check-in ve kart bağlama şimdilik web'de (Diğer → Hedefler).</Text>
    </ScrollView>
  );
}

/** Modules without a native screen yet: explicit gap + safe web fallback (opens the user's own server). */
export function MoreScreen({ serverBase, workhub }: { serverBase: ServerBase; workhub: WorkhubBootstrap }) {
  const { platform } = useServices();
  const items: Array<[string, string, string, boolean]> = [
    ['Dashboard\'lar ve widget\'lar', 'dashboards', 'Widget sorguları, drilldown, CSV', workhub.modules.dashboard],
    ['İş yükü', 'workload', 'Ekip kapasite matrisi', workhub.modules.projects],
    ['Gantt ve etkinlik', 'projects', 'Proje Gantt ve etkinlik akışı', workhub.modules.projects],
    ['İş akışları', 'workflows', 'Şablonlar, çalıştırmalar, devir', workhub.modules.projects],
    ['Zaman: görev bağlama ve panolar', 'time', 'Kayda görev bağlama, zaman widget\'ları', workhub.modules.time],
    ['Hedefler: düzenleme', 'goals', 'Hedef/target, check-in, kart bağlantısı', workhub.modules.goals],
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
