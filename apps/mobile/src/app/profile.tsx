import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Me } from '@veetracer/shared';
import { Stack } from 'expo-router';
import { KeyRoundIcon, SaveIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { blankToNull } from '@/components/form';
import { Button, Card, ErrorBanner, Field, SectionTitle, Text } from '@/components/ui';
import { meQueryKey, useAuth } from '@/features/auth/auth';
import { api, errorMessage } from '@/lib/api';
import { SPACE } from '@/lib/theme';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE = /^\+[1-9]\d{7,14}$/;
const PASSWORD = /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/;

/** Own profile: name, email, mobile, and password change. */
export default function ProfileScreen() {
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
      Alert.alert('Saved', 'Your profile was updated.');
    },
  });
  const changePassword = useMutation({
    mutationFn: () => api.post<{ ok: true; signedOutOthers: number }>('/auth/me/password', { currentPassword: current || undefined, newPassword: next }),
    onSuccess: (r) => {
      setCurrent('');
      setNext('');
      setConfirm('');
      Alert.alert('Password changed', r.signedOutOthers ? `You were signed out on ${r.signedOutOthers} other device(s).` : 'Use the new password next time you sign in.');
    },
  });

  const emailError = email.trim() && !EMAIL.test(email.trim()) ? 'Enter a valid email' : undefined;
  const mobileError = mobile.trim() && !MOBILE.test(mobile.trim()) ? 'Use international format, e.g. +919876543210' : undefined;
  const profileInvalid = !name.trim() || !!emailError || !!mobileError || (!email.trim() && !mobile.trim());
  const dirty = !!me && (name.trim() !== me.user.name || email.trim() !== (me.user.email ?? '') || mobile.trim() !== (me.user.mobile ?? ''));
  const nextError = next && !PASSWORD.test(next) ? 'At least 8 characters with a letter and a digit' : undefined;
  const confirmError = confirm && confirm !== next ? 'Passwords do not match' : undefined;

  return (
    <>
      <Stack.Screen options={{ title: 'Profile' }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
          <SectionTitle>Personal information</SectionTitle>
          <Card style={{ gap: SPACE.md }}>
            <Field label="Name" value={name} onChangeText={setName} autoComplete="name" />
            <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" error={emailError} hint="Used to sign in and for email alerts." />
            <Field label="Mobile" value={mobile} onChangeText={setMobile} keyboardType="phone-pad" autoComplete="tel" placeholder="+919876543210" error={mobileError} hint="Used for OTP sign-in and SMS alerts." />
            {!email.trim() && !mobile.trim() && (
              <Text size="xs" tone="destructive">
                Keep an email or a mobile number to sign in with.
              </Text>
            )}
            {saveProfile.isError && <ErrorBanner message={errorMessage(saveProfile.error)} />}
            <Button title="Save profile" icon={SaveIcon} onPress={() => saveProfile.mutate()} disabled={!dirty || profileInvalid} loading={saveProfile.isPending} />
          </Card>

          <SectionTitle>Change password</SectionTitle>
          <Card style={{ gap: SPACE.md }}>
            <Field label="Current password" value={current} onChangeText={setCurrent} secureTextEntry autoComplete="password" />
            <Field label="New password" value={next} onChangeText={setNext} secureTextEntry autoComplete="password-new" error={nextError} />
            <Field label="Confirm new password" value={confirm} onChangeText={setConfirm} secureTextEntry autoComplete="password-new" error={confirmError} />
            {changePassword.isError && <ErrorBanner message={errorMessage(changePassword.error)} />}
            <Button
              title="Change password"
              icon={KeyRoundIcon}
              variant="outline"
              onPress={() => changePassword.mutate()}
              disabled={!next || !!nextError || confirm !== next}
              loading={changePassword.isPending}
            />
            <Text size="xs" tone="muted">
              Other devices signed in to your account are signed out.
            </Text>
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}
