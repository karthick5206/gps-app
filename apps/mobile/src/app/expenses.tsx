import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EXPENSE_KIND_LABELS, EXPENSE_KINDS, formatInr, type ExpenseDto, type ExpenseKind } from '@veetracer/shared';
import * as ImagePicker from 'expo-image-picker';
import { Stack } from 'expo-router';
import { CameraIcon, FuelIcon, ImageIcon, PlusIcon } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, FlatList, Image, Modal, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SelectField, VehiclePicker } from '@/components/pickers';
import { Button, Card, Chips, EmptyState, Field, Text } from '@/components/ui';
import { liveStore } from '@/features/live/live-store';
import { useAuth } from '@/features/auth/auth';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { SPACE, useColors } from '@/lib/theme';

/** Fuel & expenses: recent entries and a form to log a fill-up / cost with a bill photo. */
export default function ExpensesScreen() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: ['expenses', 'recent'], queryFn: ({ signal }) => api.get<ExpenseDto[]>('/expenses', undefined, signal) });
  return (
    <>
      <Stack.Screen options={{ title: t('Fuel & expenses') }} />
      <FlatList
        data={list.data ?? []}
        keyExtractor={(e) => e.id}
        contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.sm, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={list.isRefetching} onRefresh={() => void list.refetch()} />}
        ListHeaderComponent={can('expenses', 'create') ? <Button title={t('Add expense')} icon={PlusIcon} onPress={() => setAdding(true)} style={{ marginBottom: SPACE.xs }} /> : undefined}
        renderItem={({ item: e }) => (
          <Card style={{ gap: 2 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
              <Text weight="600" style={{ flex: 1 }} numberOfLines={1}>
                {e.objectName}
              </Text>
              <Text weight="700">{formatInr(e.amountPaise)}</Text>
            </View>
            <Text size="sm" tone="muted">
              {[t(EXPENSE_KIND_LABELS[e.kind]), e.litres ? `${e.litres} L` : null, formatDateTime(e.at), e.vendor].filter(Boolean).join(' · ')}
              {e.hasPhoto ? ` · ${t('Bill photo')}` : ''}
            </Text>
          </Card>
        )}
        ListEmptyComponent={list.isPending ? <ActivityIndicator style={{ margin: SPACE.xl }} /> : <EmptyState icon={FuelIcon} title={t('No entries yet')} description={t('km per litre and cost per km are on the web: Fuel & expenses.')} />}
      />
      <Modal visible={adding} animationType="slide" onRequestClose={() => setAdding(false)}>
        <AddExpense onClose={() => setAdding(false)} />
      </Modal>
    </>
  );
}

function AddExpense({ onClose }: { onClose: () => void }) {
  const c = useColors();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [objectId, setObjectId] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [kind, setKind] = useState<ExpenseKind>('FUEL');
  const [amount, setAmount] = useState('');
  const [litres, setLitres] = useState('');
  const [vendor, setVendor] = useState('');
  const [photo, setPhoto] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const valid = !!objectId && Number(amount) > 0 && (kind !== 'FUEL' || Number(litres) > 0);
  const vehicle = objectId ? liveStore.get(objectId) : undefined;

  const pick = async (camera: boolean) => {
    if (camera) {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return Alert.alert(t('Camera'), t('Allow the camera to photograph the bill.'));
    }
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.6 };
    const r = camera ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (!r.canceled && r.assets[0]) setPhoto(r.assets[0]);
  };

  const save = useMutation({
    mutationFn: async () => {
      const e = await api.post<ExpenseDto>('/expenses', { objectId, kind, at: new Date().toISOString(), amountPaise: Math.round(Number(amount) * 100), ...(kind === 'FUEL' ? { litres: Number(litres) } : {}), vendor: vendor.trim() || null });
      if (photo) {
        const form = new FormData();
        form.append('file', { uri: photo.uri, name: photo.fileName ?? 'bill.jpg', type: photo.mimeType ?? 'image/jpeg' } as unknown as Blob);
        await api.upload<ExpenseDto>(`/expenses/${e.id}/photo`, form);
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['expenses'] });
      onClose();
    },
    onError: (e) => Alert.alert(t('Could not save'), errorMessage(e)),
  });

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md }} keyboardShouldPersistTaps="handled">
        <Text size="lg" weight="700">
          {t('Add expense')}
        </Text>
        <SelectField label={t('Vehicle')} value={vehicle ? vehicle.plateNumber || vehicle.name : t('Choose a vehicle')} onPress={() => setPicker(true)} />
        <Chips options={EXPENSE_KINDS.map((k) => ({ value: k, label: t(EXPENSE_KIND_LABELS[k]) }))} value={kind} onChange={setKind} />
        <Field label={t('Amount (₹)')} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
        {kind === 'FUEL' && <Field label={t('Litres')} value={litres} onChangeText={setLitres} keyboardType="decimal-pad" />}
        <Field label={t('Fuel station / vendor (optional)')} value={vendor} onChangeText={setVendor} maxLength={120} />
        <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
          <Button title={t('Photo of bill')} icon={CameraIcon} variant="outline" style={{ flex: 1 }} onPress={() => void pick(true)} />
          <Button title={t('Gallery')} icon={ImageIcon} variant="outline" style={{ flex: 1 }} onPress={() => void pick(false)} />
        </View>
        {photo && (
          <Pressable onPress={() => setPhoto(null)} accessibilityLabel={t('Remove photo')}>
            <Image source={{ uri: photo.uri }} style={{ width: '100%', height: 180, borderRadius: 12 }} resizeMode="cover" />
            <Text size="xs" tone="muted" style={{ textAlign: 'center', marginTop: 4 }}>
              {t('Tap the photo to remove it')}
            </Text>
          </Pressable>
        )}
        <Button title={t('Save')} onPress={() => save.mutate()} loading={save.isPending} disabled={!valid} />
        <Button title={t('Cancel')} variant="ghost" onPress={onClose} />
      </ScrollView>
      <VehiclePicker open={picker} onClose={() => setPicker(false)} selected={objectId ? [objectId] : []} onChange={(ids) => setObjectId(ids[0] ?? null)} multiple={false} title={t('Vehicle')} />
    </SafeAreaView>
  );
}
