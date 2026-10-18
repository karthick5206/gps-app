import { router } from 'expo-router';
import { ChevronRightIcon, LocateFixedIcon, MaximizeIcon } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Card, SearchInput, Text } from '@/components/ui';
import { matches, StatusChips, VehicleSummary, type StatusFilter } from '@/features/live/components';
import { liveStore } from '@/features/live/live-store';
import { useLiveVersion, useNow, useRealtimeStatus } from '@/features/live/use-live';
import { FleetMap, type FleetMapHandle } from '@/features/map/FleetMap';
import { RADIUS, SPACE, useColors } from '@/lib/theme';

export default function LiveMapScreen() {
  const c = useColors();
  const version = useLiveVersion(1000);
  const now = useNow();
  const connection = useRealtimeStatus();
  const map = useRef<FleetMapHandle>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [follow, setFollow] = useState(false);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const all = useMemo(() => liveStore.all(), [version]);
  const visible = useMemo(() => all.filter((o) => matches(o, q, status)), [all, q, status]);
  const selected = selectedId ? liveStore.get(selectedId) : undefined;

  // Frame the fleet once the first snapshot arrives, and again when filters change.
  const framed = useRef(false);
  useEffect(() => {
    if (!framed.current && liveStore.snapshotLoaded && all.length) {
      framed.current = true;
      map.current?.fitAll(all, false);
    }
  }, [all]);
  useEffect(() => {
    if (framed.current) map.current?.fitAll(visible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, status]);
  // Follow mode keeps the selected vehicle centred as it moves.
  useEffect(() => {
    if (follow && selected) map.current?.focus(selected, 16);
  }, [follow, selected]);

  const select = (id: string | null) => {
    setSelectedId(id);
    setFollow(false);
    const o = id ? liveStore.get(id) : undefined;
    if (o) map.current?.focus(o);
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <FleetMap ref={map} objects={visible} selectedId={selectedId} onSelect={select} />

      <SafeAreaView edges={['top']} style={styles.top} pointerEvents="box-none">
        <View style={{ paddingHorizontal: SPACE.lg }}>
          <SearchInput value={q} onChangeText={setQ} placeholder="Search vehicle, plate or IMEI" style={styles.shadow} />
        </View>
        <StatusChips objects={all.filter((o) => matches(o, q, 'ALL'))} value={status} onChange={setStatus} />
        {connection === 'disconnected' && (
          <View style={[styles.offline, { backgroundColor: c.warning }]}>
            <Text size="xs" weight="600" style={{ color: '#fff' }}>
              Reconnecting… positions may be out of date
            </Text>
          </View>
        )}
      </SafeAreaView>

      <View style={styles.fabs} pointerEvents="box-none">
        <Pressable accessibilityLabel="Show all vehicles" onPress={() => map.current?.fitAll(visible)} style={[styles.fab, { backgroundColor: c.card, borderColor: c.border }]}>
          <MaximizeIcon size={20} color={c.foreground} />
        </Pressable>
        {selected && (
          <Pressable
            accessibilityLabel={follow ? 'Stop following' : 'Follow vehicle'}
            onPress={() => setFollow((f) => !f)}
            style={[styles.fab, { backgroundColor: follow ? c.primary : c.card, borderColor: follow ? c.primary : c.border }]}
          >
            <LocateFixedIcon size={20} color={follow ? c.primaryForeground : c.foreground} />
          </Pressable>
        )}
      </View>

      {selected && (
        <Card style={[styles.sheet, styles.shadow]} onPress={() => router.push(`/vehicle/${selected.objectId}`)}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
            <View style={{ flex: 1 }}>
              <VehicleSummary o={selected} now={now} />
            </View>
            <ChevronRightIcon size={20} color={c.mutedForeground} />
          </View>
        </Card>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  top: { position: 'absolute', top: 0, left: 0, right: 0, gap: SPACE.sm, paddingTop: SPACE.sm },
  offline: { alignSelf: 'center', paddingHorizontal: SPACE.md, paddingVertical: 4, borderRadius: RADIUS.full },
  fabs: { position: 'absolute', right: SPACE.lg, bottom: 120, gap: SPACE.sm },
  fab: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, elevation: 3 },
  sheet: { position: 'absolute', left: SPACE.md, right: SPACE.md, bottom: SPACE.md, borderRadius: RADIUS.lg },
  shadow: { shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 4 },
});
