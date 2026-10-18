import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_SPEED_LIMIT_KPH,
  OBJECT_TYPES,
  VEHICLE_TYPES,
  type BranchDto,
  type DeviceDto,
  type DeviceModelDto,
  type DriverDto,
  type ObjectType,
  type Paginated,
  type TrackedObjectDto,
  type VehicleType,
} from '@veetracer/shared';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { DatabaseIcon, Trash2Icon } from 'lucide-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { blankToNull, ChoiceField, SwitchRow } from '@/components/form';
import type { PickOption } from '@/components/PickerSheet';
import { DateField, toYmd } from '@/components/pickers';
import { Button, EmptyState, ErrorBanner, Field } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { liveStore } from '@/features/live/live-store';
import { isKind, KINDS, type ManageKind } from '@/features/manage/kinds';
import { api, errorMessage } from '@/lib/api';
import { humanize } from '@/lib/format';
import { i18n } from '@/lib/i18n';
import { SPACE, useColors } from '@/lib/theme';

const MOBILE = /^\+[1-9]\d{7,14}$/;

function useOptions<T>(endpoint: string, toOption: (r: T) => PickOption, enabled = true, params: Record<string, string | number | boolean> = {}) {
  const q = useQuery({
    queryKey: ['options', endpoint, params],
    queryFn: ({ signal }) => api.get<Paginated<T>>(endpoint, { pageSize: 200, status: 'ACTIVE', ...params }, signal),
    enabled,
    staleTime: 60_000,
  });
  return (q.data?.items ?? []).map(toOption);
}

/** Load (edit) or start empty (new), save with POST / PATCH, delete with confirmation. */
function useRecord<T>(kind: ManageKind, id: string) {
  const { t } = useTranslation();
  const def = KINDS[kind];
  const queryClient = useQueryClient();
  const isNew = id === 'new';
  const record = useQuery({
    queryKey: ['manage', kind, 'one', id],
    queryFn: ({ signal }) => api.get<T>(`${def.endpoint}/${id}`, undefined, signal),
    enabled: !isNew,
  });
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ['manage', kind] });
    void queryClient.invalidateQueries({ queryKey: ['options'] });
    liveStore.loadSnapshot().catch(() => undefined);
    router.back();
  };
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => (isNew ? api.post<T>(def.endpoint, body) : api.patch<T>(`${def.endpoint}/${id}`, body)),
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`${def.endpoint}/${id}`),
    onSuccess: done,
    onError: (err) => Alert.alert(t('Not deleted'), `${errorMessage(err)}\n\n${t("Records in use can't be deleted — set them inactive instead.")}`),
  });
  return { isNew, record, save, remove };
}

function FormShell({ title, loading, error, children, onDelete, deleting }: { title: string; loading: boolean; error: unknown; children: ReactNode; onDelete?: () => void; deleting?: boolean }) {
  const c = useColors();
  const { t } = useTranslation();
  return (
    <>
      <Stack.Screen
        options={{
          title,
          headerRight: () =>
            onDelete ? (
              <Pressable onPress={onDelete} hitSlop={10} accessibilityLabel={t('Delete')} style={{ paddingHorizontal: SPACE.sm }}>
                {deleting ? <ActivityIndicator /> : <Trash2Icon size={22} color={c.destructive} />}
              </Pressable>
            ) : null,
        }}
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
          {loading ? <ActivityIndicator style={{ margin: SPACE.xl }} /> : children}
          {!!error && <ErrorBanner message={errorMessage(error)} />}
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

const confirmDelete = (label: string, run: () => void) =>
  Alert.alert(i18n.t('Delete {{name}}?', { name: label }), i18n.t('This cannot be undone.'), [
    { text: i18n.t('Cancel'), style: 'cancel' },
    { text: i18n.t('Delete'), style: 'destructive', onPress: run },
  ]);

// ───────────── Vehicle ─────────────
function VehicleForm({ id }: { id: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { isNew, record, save, remove } = useRecord<TrackedObjectDto>('vehicles', id);
  const r = record.data;
  const [f, setF] = useState({ name: '', type: 'VEHICLE' as ObjectType, vehicleType: 'CAR' as VehicleType | null, plateNumber: '', make: '', model: '', color: '', branchId: null as string | null, speedLimitKph: '', deviceId: null as string | null, isActive: true });
  useEffect(() => {
    if (r)
      setF({ name: r.name, type: r.type, vehicleType: r.vehicleType, plateNumber: r.plateNumber ?? '', make: r.make ?? '', model: r.model ?? '', color: r.color ?? '', branchId: r.branchId, speedLimitKph: r.speedLimitKph ? String(r.speedLimitKph) : '', deviceId: r.device?.id ?? null, isActive: r.isActive });
  }, [r]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const branches = useOptions<BranchDto>('/branches', (b) => ({ value: b.id, label: b.name }), can('branches'));
  const freeDevices = useOptions<DeviceDto>('/devices', (d) => ({ value: d.id, label: `${d.uniqueId} · ${d.modelName}` }), can('devices'), { assigned: false });
  const deviceOptions = r?.device && !freeDevices.some((o) => o.value === r.device!.id) ? [{ value: r.device.id, label: `${r.device.uniqueId} · ${r.device.modelName}` }, ...freeDevices] : freeDevices;
  const limit = f.speedLimitKph.trim() === '' ? null : Number(f.speedLimitKph);
  const limitError = limit !== null && (!Number.isInteger(limit) || limit < 5 || limit > 250) ? t('5 – 250 km/h') : undefined;
  const submit = () => {
    if (!f.name.trim()) return Alert.alert(t('Name is required'));
    if (limitError) return;
    save.mutate({
      name: f.name.trim(),
      type: f.type,
      vehicleType: f.type === 'VEHICLE' ? f.vehicleType : null,
      plateNumber: blankToNull(f.plateNumber),
      make: blankToNull(f.make),
      model: blankToNull(f.model),
      color: blankToNull(f.color),
      ...(can('branches') ? { branchId: f.branchId } : {}),
      speedLimitKph: limit,
      ...(can('devices') ? { deviceId: f.deviceId } : {}),
      isActive: f.isActive,
    });
  };
  return (
    <FormShell
      title={isNew ? t('Add vehicle') : t('Edit vehicle')}
      loading={!isNew && record.isPending}
      error={save.error ?? record.error}
      onDelete={!isNew && can('objects', 'delete') ? () => confirmDelete(r?.name ?? t('vehicle'), () => remove.mutate()) : undefined}
      deleting={remove.isPending}
    >
      <Field label={t('Name *')} value={f.name} onChangeText={(v) => set('name', v)} placeholder={t('e.g. TN 01 AB 1234')} />
      <ChoiceField label={t('Object type')} value={f.type} allowEmpty={false} options={OBJECT_TYPES.map((o) => ({ value: o, label: t(humanize(o)) }))} onChange={(v) => v && set('type', v as ObjectType)} />
      {f.type === 'VEHICLE' && (
        <ChoiceField label={t('Vehicle type')} value={f.vehicleType} allowEmpty={false} options={VEHICLE_TYPES.map((v) => ({ value: v, label: t(humanize(v)) }))} onChange={(v) => v && set('vehicleType', v as VehicleType)} />
      )}
      <Field label={t('Plate number')} value={f.plateNumber} onChangeText={(v) => set('plateNumber', v)} autoCapitalize="characters" />
      <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
        <View style={{ flex: 1 }}>
          <Field label={t('Make')} value={f.make} onChangeText={(v) => set('make', v)} />
        </View>
        <View style={{ flex: 1 }}>
          <Field label={t('Model')} value={f.model} onChangeText={(v) => set('model', v)} />
        </View>
      </View>
      <Field label={t('Colour')} value={f.color} onChangeText={(v) => set('color', v)} />
      <Field
        label={t('Overspeed alert limit (km/h)')}
        value={f.speedLimitKph}
        onChangeText={(v) => set('speedLimitKph', v.replace(/\D/g, ''))}
        keyboardType="number-pad"
        placeholder={f.vehicleType ? t('Default {{limit}}', { limit: DEFAULT_SPEED_LIMIT_KPH[f.vehicleType] }) : t('e.g. 50')}
        error={limitError}
        hint={t('Overspeed alerts fire above this speed.')}
      />
      {can('branches') && <ChoiceField label={t('Branch')} value={f.branchId} options={branches} emptyLabel={t('No branch')} onChange={(v) => set('branchId', v)} />}
      {can('devices') && <ChoiceField label={t('GPS device')} value={f.deviceId} options={deviceOptions} emptyLabel={t('No device')} onChange={(v) => set('deviceId', v)} />}
      <SwitchRow label={t('Active')} hint={t('Inactive vehicles are hidden from the live map.')} value={f.isActive} onChange={(v) => set('isActive', v)} />
      <Button title={isNew ? t('Add vehicle') : t('Save')} onPress={submit} loading={save.isPending} />
    </FormShell>
  );
}

// ───────────── Device ─────────────
function DeviceForm({ id }: { id: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { isNew, record, save, remove } = useRecord<DeviceDto>('devices', id);
  const r = record.data;
  const [f, setF] = useState({ uniqueId: '', modelId: null as string | null, simNumber: '', simOperator: '', firmware: '', isActive: true });
  useEffect(() => {
    if (r) setF({ uniqueId: r.uniqueId, modelId: r.modelId, simNumber: r.simNumber ?? '', simOperator: r.simOperator ?? '', firmware: r.firmware ?? '', isActive: r.isActive });
  }, [r]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const models = useOptions<DeviceModelDto>('/device-models', (m) => ({ value: m.id, label: `${m.brand} ${m.model} (${m.protocol})` }));
  const submit = () => {
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(f.uniqueId.trim())) return Alert.alert(t('IMEI / ID'), t('Use 4–32 letters, digits, - or _'));
    if (!f.modelId) return Alert.alert(t('Choose the device model'));
    save.mutate({ uniqueId: f.uniqueId.trim(), modelId: f.modelId, simNumber: blankToNull(f.simNumber), simOperator: blankToNull(f.simOperator), firmware: blankToNull(f.firmware), isActive: f.isActive });
  };
  return (
    <FormShell
      title={isNew ? t('Add device') : t('Edit device')}
      loading={!isNew && record.isPending}
      error={save.error ?? record.error}
      onDelete={!isNew && can('devices', 'delete') ? () => confirmDelete(r?.uniqueId ?? t('device'), () => remove.mutate()) : undefined}
      deleting={remove.isPending}
    >
      <Field label={t('IMEI / unique ID *')} value={f.uniqueId} onChangeText={(v) => set('uniqueId', v)} keyboardType="number-pad" placeholder="868120000000001" />
      <ChoiceField label={t('Model *')} value={f.modelId} allowEmpty={false} options={models} emptyLabel={t('Choose a model')} onChange={(v) => set('modelId', v)} />
      <Field label={t('SIM number')} value={f.simNumber} onChangeText={(v) => set('simNumber', v)} keyboardType="phone-pad" />
      <Field label={t('SIM operator')} value={f.simOperator} onChangeText={(v) => set('simOperator', v)} />
      <Field label={t('Firmware')} value={f.firmware} onChangeText={(v) => set('firmware', v)} />
      {r?.object && <Field label={t('Fitted to')} value={r.object.name} editable={false} hint={t("Change the vehicle's device from Vehicles.")} />}
      <SwitchRow label={t('Active')} hint={t('Positions from inactive devices are ignored.')} value={f.isActive} onChange={(v) => set('isActive', v)} />
      <Button title={isNew ? t('Add device') : t('Save')} onPress={submit} loading={save.isPending} />
    </FormShell>
  );
}

// ───────────── Driver ─────────────
function DriverForm({ id }: { id: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { isNew, record, save, remove } = useRecord<DriverDto>('drivers', id);
  const r = record.data;
  const [f, setF] = useState({ name: '', employeeId: '', mobile: '', licenseNo: '', licenseExpiry: null as string | null, rfidTag: '', branchId: null as string | null, notes: '', isActive: true });
  useEffect(() => {
    if (r) setF({ name: r.name, employeeId: r.employeeId ?? '', mobile: r.mobile ?? '', licenseNo: r.licenseNo ?? '', licenseExpiry: r.licenseExpiry, rfidTag: r.rfidTag ?? '', branchId: r.branchId, notes: r.notes ?? '', isActive: r.isActive });
  }, [r]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const branches = useOptions<BranchDto>('/branches', (b) => ({ value: b.id, label: b.name }), can('branches'));
  const mobileError = f.mobile.trim() && !MOBILE.test(f.mobile.trim()) ? t('Use +91… format') : undefined;
  const submit = () => {
    if (!f.name.trim()) return Alert.alert(t('Name is required'));
    if (mobileError) return;
    save.mutate({
      name: f.name.trim(),
      employeeId: blankToNull(f.employeeId),
      mobile: blankToNull(f.mobile),
      licenseNo: blankToNull(f.licenseNo),
      licenseExpiry: f.licenseExpiry,
      rfidTag: blankToNull(f.rfidTag),
      ...(can('branches') ? { branchId: f.branchId } : {}),
      notes: blankToNull(f.notes),
      isActive: f.isActive,
    });
  };
  return (
    <FormShell
      title={isNew ? t('Add driver') : t('Edit driver')}
      loading={!isNew && record.isPending}
      error={save.error ?? record.error}
      onDelete={!isNew && can('drivers', 'delete') ? () => confirmDelete(r?.name ?? t('driver'), () => remove.mutate()) : undefined}
      deleting={remove.isPending}
    >
      <Field label={t('Name *')} value={f.name} onChangeText={(v) => set('name', v)} />
      <Field label={t('Employee ID')} value={f.employeeId} onChangeText={(v) => set('employeeId', v)} />
      <Field label={t('Mobile')} value={f.mobile} onChangeText={(v) => set('mobile', v)} keyboardType="phone-pad" placeholder="+919876543210" error={mobileError} />
      <Field label={t('Licence number')} value={f.licenseNo} onChangeText={(v) => set('licenseNo', v)} autoCapitalize="characters" />
      <View style={{ flexDirection: 'row', gap: SPACE.sm, alignItems: 'flex-end' }}>
        <DateField label={t('Licence expiry')} value={f.licenseExpiry ?? toYmd(new Date())} onChange={(v) => set('licenseExpiry', v)} />
        {f.licenseExpiry && <Button title={t('Clear')} variant="ghost" onPress={() => set('licenseExpiry', null)} style={{ paddingHorizontal: SPACE.sm }} />}
      </View>
      <Field label={t('RFID card / iButton ID')} value={f.rfidTag} onChangeText={(v) => set('rfidTag', v)} autoCapitalize="characters" hint={t('Swiping this card on the tracker logs the driver onto the vehicle.')} />
      {can('branches') && <ChoiceField label={t('Branch')} value={f.branchId} options={branches} emptyLabel={t('All branches')} onChange={(v) => set('branchId', v)} />}
      <Field label={t('Notes')} value={f.notes} onChangeText={(v) => set('notes', v)} multiline style={{ height: 80, textAlignVertical: 'top', paddingTop: 10 }} />
      <SwitchRow label={t('Active')} hint={t("Inactive drivers can't be assigned and their card is ignored.")} value={f.isActive} onChange={(v) => set('isActive', v)} />
      <Button title={isNew ? t('Add driver') : t('Save')} onPress={submit} loading={save.isPending} />
    </FormShell>
  );
}

export default function ManageRecordScreen() {
  const { t } = useTranslation();
  const { kind, id } = useLocalSearchParams<{ kind: string; id: string }>();
  if (!isKind(kind) || !id) return <EmptyState icon={DatabaseIcon} title={t('Not found')} />;
  if (kind === 'vehicles') return <VehicleForm id={id} />;
  if (kind === 'devices') return <DeviceForm id={id} />;
  return <DriverForm id={id} />;
}
