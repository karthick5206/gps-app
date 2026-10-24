import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Me } from '@veetracer/shared';
import { Stack } from 'expo-router';
import { KeyRoundIcon, SaveIcon, ShieldCheckIcon, Trash2Icon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, KeyboardAvoidingView, Linking, Platform, ScrollView } from 'react-native';
import { blankToNull } from '@/components/form';
import { Button, Card, ErrorBanner, Field, SectionTitle, Text } from '@/components/ui';
import { meQueryKey, useAuth } from '@/features/auth/auth';
import { api, errorMessage } from '@/lib/api';
import { SERVER_URL } from '@/lib/config';
import { SPACE } from '@/lib/theme';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE = /^\+[1-9]\d{7,14}$/;
const PASSWORD = /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/;

/** Own profile: name, email, mobile, and password change. */
export default function ProfileScreen() {
  const { t } = useTranslation();
  const { me, companyId } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  useEffect(() => {
    if (!me) return;
    setName(me.user.name);
    setEmail(me.user.email ?? '');
    setMobile(me.user.mobile ?? '');
  }, [me]);

  const saveProfile = useMutation({
    mutationFn: () => api.patch<Me>('/auth/me', { name: name.trim(), email: blankToNull(email), mobile: blankToNull(mobile) }),
    onSuccess: (updated) => {
      queryClient.setQueryData(meQueryKey(companyId), updated);
      Alert.alert(t('Saved'), t('Your profile was updated.'));
    },
  });
  const changePassword = useMutation({
    mutationFn: () => api.post<{ ok: true; signedOutOthers: number }>('/auth/me/password', { currentPassword: current || undefined, newPassword: next }),
    onSuccess: (r) => {
      setCurrent('');
      setNext('');
      setConfirm('');
      Alert.alert(t('Password changed'), r.signedOutOthers ? t('You were signed out on {{count}} other device(s).', { count: r.signedOutOthers }) : t('Use the new password next time you sign in.'));
    },
  });

  const emailError = email.trim() && !EMAIL.test(email.trim()) ? t('Enter a valid email') : undefined;
  const mobileError = mobile.trim() && !MOBILE.test(mobile.trim()) ? t('Use international format, e.g. +919876543210') : undefined;
  const profileInvalid = !name.trim() || !!emailError || !!mobileError || (!email.trim() && !mobile.trim());
  const dirty = !!me && (name.trim() !== me.user.name || email.trim() !== (me.user.email ?? '') || mobile.trim() !== (me.user.mobile ?? ''));
  const nextError = next && !PASSWORD.test(next) ? t('At least 8 characters with a letter and a digit') : undefined;
  const confirmError = confirm && confirm !== next ? t('Passwords do not match') : undefined;

  return (
    <>
      <Stack.Screen options={{ title: t('Profile') }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
          <SectionTitle>{t('Personal information')}</SectionTitle>
          <Card style={{ gap: SPACE.md }}>
            <Field label={t('Name')} value={name} onChangeText={setName} autoComplete="name" />
            <Field label={t('Email')} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" error={emailError} hint={t('Used to sign in and for email alerts.')} />
            <Field label={t('Mobile')} value={mobile} onChangeText={setMobile} keyboardType="phone-pad" autoComplete="tel" placeholder="+919876543210" error={mobileError} hint={t('Used for OTP sign-in and SMS alerts.')} />
            {!email.trim() && !mobile.trim() && (
              <Text size="xs" tone="destructive">
                {t('Keep an email or a mobile number to sign in with.')}
              </Text>
            )}
            {saveProfile.isError && <ErrorBanner message={errorMessage(saveProfile.error)} />}
            <Button title={t('Save profile')} icon={SaveIcon} onPress={() => saveProfile.mutate()} disabled={!dirty || profileInvalid} loading={saveProfile.isPending} />
          </Card>

          <SectionTitle>{t('Change password')}</SectionTitle>
          <Card style={{ gap: SPACE.md }}>
            <Field label={t('Current password')} value={current} onChangeText={setCurrent} secureTextEntry autoComplete="password" />
            <Field label={t('New password')} value={next} onChangeText={setNext} secureTextEntry autoComplete="password-new" error={nextError} />
            <Field label={t('Confirm new password')} value={confirm} onChangeText={setConfirm} secureTextEntry autoComplete="password-new" error={confirmError} />
            {changePassword.isError && <ErrorBanner message={errorMessage(changePassword.error)} />}
            <Button
              title={t('Change password')}
              icon={KeyRoundIcon}
              variant="outline"
              onPress={() => changePassword.mutate()}
              disabled={!next || !!nextError || confirm !== next}
              loading={changePassword.isPending}
            />
            <Text size="xs" tone="muted">
              {t('Other devices signed in to your account are signed out.')}
            </Text>
          </Card>

          <SectionTitle>{t('Delete account')}</SectionTitle>
          <DeleteAccountCard />
          <Button title={t('Privacy policy')} icon={ShieldCheckIcon} variant="ghost" onPress={() => Linking.openURL(`${SERVER_URL}/privacy`).catch(() => undefined)} />
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

/** In-app account deletion (app stores require it): personal accounts are deleted with everything in them. */
function DeleteAccountCard() {
  const { t } = useTranslation();
  const { me, signOut } = useAuth();
  const [typed, setTyped] = useState('');
  const expected = me?.user.email ?? me?.user.mobile ?? '';
  const personal = !!me && me.company.accountType !== 'BUSINESS';
  const del = useMutation({
    mutationFn: () => api.post<{ ok: true }>('/me/account/delete', { confirm: typed }),
    onSuccess: () => {
      Alert.alert(t('Delete account'), t('Your account was deleted.'));
      signOut();
    },
  });
  if (!me || me.user.isSuperAdmin) return null;
  const confirmDelete = () =>
    Alert.alert(t('Delete account?'), t('This cannot be undone.'), [
      { text: t('Cancel'), style: 'cancel' },
      { text: t('Delete my account'), style: 'destructive', onPress: () => del.mutate() },
    ]);
  return (
    <Card style={{ gap: SPACE.md }}>
      <Text size="sm" tone="muted">
        {personal
          ? t('Deletes this account and everything in it: every phone, tracker and dashcam, with all locations, history and settings.')
          : t('Deletes your login. The company’s vehicles and data stay with the company.')}{' '}
        {t('Type {{text}} to confirm.', { text: expected })}
      </Text>
      <Field label={t('Confirmation')} value={typed} onChangeText={setTyped} autoCapitalize="none" placeholder={expected} />
      {del.isError && <ErrorBanner message={errorMessage(del.error)} />}
      <Button title={t('Delete my account')} icon={Trash2Icon} variant="destructive" onPress={confirmDelete} loading={del.isPending} disabled={typed.trim().toLowerCase() !== expected.toLowerCase()} />
    </Card>
  );
}
