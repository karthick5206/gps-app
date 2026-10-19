import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_NOTIFY_BEFORE_DAYS, DEFAULT_NOTIFY_BEFORE_KM, type Paginated, type ServiceRecordDto, type ServiceReminderDto, type TrackedObjectDto } from '@veetracer/shared';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { CheckCheckIcon, Trash2Icon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { blankToNull, ChoiceField, SwitchRow } from '@/components/form';
import { DateField, toYmd } from '@/components/pickers';
import { Button, Card, ErrorBanner, Field, InfoRow, Pill, SectionTitle, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { formatKm, serviceChip } from '@/features/documents/status';
import { api, errorMessage } from '@/lib/api';
import { SPACE, useColors } from '@/lib/theme';

const digits = (v: string) => v.replace(/[^\d.]/g, '');
const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v));

/** Service done: date, odometer, cost, notes; rolls the reminder forward. */
function MarkDone({ reminder }: { reminder: ServiceReminderDto }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [doneAt, setDoneAt] = useState(toYmd(new Date()));
  const [odometer, setOdometer] = useState(reminder.odometerKm !== null ? String(Math.round(reminder.odometerKm)) : '');
  const [cost, setCost] = useState('');
  const [notes, setNotes] = useState('');
  const [endMaintenance, setEndMaintenance] = useState(true);
  const done = useMutation({
    mutationFn: () =>
      api.post<ServiceReminderDto>(`/service-reminders/${reminder.id}/done`, {
        doneAt,
        odometerKm: numOrNull(odometer),
        cost: numOrNull(cost),
        notes: blankToNull(notes),
        endMaintenance: reminder.inMaintenance && can('objects', 'edit') ? endMaintenance : false,
      }),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ['service-reminders'] });
      void queryClient.invalidateQueries({ queryKey: ['service-records'] });
      Alert.alert(t('Service recorded'), r.dueAt || r.dueOdometerKm !== null ? t('Next due: {{when}}', { when: [r.dueAt, r.dueOdometerKm !== null ? formatKm(r.dueOdometerKm) : null].filter(Boolean).join(' · ') }) : undefined);
      setCost('');
      setNotes('');
    },
  });
  return (
    <Card style={{ gap: SPACE.md }}>
      <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
        <DateField label={t('Done on')} value={doneAt} onChange={setDoneAt} maximumDate={new Date()} />
        <View style={{ flex: 1 }}>
          <Field label={t('Odometer (km)')} value={odometer} onChangeText={(v) => setOdometer(digits(v))} keyboardType="decimal-pad" />
        </View>
      </View>
      <Field label={t('Cost (₹)')} value={cost} onChangeText={(v) => setCost(digits(v))} keyboardType="decimal-pad" />
      <Field label={t('Notes')} value={notes} onChangeText={setNotes} placeholder={t('Workshop, parts replaced…')} />
      {reminder.inMaintenance && can('objects', 'edit') && (
        <SwitchRow label={t('Also end maintenance for this vehicle (alerts resume)')} value={endMaintenance} onChange={setEndMaintenance} />
      )}
      <Button title={t('Mark done')} icon={CheckCheckIcon} onPress={() => done.mutate()} loading={done.isPending} />
      {!!done.error && <ErrorBanner message={errorMessage(done.error)} />}
    </Card>
  );
}

export default function ServiceReminderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  const c = useColors();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const isNew = id === 'new';
  const editable = isNew ? can('documents', 'create') : can('documents', 'edit');
  const record = useQuery({
    queryKey: ['service-reminders', 'one', id],
    queryFn: ({ signal }) => api.get<ServiceReminderDto>(`/service-reminders/${id}`, undefined, signal),
    enabled: !isNew,
  });
  const history = useQuery({
    queryKey: ['service-records', id],
    queryFn: ({ signal }) => api.get<ServiceRecordDto[]>('/service-reminders/records', { reminderId: id }, signal),
    enabled: !isNew,
  });
  const r = record.data;
  const [f, setF] = useState({
    objectId: null as string | null,
    title: '',
    intervalKm: '',
    intervalDays: '',
    notifyBeforeKm: String(DEFAULT_NOTIFY_BEFORE_KM),
    notifyBeforeDays: String(DEFAULT_NOTIFY_BEFORE_DAYS),
    notes: '',
    isActive: true,
  });
  useEffect(() => {
    if (r)
      setF({
        objectId: r.objectId,
        title: r.title,
        intervalKm: r.intervalKm ? String(r.intervalKm) : '',
        intervalDays: r.intervalDays ? String(r.intervalDays) : '',
        notifyBeforeKm: String(r.notifyBeforeKm),
        notifyBeforeDays: String(r.notifyBeforeDays),
        notes: r.notes ?? '',
        isActive: r.isActive,
      });
  }, [r]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const vehicles = useQuery({
    queryKey: ['options', '/objects', 'service'],
    queryFn: ({ signal }) => api.get<Paginated<TrackedObjectDto>>('/objects', { pageSize: 200, status: 'ACTIVE' }, signal),
    enabled: editable && can('objects'),
    staleTime: 60_000,
  });
  const vehicleOptions = (vehicles.data?.items ?? []).map((v) => ({ value: v.id, label: v.plateNumber ? `${v.name} · ${v.plateNumber}` : v.name }));
  if (r && !vehicleOptions.some((o) => o.value === r.objectId)) vehicleOptions.unshift({ value: r.objectId, label: r.objectName });

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => (isNew ? api.post<ServiceReminderDto>('/service-reminders', body) : api.patch<ServiceReminderDto>(`/service-reminders/${id}`, body)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['service-reminders'] });
      router.back();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/service-reminders/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['service-reminders'] });
      router.back();
    },
    onError: (err) => Alert.alert(t('Not deleted'), errorMessage(err)),
  });
  const submit = () => {
    if (!f.objectId) return Alert.alert(t('Choose the vehicle'));
    if (!f.title.trim()) return Alert.alert(t('Name the service, e.g. Engine oil'));
    if (!f.intervalKm.trim() && !f.intervalDays.trim()) return Alert.alert(t('Set an interval in km, in days, or both'));
    save.mutate({
      objectId: f.objectId,
      title: f.title.trim(),
      intervalKm: numOrNull(f.intervalKm),
      intervalDays: numOrNull(f.intervalDays),
      notifyBeforeKm: Number(f.notifyBeforeKm || 0),
      notifyBeforeDays: Number(f.notifyBeforeDays || 0),
      notes: blankToNull(f.notes),
      isActive: f.isActive,
    });
  };
  const confirmDelete = () =>
    Alert.alert(t('Delete service reminder?'), t('Its service history is kept.'), [
      { text: t('Cancel'), style: 'cancel' },
      { text: t('Delete'), style: 'destructive', onPress: () => remove.mutate() },
    ]);
  const chip = r ? serviceChip(r) : null;

  return (
    <>
      <Stack.Screen
        options={{
          title: isNew ? t('Add service reminder') : (r?.title ?? t('Service reminder')),
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
              {r && chip && (
                <Card style={{ paddingVertical: 0 }}>
                  <InfoRow label={t('Status')} value={<Pill label={chip.label} color={chip.color} />} />
                  <InfoRow label={t('Vehicle')} value={r.objectName} />
                  <InfoRow label={t('Last done')} value={[r.lastDoneAt, r.lastDoneOdometerKm !== null ? formatKm(r.lastDoneOdometerKm) : null].filter(Boolean).join(' · ') || '—'} />
                  <InfoRow label={t('Next due')} value={[r.dueAt, r.dueOdometerKm !== null ? formatKm(r.dueOdometerKm) : null].filter(Boolean).join(' · ') || '—'} />
                  <InfoRow label={t('Odometer')} value={formatKm(r.odometerKm)} />
                </Card>
              )}
              {r && can('documents', 'edit') && (
                <>
                  <SectionTitle>{t('Mark service done')}</SectionTitle>
                  <MarkDone key={r.id} reminder={r} />
                </>
              )}
              {editable && (
                <>
                  {!isNew && <SectionTitle>{t('Reminder')}</SectionTitle>}
                  <ChoiceField label={t('Vehicle *')} value={f.objectId} allowEmpty={false} options={vehicleOptions} emptyLabel={t('Choose the vehicle')} onChange={(v) => set('objectId', v)} />
                  <Field label={t('Service *')} value={f.title} onChangeText={(v) => set('title', v)} placeholder={t('e.g. Engine oil')} />
                  <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
                    <View style={{ flex: 1 }}>
                      <Field label={t('Every (km)')} value={f.intervalKm} onChangeText={(v) => set('intervalKm', v.replace(/\D/g, ''))} keyboardType="number-pad" placeholder="10000" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Field label={t('Every (days)')} value={f.intervalDays} onChangeText={(v) => set('intervalDays', v.replace(/\D/g, ''))} keyboardType="number-pad" placeholder="180" />
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
                    <View style={{ flex: 1 }}>
                      <Field label={t('Remind before (km)')} value={f.notifyBeforeKm} onChangeText={(v) => set('notifyBeforeKm', v.replace(/\D/g, ''))} keyboardType="number-pad" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Field label={t('Remind before (days)')} value={f.notifyBeforeDays} onChangeText={(v) => set('notifyBeforeDays', v.replace(/\D/g, ''))} keyboardType="number-pad" />
                    </View>
                  </View>
                  {isNew && (
                    <Text size="xs" tone="muted">
                      {t('A new reminder counts from today and the odometer now.')}
                    </Text>
                  )}
                  <Field label={t('Notes')} value={f.notes} onChangeText={(v) => set('notes', v)} multiline style={{ height: 80, textAlignVertical: 'top', paddingTop: 10 }} />
                  <SwitchRow label={t('Active')} hint={t('Inactive reminders raise no alerts.')} value={f.isActive} onChange={(v) => set('isActive', v)} />
                  <Button title={isNew ? t('Add service reminder') : t('Save')} onPress={submit} loading={save.isPending} />
                </>
              )}
              {!!history.data?.length && (
                <>
                  <SectionTitle>{t('Service history')}</SectionTitle>
                  <Card style={{ gap: SPACE.sm }}>
                    {history.data.map((h) => (
                      <Text key={h.id} size="sm">
                        {[h.doneAt, h.odometerKm !== null ? formatKm(h.odometerKm) : null, h.cost !== null ? `₹${h.cost.toLocaleString()}` : null, h.notes].filter(Boolean).join(' · ')}
                      </Text>
                    ))}
                  </Card>
                </>
              )}
            </>
          )}
          {!!(save.error ?? record.error) && <ErrorBanner message={errorMessage(save.error ?? record.error)} />}
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}
