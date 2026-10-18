import { useMutation, useQuery } from '@tanstack/react-query';
import { DEFAULT_SPEED_LIMIT_KPH, type LiveObject, type TrackedObjectDto } from '@veetracer/shared';
import { GaugeIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Button, ErrorBanner, Field, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { api, errorMessage } from '@/lib/api';
import { RADIUS, SPACE, useColors } from '@/lib/theme';
import { liveStore } from './live-store';

/** "Overspeed limit" row of the vehicle screen; editable with Vehicles edit permission. */
export function SpeedLimitRow({ o }: { o: LiveObject }) {
  const c = useColors();
  const { can } = useAuth();
  const canEdit = can('objects', 'edit');
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const typeDefault = o.vehicleType ? DEFAULT_SPEED_LIMIT_KPH[o.vehicleType] : null;

  const record = useQuery({
    queryKey: ['object', o.objectId],
    queryFn: ({ signal }) => api.get<TrackedObjectDto>(`/objects/${o.objectId}`, undefined, signal),
    enabled: can('objects'),
  });
  const own = record.data?.speedLimitKph ?? null;
  useEffect(() => {
    if (open) setValue(own === null ? '' : String(own));
  }, [open, own]);

  const save = useMutation({
    mutationFn: (limit: number | null) => api.patch<TrackedObjectDto>(`/objects/${o.objectId}`, { speedLimitKph: limit }),
    onSuccess: () => {
      setOpen(false);
      void record.refetch();
      liveStore.loadSnapshot().catch(() => undefined);
    },
  });
  const parsed = value.trim() === '' ? null : Number(value);
  const invalid = parsed !== null && (!Number.isInteger(parsed) || parsed < 5 || parsed > 250);
  const shown = own ?? o.speedLimitKph;

  return (
    <View style={[styles.row, { borderBottomColor: c.border }]}>
      <Text size="sm" tone="muted">
        Overspeed limit
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
        <Text size="sm" weight="500">
          {shown === null ? '—' : `${shown} km/h${own === null ? ' (default)' : ''}`}
        </Text>
        {canEdit && (
          <Pressable onPress={() => setOpen(true)} hitSlop={8} accessibilityLabel="Edit overspeed limit">
            <Text size="sm" tone="primary" weight="600">
              Edit
            </Text>
          </Pressable>
        )}
      </View>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
          <View style={[styles.dialog, { backgroundColor: c.card }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
              <GaugeIcon size={22} color={c.primary} />
              <Text size="lg" weight="700">
                Overspeed limit
              </Text>
            </View>
            <Text size="sm" tone="muted">
              Overspeed alerts for {o.name} fire above this speed. Leave empty for the default{typeDefault ? ` (${typeDefault} km/h)` : ''}.
            </Text>
            <Field label="Limit (km/h)" value={value} onChangeText={(v) => setValue(v.replace(/\D/g, ''))} keyboardType="number-pad" placeholder="e.g. 50" maxLength={3} error={invalid ? 'Enter 5 – 250 km/h' : undefined} autoFocus />
            {save.isError && <ErrorBanner message={errorMessage(save.error)} />}
            <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
              <Button title="Cancel" variant="outline" style={{ flex: 1 }} onPress={() => setOpen(false)} />
              <Button title="Save" style={{ flex: 1 }} disabled={invalid} loading={save.isPending} onPress={() => save.mutate(parsed)} />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: SPACE.md, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  backdrop: { flex: 1, backgroundColor: '#0008', justifyContent: 'center', padding: SPACE.lg },
  dialog: { borderRadius: RADIUS.lg, padding: SPACE.lg, gap: SPACE.md },
});
