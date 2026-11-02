import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import type { AccountSummary } from '@workhub-devices/core';
import { useServices } from './services';
import { Button, ErrorBanner, Field } from './ui';
import { colors, font, space } from './theme';
import { t } from './i18n';

/** Server URL → Nextcloud Login Flow v2 in the system browser → app password stored by the shell. */
export function LoginScreen({ onDone, onCancel }: { onDone: (a: AccountSummary) => void; onCancel?: () => void }) {
  const { backend, platform } = useServices();
  const [url, setUrl] = useState('');
  const [error, setError] = useState<unknown>();
  const [flow, setFlow] = useState<{ flowId: string; loginUrl: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const start = async () => {
    setError(undefined);
    setBusy(true);
    try {
      const f = await backend.beginLogin(url);
      setFlow(f);
      await platform.openExternal(f.loginUrl);
      const acc = await backend.completeLogin(f.flowId);
      if (mounted.current) onDone(acc);
    } catch (e) {
      if (mounted.current) setError(e);
    } finally {
      if (mounted.current) {
        setBusy(false);
        setFlow(null);
      }
    }
  };

  const cancel = async () => {
    if (flow) await backend.cancel(flow.flowId);
    setFlow(null);
    onCancel?.();
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: space(6), maxWidth: 480, width: '100%', alignSelf: 'center' }} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={{ fontSize: font.h1, fontWeight: '800', color: colors.text, marginBottom: space(2) }}>
          {t.appName}
        </Text>
        <Text style={{ color: colors.muted, marginBottom: space(6) }}>Nextcloud sunucunuza bağlanın: sohbetler (Talk) ve işler (Workhub) tek uygulamada.</Text>
        {flow ? (
          <View>
            <Text style={{ color: colors.text, marginBottom: space(4) }}>{t.loginWaiting}</Text>
            <Button title={t.openBrowserAgain} kind="secondary" onPress={() => void platform.openExternal(flow.loginUrl)} />
            <Button title={t.cancel} kind="secondary" onPress={() => void cancel()} />
          </View>
        ) : (
          <View>
            <Field
              label={t.serverUrl}
              placeholder={t.serverHint}
              value={url}
              onChangeText={setUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              inputMode="url"
              returnKeyType="go"
              onSubmitEditing={() => void start()}
            />
            <Button title={t.connect} onPress={() => void start()} busy={busy} disabled={!url.trim()} />
            {onCancel ? <Button title={t.cancel} kind="secondary" onPress={onCancel} /> : null}
          </View>
        )}
        <ErrorBanner error={error} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
