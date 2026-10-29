import { useMutation, useQueryClient } from '@tanstack/react-query';
import { parkingScheduleError, WEEKDAY_SHORT, WEEKDAYS, type ParkingRowDto, type ParkingWindowDto } from '@veetracer/shared';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { PlusIcon, Trash2Icon } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Pressable, ScrollView, Switch, View } from 'react-native';
import { TimeField } from '@/components/pickers';
import { Button, Card, Text } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { RADIUS, SPACE, useColors } from '@/lib/theme';
import { PARKING_QUERY, useParkingRows } from '@/features/parking/parking';

function WindowCard({ w, onChange, onRemove }: { w: ParkingWindowDto; onChange: (w: ParkingWindowDto) => void; onRemove: () => void }) {
  const c = useColors();
  const { t } = useTranslation();
  const toggle = (d: number) => onChange({ ...w, days: w.days.includes(d) ? w.days.filter((x) => x !== d) : [...w.days, d] });
  return (
    <Card style={{ gap: SPACE.md }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {WEEKDAYS.map((d) => {
          const on = w.days.includes(d);
          return (
            <Pressable
              key={d}
              onPress={() => toggle(d)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={{ minWidth: 44, height: 36, paddingHorizontal: 8, borderRadius: RADIUS.full, borderWidth: 1, alignItems: 'center', justifyContent: 'center', borderColor: on ? c.primary : c.border, backgroundColor: on ? c.primary : 'transparent' }}
            >
              <Text size="sm" weight="600" style={{ color: on ? c.primaryForeground : c.foreground }}>
                {t(WEEKDAY_SHORT[d])}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', gap: SPACE.lg }}>
        {[
          [t('Every day'), [0, 1, 2, 3, 4, 5, 6]],
          [t('Mon–Fri'), [1, 2, 3, 4, 5]],
          [t('Weekend'), [0, 6]],
        ].map(([label, days]) => (
          <Pressable key={label as string} onPress={() => onChange({ ...w, days: days as number[] })} hitSlop={6}>
            <Text size="sm" style={{ color: c.primary }}>
              {label as string}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: SPACE.md, alignItems: 'flex-end' }}>
        <TimeField label={t('From')} value={w.startMin} onChange={(startMin) => onChange({ ...w, startMin })} />
        <TimeField label={t('To')} value={w.endMin} onChange={(endMin) => onChange({ ...w, endMin })} />
        <Pressable onPress={onRemove} hitSlop={10} accessibilityLabel={t('Remove time window')} style={{ paddingBottom: 12 }}>
          <Trash2Icon size={20} color={c.mutedForeground} />
        </Pressable>
      </View>
      {w.endMin <= w.startMin && (
        <Text size="xs" tone="muted">
          {t('Ends the next morning')}
        </Text>
      )}
    </Card>
  );
}

/** Schedule of one vehicle: on / off, weekly windows (all seven days), alarm for every alert or the breach only. */
export default function ParkingScheduleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const rows = useParkingRows();
  const row = rows.data?.find((r) => r.objectId === id);
  if (!row) return <ActivityIndicator style={{ margin: SPACE.xl }} />;
  return <Editor row={row} onSaved={() => void qc.invalidateQueries({ queryKey: PARKING_QUERY })} c={c} t={t} />;
}

function Editor({ row, onSaved, c, t }: { row: ParkingRowDto; onSaved: () => void; c: ReturnType<typeof useColors>; t: (k: string, v?: Record<string, unknown>) => string }) {
  const s = row.schedule;
  const [enabled, setEnabled] = useState(s?.enabled ?? true);
  const [alarmAllAlerts, setAlarmAllAlerts] = useState(s?.alarmAllAlerts ?? true);
  const [windows, setWindows] = useState<ParkingWindowDto[]>(s?.windows.length ? s.windows : [{ days: [1, 2, 3, 4, 5], startMin: 22 * 60, endMin: 6 * 60 }]);
  const error = parkingScheduleError({ enabled, windows, alarmAllAlerts });
  const save = useMutation({
    mutationFn: () => api.put<ParkingRowDto[]>('/parking-mode', { objectIds: [row.objectId], enabled, windows, alarmAllAlerts }),
    onSuccess: () => {
      onSaved();
      router.back();
    },
    onError: (e) => Alert.alert(t('Could not save'), errorMessage(e)),
  });
  return (
    <>
      <Stack.Screen options={{ title: row.name }} />
      <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md }}>
        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md }}>
          <View style={{ flex: 1 }}>
            <Text weight="600">{t('Parking mode on')}</Text>
            <Text size="sm" tone="muted">
              {t('Armed during the times below, every week')}
            </Text>
          </View>
          <Switch value={enabled} onValueChange={setEnabled} trackColor={{ true: c.primary }} />
        </Card>
        <View style={{ gap: SPACE.md, opacity: enabled ? 1 : 0.5 }} pointerEvents={enabled ? 'auto' : 'none'}>
          {windows.map((w, i) => (
            <WindowCard key={i} w={w} onChange={(n) => setWindows(windows.map((x, j) => (j === i ? n : x)))} onRemove={() => setWindows(windows.filter((_, j) => j !== i))} />
          ))}
          {windows.length < 10 && <Button title={t('Add time window')} icon={PlusIcon} variant="outline" onPress={() => setWindows([...windows, { days: [0, 6], startMin: 0, endMin: 0 }])} />}
          <Card style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md }}>
            <View style={{ flex: 1 }}>
              <Text weight="600">{t('Alarm for every alert')}</Text>
              <Text size="sm" tone="muted">
                {t('Off: only the parking breach sounds the alarm; other alerts notify as usual.')}
              </Text>
            </View>
            <Switch value={alarmAllAlerts} onValueChange={setAlarmAllAlerts} trackColor={{ true: c.primary }} />
          </Card>
        </View>
        {error && (
          <Text size="sm" style={{ color: c.destructive }}>
            {t(error)}
          </Text>
        )}
        <Button title={t('Save')} onPress={() => save.mutate()} loading={save.isPending} disabled={!!error} />
      </ScrollView>
    </>
  );
}
