import type { ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { colors, font, radius, space } from './theme';
import { Icon } from './icons';
import { describeError, t } from './i18n';

/**
 * KeyboardAvoidingView behaviour per platform. Only iOS uses it: on Android (edge-to-edge is
 * mandatory from Android 15/16, so `adjustResize` no longer shrinks the window) the mobile shell
 * pads the whole app by the IME inset once (`apps/mobile/src/keyboard.ts`). KAV on Android
 * measured its parent-relative frame and under-shot by the header/status-bar offset, so the
 * composer sat partly under the keyboard. Desktop (RN Web) has no on-screen keyboard.
 */
export const keyboardAvoidBehavior: 'padding' | undefined = Platform.OS === 'ios' ? 'padding' : undefined;

export function Button({ title, onPress, kind = 'primary', disabled, busy, accessibilityHint, accessibilityLabel }: {
  title: string;
  accessibilityLabel?: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  accessibilityHint?: string;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      {...(accessibilityHint ? { accessibilityHint } : {})}
      {...(accessibilityLabel ? { accessibilityLabel } : {})}
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [
        styles.button,
        kind === 'primary' && styles.primary,
        kind === 'secondary' && styles.secondary,
        kind === 'danger' && styles.dangerBtn,
        (pressed || off) && { opacity: 0.6 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={kind === 'primary' ? colors.primaryText : colors.primary} />
      ) : (
        <Text style={[styles.buttonText, kind !== 'primary' && { color: kind === 'danger' ? colors.danger : colors.primary }]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label: string }) {
  const { label, style, ...rest } = props;
  return (
    <View style={{ marginBottom: space(3) }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor={colors.muted} style={[styles.input, style]} {...rest} />
    </View>
  );
}

export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <View accessibilityRole="alert" style={styles.error}>
      <Text style={{ color: colors.danger, flex: 1 }}>{describeError(error)}</Text>
      {onRetry ? (
        <Pressable accessibilityRole="button" onPress={onRetry}>
          <Text style={{ color: colors.primary, fontWeight: '600' }}>{t.retry}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Loading() {
  return (
    <View style={styles.center} accessibilityLabel={t.loading}>
      <ActivityIndicator color={colors.primary} />
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <View style={styles.center}>
      <Text style={{ color: colors.muted }}>{text}</Text>
    </View>
  );
}

export function Header({ title, onBack, right }: { title: string; onBack?: () => void; right?: ReactNode }) {
  return (
    <View style={styles.header}>
      {onBack ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t.back} onPress={onBack} style={{ marginLeft: -space(2), marginRight: space(1), width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }} hitSlop={12}>
          <Icon name="back" size={24} color={colors.primary} />
        </Pressable>
      ) : null}
      <Text accessibilityRole="header" numberOfLines={1} style={styles.headerTitle}>
        {title}
      </Text>
      {right}
    </View>
  );
}

export function Row({ title, subtitle, right, onPress, selected, badge, dotColor, unread }: {
  dotColor?: string;
  unread?: boolean;
  title: string;
  subtitle?: string;
  right?: string;
  onPress?: () => void;
  selected?: boolean;
  badge?: number | string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, selected && { backgroundColor: colors.primarySoft }, pressed && { backgroundColor: colors.hover }]}
    >
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {dotColor ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: dotColor }} accessibilityElementsHidden /> : null}
          <Text numberOfLines={1} style={[styles.rowTitle, { flexShrink: 1 }, unread && { fontWeight: '800' }]}>
            {title}
          </Text>
        </View>
        {subtitle ? (
          <Text numberOfLines={1} style={[styles.rowSubtitle, unread && { fontWeight: '700', color: colors.text }]}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        {right ? <Text style={styles.rowRight}>{right}</Text> : null}
        {badge ? (
          <View style={styles.badge} accessibilityLabel={`${badge} okunmamış`}>
            <Text style={styles.badgeText}>{badge}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export const card: ViewStyle = { backgroundColor: colors.bg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: space(3), marginBottom: space(2) };

export const styles = StyleSheet.create({
  button: { minHeight: 44, borderRadius: radius.sm, paddingHorizontal: space(4), alignItems: 'center', justifyContent: 'center', marginVertical: space(1) },
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.primary },
  dangerBtn: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.danger },
  buttonText: { color: colors.primaryText, fontSize: font.body, fontWeight: '600' },
  label: { color: colors.muted, fontSize: font.small, marginBottom: space(1) },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: space(3), fontSize: font.body, color: colors.text, backgroundColor: colors.bg },
  error: { flexDirection: 'row', alignItems: 'center', gap: space(2), backgroundColor: colors.dangerSoft, padding: space(3), borderRadius: radius.sm, margin: space(2) },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(6) },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space(4), minHeight: 52, borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  headerTitle: { flex: 1, fontSize: font.title, fontWeight: '700', color: colors.textStrong },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space(4), paddingVertical: space(3), borderBottomWidth: 1, borderColor: colors.border, minHeight: 56 },
  rowTitle: { fontSize: font.body, fontWeight: '600', color: colors.text },
  rowSubtitle: { fontSize: font.small, color: colors.muted, marginTop: 2 },
  rowRight: { fontSize: font.small, color: colors.muted },
  badge: { backgroundColor: colors.primary, borderRadius: 10, minWidth: 20, paddingHorizontal: 6, marginTop: 4, alignItems: 'center' },
  badgeText: { color: colors.primaryText, fontSize: 12, fontWeight: '700' },
});
