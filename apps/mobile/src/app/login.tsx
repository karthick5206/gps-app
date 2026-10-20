import { useMutation } from '@tanstack/react-query';
import type { LoginResponse } from '@veetracer/shared';
import { KeyRoundIcon, SmartphoneIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Chips, ErrorBanner, Field, Text } from '@/components/ui';
import { BrandMark } from '@/components/BrandMark';
import { LanguageChips } from '@/components/LanguageChips';
import { useAuth } from '@/features/auth/auth';
import { api, errorMessage } from '@/lib/api';
import { SERVER_URL } from '@/lib/config';
import { RADIUS, SPACE, useColors, useTheme } from '@/lib/theme';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE = /^\+[1-9]\d{7,14}$/;
const RESEND_AFTER_SEC = 30;

function PasswordForm() {
  const { t } = useTranslation();
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const login = useMutation({
    mutationFn: () => api.post<LoginResponse>('/auth/login', { email: email.trim(), password }, { anonymous: true }),
    onSuccess: signIn,
  });
  const emailError = touched && !EMAIL.test(email.trim()) ? t('Enter a valid email') : undefined;
  const passwordError = touched && !password ? t('Password is required') : undefined;
  const submit = () => {
    setTouched(true);
    if (EMAIL.test(email.trim()) && password) login.mutate();
  };
  return (
    <View style={{ gap: SPACE.lg }}>
      <Field label={t('Email')} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" textContentType="username" placeholder="you@company.com" error={emailError} />
      <Field label={t('Password')} value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" textContentType="password" returnKeyType="go" onSubmitEditing={submit} error={passwordError} />
      {login.isError && <ErrorBanner message={errorMessage(login.error)} />}
      <Button title={t('Sign in')} icon={KeyRoundIcon} onPress={submit} loading={login.isPending} />
    </View>
  );
}

function OtpForm() {
  const { t } = useTranslation();
  const { signIn } = useAuth();
  const [mobile, setMobile] = useState('+91');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const request = useMutation({
    mutationFn: (m: string) => api.post<{ ok: true; devCode?: string }>('/auth/otp/request', { mobile: m }, { anonymous: true }),
    onSuccess: (res, m) => {
      setSentTo(m);
      setWait(RESEND_AFTER_SEC);
      if (res.devCode) setCode(res.devCode);
    },
  });
  const verify = useMutation({
    mutationFn: () => api.post<LoginResponse>('/auth/otp/verify', { mobile: sentTo, code: code.trim() }, { anonymous: true }),
    onSuccess: signIn,
  });

  if (!sentTo) {
    const valid = MOBILE.test(mobile.trim());
    return (
      <View style={{ gap: SPACE.lg }}>
        <Field label={t('Mobile number')} value={mobile} onChangeText={setMobile} keyboardType="phone-pad" autoComplete="tel" hint={t("We'll send a 6-digit code to this number.")} />
        {request.isError && <ErrorBanner message={errorMessage(request.error)} />}
        <Button title={t('Send code')} onPress={() => request.mutate(mobile.trim())} disabled={!valid} loading={request.isPending} />
      </View>
    );
  }
  return (
    <View style={{ gap: SPACE.lg }}>
      <Field label={t('Verification code')} value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" maxLength={6} hint={t('Sent to {{mobile}}', { mobile: sentTo })} />
      {verify.isError && <ErrorBanner message={errorMessage(verify.error)} />}
      <Button title={t('Verify and sign in')} onPress={() => verify.mutate()} disabled={!/^\d{6}$/.test(code.trim())} loading={verify.isPending} />
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Pressable onPress={() => setSentTo(null)} hitSlop={8}>
          <Text size="sm" tone="primary" weight="600">
            {t('Change number')}
          </Text>
        </Pressable>
        <Pressable onPress={() => request.mutate(sentTo)} disabled={wait > 0} hitSlop={8}>
          <Text size="sm" tone={wait > 0 ? 'muted' : 'primary'} weight="600">
            {wait > 0 ? t('Resend in {{seconds}}s', { seconds: wait }) : t('Resend code')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function LoginScreen() {
  const c = useColors();
  const { t } = useTranslation();
  const [mode, setMode] = useState<'password' | 'otp'>('password');
  // Sky and Light have a light hero, so the logo uses its ink colours there.
  const theme = useTheme();
  const lightHero = theme === 'sky' || theme === 'light';
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.brand }} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
          <View style={styles.hero}>
            <BrandMark size={64} onLight={lightHero} />
            <Text style={{ color: c.brandForeground, fontSize: 28, fontWeight: '800', letterSpacing: -0.8 }}>VeeTrax</Text>
            <Text style={{ color: c.brandForeground, opacity: 0.8, fontSize: 14 }}>{t('Every vehicle, every second, one screen.')}</Text>
          </View>
          <View style={[styles.sheet, { backgroundColor: c.background }]}>
            <Text size="xl" weight="700">
              {t('Sign in')}
            </Text>
            <Chips
              value={mode}
              onChange={setMode}
              options={[
                { value: 'password', label: t('Email & password') },
                { value: 'otp', label: t('Mobile OTP') },
              ]}
            />
            {mode === 'password' ? <PasswordForm /> : <OtpForm />}
            {/* Personal accounts sign up on the web (email code), then sign in here. */}
            <Pressable onPress={() => Linking.openURL(`${SERVER_URL}/signup`).catch(() => undefined)} accessibilityRole="link" style={{ alignSelf: 'center', paddingVertical: SPACE.sm }}>
              <Text size="sm">
                {t('New to VeeTrax?')}{' '}
                <Text size="sm" weight="600" style={{ color: c.primary }}>
                  {t('Create personal account')}
                </Text>
              </Text>
            </Pressable>
            <View style={{ flex: 1 }} />
            <View style={{ alignItems: 'center' }}>
              <LanguageChips signedIn={false} />
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
              <SmartphoneIcon size={14} color={c.mutedForeground} />
              <Text size="xs" tone="muted">
                {SERVER_URL.replace(/^https?:\/\//, '')}
              </Text>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  hero: { paddingHorizontal: SPACE.xl, paddingTop: 48, paddingBottom: 36, gap: SPACE.sm },
  sheet: { flex: 1, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: SPACE.xl, gap: SPACE.lg, paddingBottom: 32 },
});
