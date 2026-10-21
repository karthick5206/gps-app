import { router } from 'expo-router';
import { MapPin } from 'lucide-react-native';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Body, Button, Card, Title } from '@/components/ui';
import { api, ApiError, NetworkError, SERVER_URL } from '@/lib/api';
import { APP_VERSION, deviceName } from '@/lib/device';
import { setToken, store, useStoreVersion } from '@/lib/state';
import { S } from '@/lib/strings';
import { useColors } from '@/lib/theme';
import { applyConfig, Tracker } from '@/lib/tracking';

function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof NetworkError) return S.networkError;
  return e instanceof Error ? e.message : String(e);
}

/** Keeps 10 digits; strips a pasted +91 / 0 prefix. */
function cleanMobile(t: string): string {
  let d = t.replace(/\D/g, '');
  if (d.length > 10 && d.startsWith('91')) d = d.slice(2);
  else if (d.length > 10 && d.startsWith('0')) d = d.slice(1);
  return d.slice(0, 10);
}

export default function ActivateScreen() {
  useStoreVersion();
  const c = useColors();
  const notice = store.notice();
  const [digits, setDigits] = useState('');
  const [step, setStep] = useState<'mobile' | 'code'>('mobile');
  const [mobile, setMobile] = useState(''); // normalised by the server, e.g. 919876543210
  const [smsSent, setSmsSent] = useState(true);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestCode = async () => {
    if (!/^\d{10}$/.test(digits)) return setError(S.mobileInvalid);
    setBusy(true);
    setError(null);
    try {
      const r = await api.requestCode(`+91${digits}`);
      setMobile(r.mobile);
      setSmsSent(r.smsSent);
      setCode('');
      setStep('code');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!/^\d{6}$/.test(code)) return setError(S.codeInvalid);
    setBusy(true);
    setError(null);
    try {
      const r = await api.verify({ mobile, code, deviceName: deviceName(), appVersion: APP_VERSION, platform: Platform.OS });
      await setToken(r.token);
      // The native engine keeps its own copy so it can upload with the app closed.
      await Tracker.setCredentials(r.token, SERVER_URL).catch(() => undefined);
      store.setNotice(null);
      store.setSession({ uniqueId: r.uniqueId, objectName: r.objectName, companyName: r.companyName });
      // Config is stored for the next start; a failure here must not keep the user on this screen.
      await applyConfig(r.config).catch(() => undefined);
      // Go to the home screen explicitly (seen: the protected-route switch alone left the spinner running).
      router.replace('/');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const input = [styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.input }];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <View style={[styles.logo, { backgroundColor: c.primary }]}>
              <MapPin color="#ffffff" size={34} />
            </View>
            <Text style={[styles.appName, { color: c.text }]}>{S.appName}</Text>
          </View>

          {notice ? (
            <Card tone="warn">
              <Body style={{ color: c.accentText, fontWeight: '600' }}>{notice}</Body>
            </Card>
          ) : null}

          <Card>
            <Title>{S.activateTitle}</Title>
            {step === 'mobile' ? (
              <>
                <Body muted>{S.activateIntro}</Body>
                <Text style={[styles.label, { color: c.muted }]}>{S.mobileLabel}</Text>
                <View style={styles.phoneRow}>
                  <View style={[styles.prefix, { borderColor: c.border, backgroundColor: c.primarySoft }]}>
                    <Text style={[styles.prefixText, { color: c.text }]}>+91</Text>
                  </View>
                  <TextInput
                    style={[input, { flex: 1 }]}
                    value={digits}
                    onChangeText={(t) => setDigits(cleanMobile(t))}
                    placeholder={S.mobilePlaceholder}
                    placeholderTextColor={c.muted}
                    keyboardType="phone-pad"
                    autoComplete="tel"
                    maxLength={14}
                    returnKeyType="send"
                    onSubmitEditing={requestCode}
                  />
                </View>
                <Button title={S.sendCode} onPress={requestCode} busy={busy} />
              </>
            ) : (
              <>
                <Body muted>{smsSent ? S.codeSentSms(mobile) : S.codeNoSms(mobile)}</Body>
                <Text style={[styles.label, { color: c.muted }]}>{S.codeLabel}</Text>
                <TextInput
                  style={[input, styles.code]}
                  value={code}
                  onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
                  placeholder="••••••"
                  placeholderTextColor={c.muted}
                  keyboardType="number-pad"
                  autoComplete="sms-otp"
                  textContentType="oneTimeCode"
                  maxLength={6}
                  autoFocus
                  onSubmitEditing={verify}
                />
                <Button title={S.verify} onPress={verify} busy={busy} />
                {smsSent ? <Body muted>{S.codeHelp}</Body> : null}
                <View style={styles.links}>
                  <Button title={S.resendCode} variant="ghost" onPress={requestCode} disabled={busy} />
                  <Button title={S.changeNumber} variant="ghost" onPress={() => (setStep('mobile'), setError(null))} disabled={busy} />
                </View>
              </>
            )}
            {error ? <Text style={[styles.error, { color: c.danger }]}>{error}</Text> : null}
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 20, gap: 16, flexGrow: 1, justifyContent: 'center' },
  brand: { alignItems: 'center', gap: 10, marginBottom: 8 },
  logo: { width: 64, height: 64, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  appName: { fontSize: 24, fontWeight: '800' },
  label: { fontSize: 14, fontWeight: '600', marginTop: 4 },
  phoneRow: { flexDirection: 'row', gap: 8 },
  prefix: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, justifyContent: 'center' },
  prefixText: { fontSize: 18, fontWeight: '600' },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, minHeight: 52, fontSize: 18 },
  code: { fontSize: 26, letterSpacing: 10, textAlign: 'center', fontWeight: '700' },
  links: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  error: { fontSize: 15, fontWeight: '600' },
});
