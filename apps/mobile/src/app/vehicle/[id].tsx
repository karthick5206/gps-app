import { STATUS_META } from '@veetracer/shared';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { BellIcon, CarIcon, HistoryIcon, TerminalIcon } from 'lucide-react-native';
import { useEffect, useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { Button, Card, EmptyState, InfoRow, SectionTitle, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { StatusPill, VehicleThumb } from '@/features/live/components';
import { SpeedLimitRow } from '@/features/live/SpeedLimitEditor';
import { liveStore } from '@/features/live/live-store';
import { useLiveVersion, useNow } from '@/features/live/use-live';
import { FleetMap } from '@/features/map/FleetMap';
import { formatDateTime, relativeTime } from '@/lib/format';
import { SPACE, useColors } from '@/lib/theme';

const yesNo = (v: boolean | null) => (v === null ? '—' : v ? 'On' : 'Off');
const or = (v: number | null, unit: string, digits = 0) => (v === null ? '—' : `${v.toFixed(digits)} ${unit}`.trim());

export default function VehicleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { can } = useAuth();
  const version = useLiveVersion(1000);
  const now = useNow(5000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const o = useMemo(() => liveStore.get(id), [id, version]);
  const objects = useMemo(() => (o ? [o] : []), [o]);

  useEffect(() => {
    if (!o && !liveStore.snapshotLoaded) liveStore.loadSnapshot().catch(() => undefined);
  }, [o]);

  if (!o) {
    return <EmptyState icon={CarIcon} title={liveStore.snapshotLoaded ? 'Vehicle not found' : 'Loading…'} description={liveStore.snapshotLoaded ? 'It may have been removed or you no longer have access.' : undefined} />;
  }
  const hasPosition = o.lat !== null && o.lng !== null;
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: SPACE.xl }}>
      <Stack.Screen options={{ title: o.plateNumber || o.name }} />
      {hasPosition ? (
        <FleetMap objects={objects} selectedId={o.objectId} initialZoom={15} style={{ height: 260, flex: 0 }} />
      ) : (
        <View style={{ height: 120, alignItems: 'center', justifyContent: 'center', backgroundColor: c.muted }}>
          <Text tone="muted">No position received yet</Text>
        </View>
      )}
      <View style={{ padding: SPACE.lg, gap: SPACE.md }}>
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md }}>
            <VehicleThumb o={o} size={44} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text size="lg" weight="700" numberOfLines={1}>
                {o.name}
              </Text>
              <StatusPill o={o} now={now} />
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text size="xl" weight="700">
                {Math.round(o.speedKph)}
              </Text>
              <Text size="xs" tone="muted">
                km/h
              </Text>
            </View>
          </View>
        </Card>

        <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
          {can('history') && <Button title="History" icon={HistoryIcon} variant="outline" style={{ flex: 1 }} onPress={() => router.push(`/history/${o.objectId}`)} />}
          {can('alerts') && <Button title="Alerts" icon={BellIcon} variant="outline" style={{ flex: 1 }} onPress={() => router.push({ pathname: '/alerts', params: { objectId: o.objectId, name: o.plateNumber || o.name } })} />}
        </View>

        {can('live_map', 'command') && <Button title="Commands" icon={TerminalIcon} variant="outline" onPress={() => router.push(`/commands/${o.objectId}`)} />}

        <SectionTitle>Status</SectionTitle>
        <Card style={{ paddingVertical: 0 }}>
          <InfoRow label="Status" value={STATUS_META[o.status].label} />
          <InfoRow label="Since" value={formatDateTime(o.statusSince)} />
          <InfoRow label="Driver" value={o.driverName ? `${o.driverName}${o.driverSource === 'RFID' ? ' (card)' : ''}` : '—'} />
          <InfoRow label="Ignition" value={yesNo(o.ignition)} />
          <SpeedLimitRow o={o} />
          <InfoRow label="Last update" value={`${relativeTime(o.serverTime ?? o.fixTime, now)}`} />
          <InfoRow label="GPS time" value={formatDateTime(o.fixTime)} />
          <InfoRow label="Position" value={hasPosition ? `${o.lat!.toFixed(5)}, ${o.lng!.toFixed(5)}` : '—'} />
        </Card>

        <SectionTitle>Device</SectionTitle>
        <Card style={{ paddingVertical: 0 }}>
          <InfoRow label="IMEI" value={o.uniqueId ?? 'Not assigned'} />
          <InfoRow label="Satellites" value={o.satellites === null ? '—' : String(o.satellites)} />
          <InfoRow label="Mobile signal" value={o.gsmSignal === null ? '—' : `${o.gsmSignal} / 4`} />
          <InfoRow label="Vehicle voltage" value={or(o.extVoltage, 'V', 1)} />
          <InfoRow label="Device battery" value={or(o.batteryLevel, '%')} />
          {o.inMaintenance && <InfoRow label="Maintenance" value="In maintenance (alerts off)" />}
        </Card>
      </View>
    </ScrollView>
  );
}
