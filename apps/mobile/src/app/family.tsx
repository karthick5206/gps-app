import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FamilyMembersDto } from '@veetracer/shared';
import { SmartphoneIcon, UserPlusIcon } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, ScrollView, View } from 'react-native';
import { TrackerAppInfo } from '@/components/TrackerAppInfo';
import { Button, Card, EmptyState, ErrorBanner, Field, Pill, SectionTitle, Text } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { SPACE, useColors } from '@/lib/theme';

const KEY = ['family-members'];
const dateOnly = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Personal / family accounts: the account's phones and "Add family member". The member gets an OTP by SMS (their
 * consent) and reads it out; then they install VeeTrax Tracker and activate with their number.
 */
export default function FamilyScreen() {
  const c = useColors();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<'list' | 'details' | 'code'>('list');
  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [code, setCode] = useState('');
  const members = useQuery({ queryKey: KEY, queryFn: ({ signal }) => api.get<FamilyMembersDto>('/family/members', undefined, signal) });
  const reset = () => {
    setStep('list');
    setName('');
    setMobile('');
    setCode('');
  };
  const request = useMutation({
    mutationFn: () => api.post<{ ok: true; smsSent: boolean }>('/family/members/request', { name: name.trim(), mobile }),
    onSuccess: (r) => {
      setStep('code');
      if (!r.smsSent) Alert.alert(t('Family members'), t('The SMS could not be sent right now. Try again in a minute.'));
    },
    onError: (e) => Alert.alert(t('Family members'), errorMessage(e)),
  });
  const verify = useMutation({
    mutationFn: () => api.post<FamilyMembersDto>('/family/members/verify', { mobile, code }),
    onSuccess: (d) => {
      queryClient.setQueryData(KEY, d);
      Alert.alert(t('Family members'), t('{{name}} added. Ask them to install VeeTrax Tracker and activate with their number.', { name: name.trim() }));
      reset();
    },
    onError: (e) => Alert.alert(t('Family members'), errorMessage(e)),
  });
  const d = members.data;

  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md }} keyboardShouldPersistTaps="handled">
      {members.isError && <ErrorBanner message={errorMessage(members.error)} onRetry={() => void members.refetch()} />}
      {d && <Text tone="muted">{t('Free tracking for {{used}} of {{max}} phones used.', { used: d.trialPhones.used, max: d.trialPhones.max })}</Text>}

      {step === 'list' && (
        <>
          {d && d.members.length === 0 && <EmptyState icon={SmartphoneIcon} title={t('No phones yet.')} />}
          {d?.members.map((m) => (
            <Card key={m.deviceId}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
                <SmartphoneIcon size={20} color={c.primary} />
                <View style={{ flex: 1 }}>
                  <Text weight="600">{m.name}</Text>
                  <Text size="sm" tone="muted">
                    {m.mobile}
                    {m.trialEndsAt ? ` · ${t('free until {{date}}', { date: dateOnly(m.trialEndsAt) })}` : m.licenceEndsAt ? ` · ${t('licence until {{date}}', { date: dateOnly(m.licenceEndsAt) })}` : ` · ${t('needs a licence')}`}
                  </Text>
                </View>
                <Pill label={m.activated ? t('Tracking') : t('Not activated')} color={m.activated ? c.primary : c.mutedForeground} />
              </View>
            </Card>
          ))}
          <Button title={t('Add family member')} icon={UserPlusIcon} onPress={() => setStep('details')} />
          <TrackerAppInfo />
        </>
      )}

      {step === 'details' && (
        <>
          <SectionTitle>{t('Add family member')}</SectionTitle>
          <Text tone="muted">{t('We send a 6-digit code by SMS to their phone. Ask them for it: that is their consent to be tracked.')}</Text>
          <Field label={t('Name')} value={name} onChangeText={setName} placeholder={t('Name, e.g. Amma')} maxLength={80} />
          <Field label={t('Mobile number')} value={mobile} onChangeText={setMobile} placeholder="98765 43210" keyboardType="phone-pad" maxLength={16} />
          <Button title={t('Send code to their phone')} onPress={() => request.mutate()} loading={request.isPending} disabled={!name.trim() || !mobile.trim()} />
          <Button title={t('Cancel')} variant="outline" onPress={reset} />
        </>
      )}

      {step === 'code' && (
        <>
          <Text>{t('Enter the 6-digit code {{name}} received on {{mobile}}.', { name: name.trim(), mobile })}</Text>
          <Field label={t('Code')} value={code} onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" maxLength={6} />
          <Button title={t('Add')} onPress={() => verify.mutate()} loading={verify.isPending} disabled={code.length !== 6} />
          <Button title={t('Send again')} variant="outline" onPress={() => request.mutate()} disabled={request.isPending} />
        </>
      )}
    </ScrollView>
  );
}
