import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { type AccountId, type ProjectSummary, type ServerBase, type WorkhubBootstrap } from '@workhub-devices/core';
import { useAsync, useServices } from './services';
import { ProjectsScreen } from './workhub';
import { SharesEditor } from './projectAdmin';
import { Button, Empty, ErrorBanner, Loading, Row, card, styles as ui } from './ui';
import { colors, font, space } from './theme';
import { formatDate } from './i18n';
import { TimeScreen } from './time';

const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

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
      {section === 'requests' ? <RequestsScreen accountId={accountId} /> : null}
      {section === 'goals' ? <GoalsScreen accountId={accountId} /> : null}
      {section === 'more' ? <MoreScreen serverBase={serverBase} workhub={workhub} /> : null}
    </View>
  );
}

const REQUEST_STATE: Record<string, string> = { pending: 'Onay bekliyor', open: 'Açık', rejected: 'Reddedildi', converted: 'Göreve dönüştü', resolved: 'Çözüldü' };

export function RequestsScreen({ accountId }: { accountId: AccountId }) {
  const { backend } = useServices();
  const [scope, setScope] = useState<'mine' | 'received'>('mine');
  const list = useAsync(() => backend.requests(accountId, scope), [accountId, scope]);
  const ctx = useAsync(() => backend.requestContext(accountId), [accountId]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const create = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await backend.createRequest(accountId, title.trim(), description.trim(), null, uuid());
      setTitle('');
      setDescription('');
      list.reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScrollView contentContainerStyle={{ padding: space(3) }}>
      <View style={{ flexDirection: 'row', gap: space(2), marginBottom: space(2) }}>
        {(['mine', 'received'] as const).map((s) => (
          <Pressable key={s} accessibilityRole="tab" accessibilityState={{ selected: scope === s }} onPress={() => setScope(s)} style={{ paddingVertical: space(1), paddingHorizontal: space(3), borderRadius: 16, backgroundColor: scope === s ? colors.primary : colors.surface }}>
            <Text style={{ color: scope === s ? colors.primaryText : colors.text }}>{s === 'mine' ? 'Gönderdiklerim' : 'Bana gelenler'}</Text>
          </Pressable>
        ))}
      </View>
      <ErrorBanner error={list.error ?? err} onRetry={list.reload} />
      {list.loading && !list.data ? <Loading /> : null}
      {(list.data ?? []).length === 0 && !list.loading ? <Text style={{ color: colors.muted, marginBottom: space(3) }}>Talep yok.</Text> : null}
      {(list.data ?? []).map((r) => (
        <View key={r.id} style={card}>
          <Text style={{ fontWeight: '700', color: colors.text }}>{r.title}</Text>
          <Text style={{ color: colors.muted }}>
            {REQUEST_STATE[r.state] ?? r.state} · {scope === 'mine' ? `→ ${r.recipientName}` : `← ${r.requesterName}`} · {formatDate(r.createdAt)}
          </Text>
          {r.description ? <Text style={{ marginTop: space(1), color: colors.text }}>{r.description}</Text> : null}
        </View>
      ))}
      {scope === 'mine' ? (
        <View style={card}>
          <Text accessibilityRole="header" style={{ fontWeight: '700', marginBottom: space(2) }}>
            Yeni talep
          </Text>
          {ctx.data && !ctx.data.manager ? (
            <Text style={{ color: colors.muted }}>Yöneticiniz tanımlı değil; talep gönderebilmek için yöneticinizin tanımlanması gerekir.</Text>
          ) : (
            <>
              <Text style={{ color: colors.muted, marginBottom: space(2) }}>Alıcı: {ctx.data?.manager?.displayName ?? '…'}</Text>
              <TextInput accessibilityLabel="Başlık" placeholder="Başlık" placeholderTextColor={colors.muted} value={title} onChangeText={setTitle} style={[ui.input, { marginBottom: space(2) }]} />
              <TextInput accessibilityLabel="Açıklama" placeholder="Açıklama" placeholderTextColor={colors.muted} value={description} onChangeText={setDescription} multiline style={[ui.input, { minHeight: 80, paddingTop: 10 }]} />
              <Button title="Gönder" busy={busy} disabled={!title.trim()} onPress={() => void create()} />
            </>
          )}
        </View>
      ) : (
        <Text style={{ color: colors.muted, fontSize: font.small }}>Onay/red ve göreve dönüştürme şimdilik web'de (Diğer → Talepler).</Text>
      )}
    </ScrollView>
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
    ['Talepler: yanıt ve dönüştürme', 'requests', 'Onay/red, göreve dönüştürme, rapor', workhub.modules.requests],
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
