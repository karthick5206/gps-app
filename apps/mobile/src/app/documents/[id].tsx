import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_REMINDER_DAYS, type DocumentDto, type DriverDto, type Paginated, type TrackedObjectDto } from '@veetracer/shared';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { DownloadIcon, Trash2Icon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { blankToNull, ChoiceField } from '@/components/form';
import { DateField, toYmd } from '@/components/pickers';
import { Button, Chips, ErrorBanner, Field, Pill, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { documentChip, documentTypeOptions } from '@/features/documents/status';
import { api, errorMessage } from '@/lib/api';
import { downloadAndShare } from '@/lib/share-file';
import { SPACE, useColors } from '@/lib/theme';

type Owner = 'VEHICLE' | 'DRIVER';

/** Optional date with a Clear button (the picker always needs a value). */
function OptionalDate({ label, value, onChange }: { label: string; value: string | null; onChange: (v: string | null) => void }) {
  const { t } = useTranslation();
  return (
    <View style={{ flexDirection: 'row', gap: SPACE.sm, alignItems: 'flex-end' }}>
      <DateField label={label} value={value ?? toYmd(new Date())} onChange={onChange} />
      {value && <Button title={t('Clear')} variant="ghost" onPress={() => onChange(null)} style={{ paddingHorizontal: SPACE.sm }} />}
    </View>
  );
}

export default function DocumentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  const c = useColors();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const isNew = id === 'new';
  const editable = isNew ? can('documents', 'create') : can('documents', 'edit');
  const record = useQuery({
    queryKey: ['documents', 'one', id],
    queryFn: ({ signal }) => api.get<DocumentDto>(`/documents/${id}`, undefined, signal),
    enabled: !isNew,
  });
  const r = record.data;
  const [f, setF] = useState({
    owner: 'VEHICLE' as Owner,
    objectId: null as string | null,
    driverId: null as string | null,
    type: null as string | null,
    number: '',
    issuedOn: null as string | null,
    expiresOn: null as string | null,
    reminderDays: String(DEFAULT_REMINDER_DAYS),
    notes: '',
  });
  useEffect(() => {
    if (r)
      setF({
        owner: r.owner,
        objectId: r.objectId,
        driverId: r.driverId,
        type: r.type,
        number: r.number ?? '',
        issuedOn: r.issuedOn,
        expiresOn: r.expiresOn,
        reminderDays: String(r.reminderDays),
        notes: r.notes ?? '',
      });
  }, [r]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));

  const vehicles = useQuery({
    queryKey: ['options', '/objects', 'documents'],
    queryFn: ({ signal }) => api.get<Paginated<TrackedObjectDto>>('/objects', { pageSize: 200, status: 'ACTIVE' }, signal),
    enabled: editable && can('objects'),
    staleTime: 60_000,
  });
  const drivers = useQuery({
    queryKey: ['options', '/drivers', 'documents'],
    queryFn: ({ signal }) => api.get<Paginated<DriverDto>>('/drivers', { pageSize: 200, status: 'ACTIVE' }, signal),
    enabled: editable,
    staleTime: 60_000,
  });
  const vehicleOptions = (vehicles.data?.items ?? []).map((v) => ({ value: v.id, label: v.plateNumber ? `${v.name} · ${v.plateNumber}` : v.name }));
  if (r?.objectId && !vehicleOptions.some((o) => o.value === r.objectId)) vehicleOptions.unshift({ value: r.objectId, label: r.objectName ?? '…' });
  const driverOptions = (drivers.data?.items ?? []).map((d) => ({ value: d.id, label: d.name }));
  if (r?.driverId && !driverOptions.some((o) => o.value === r.driverId)) driverOptions.unshift({ value: r.driverId, label: r.driverName ?? '…' });

  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ['documents'] });
    router.back();
  };
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => (isNew ? api.post<DocumentDto>('/documents', body) : api.patch<DocumentDto>(`/documents/${id}`, body)),
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/documents/${id}`),
    onSuccess: done,
    onError: (err) => Alert.alert(t('Not deleted'), errorMessage(err)),
  });
  const [downloading, setDownloading] = useState(false);
  const download = async () => {
    if (!r?.file) return;
    setDownloading(true);
    try {
      await downloadAndShare(`/documents/${r.id}/file`, { fallbackName: r.file.name });
    } catch (err) {
      Alert.alert(t('Download failed'), errorMessage(err));
    } finally {
      setDownloading(false);
    }
  };

  const days = Number(f.reminderDays);
  const daysError = f.reminderDays.trim() === '' || !Number.isInteger(days) || days < 0 || days > 365 ? t('0 – 365 days') : undefined;
  const submit = () => {
    if (f.owner === 'VEHICLE' ? !f.objectId : !f.driverId) return Alert.alert(f.owner === 'VEHICLE' ? t('Choose the vehicle') : t('Choose the driver'));
    if (!f.type) return Alert.alert(t('Choose the document'));
    if (f.issuedOn && f.expiresOn && f.issuedOn > f.expiresOn) return Alert.alert(t('The expiry date is before the issue date'));
    if (daysError) return;
    save.mutate({
      objectId: f.owner === 'VEHICLE' ? f.objectId : null,
      driverId: f.owner === 'DRIVER' ? f.driverId : null,
      type: f.type,
      number: blankToNull(f.number),
      issuedOn: f.issuedOn,
      expiresOn: f.expiresOn,
      reminderDays: days,
      notes: blankToNull(f.notes),
    });
  };
  const confirmDelete = () =>
    Alert.alert(t('Delete document?'), t('The document and its attached file will be permanently deleted.'), [
      { text: t('Cancel'), style: 'cancel' },
      { text: t('Delete'), style: 'destructive', onPress: () => remove.mutate() },
    ]);
  const chip = r ? documentChip(r) : null;

  return (
    <>
      <Stack.Screen
        options={{
          title: isNew ? t('Add document') : editable ? t('Edit document') : t('Document'),
          headerRight: () =>
            !isNew && can('documents', 'delete') ? (
              <Pressable onPress={confirmDelete} hitSlop={10} accessibilityLabel={t('Delete')} style={{ paddingHorizontal: SPACE.sm }}>
                {remove.isPending ? <ActivityIndicator /> : <Trash2Icon size={22} color={c.destructive} />}
              </Pressable>
            ) : null,
        }}
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
          {!isNew && record.isPending ? (
            <ActivityIndicator style={{ margin: SPACE.xl }} />
          ) : (
            <>
              {chip && <Pill label={chip.label} color={chip.color} />}
              {isNew && (
                <Chips<Owner>
                  value={f.owner}
                  onChange={(v) => setF((s) => ({ ...s, owner: v, type: v === 'DRIVER' ? 'DRIVING_LICENCE' : null }))}
                  options={[
                    { value: 'VEHICLE', label: t('Vehicle') },
                    { value: 'DRIVER', label: t('Driver') },
                  ]}
                />
              )}
              {f.owner === 'VEHICLE' ? (
                <ChoiceField label={t('Vehicle *')} value={f.objectId} allowEmpty={false} options={vehicleOptions} emptyLabel={t('Choose the vehicle')} onChange={(v) => set('objectId', v)} />
              ) : (
                <ChoiceField label={t('Driver *')} value={f.driverId} allowEmpty={false} options={driverOptions} emptyLabel={t('Choose the driver')} onChange={(v) => set('driverId', v)} />
              )}
              <ChoiceField label={t('Document *')} value={f.type} allowEmpty={false} options={documentTypeOptions(f.owner)} emptyLabel={t('Choose the document')} onChange={(v) => set('type', v)} />
              <Field label={t('Number')} value={f.number} onChangeText={(v) => set('number', v)} autoCapitalize="characters" />
              <OptionalDate label={t('Issued on')} value={f.issuedOn} onChange={(v) => set('issuedOn', v)} />
              <OptionalDate label={t('Expires on')} value={f.expiresOn} onChange={(v) => set('expiresOn', v)} />
              <Field
                label={t('Remind before (days)')}
                value={f.reminderDays}
                onChangeText={(v) => set('reminderDays', v.replace(/\D/g, ''))}
                keyboardType="number-pad"
                error={daysError}
                hint={t('Reminder alerts start this many days before expiry.')}
              />
              <Field label={t('Notes')} value={f.notes} onChangeText={(v) => set('notes', v)} multiline style={{ height: 80, textAlignVertical: 'top', paddingTop: 10 }} />
              {r?.file ? (
                <Button title={t('Open file ({{name}})', { name: r.file.name })} icon={DownloadIcon} variant="outline" onPress={() => void download()} loading={downloading} />
              ) : (
                !isNew && (
                  <Text size="sm" tone="muted">
                    {t('No file attached. Attach a scan or photo from the web app.')}
                  </Text>
                )
              )}
              {editable && <Button title={isNew ? t('Add document') : t('Save')} onPress={submit} loading={save.isPending} />}
            </>
          )}
          {!!(save.error ?? record.error) && <ErrorBanner message={errorMessage(save.error ?? record.error)} />}
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}
