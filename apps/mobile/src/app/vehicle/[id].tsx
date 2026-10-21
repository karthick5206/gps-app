import { useQuery } from '@tanstack/react-query';
import { STATUS_META, type VideoChannelsDto } from '@veetracer/shared';
import * as WebBrowser from 'expo-web-browser';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { BellIcon, CarIcon, HistoryIcon, ScanFaceIcon, TerminalIcon, VideoIcon } from 'lucide-react-native';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, Pressable, ScrollView, View } from 'react-native';
import { Button, Card, EmptyState, InfoRow, SectionTitle, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { StatusPill, VehicleThumb } from '@/features/live/components';
import { SpeedLimitRow } from '@/features/live/SpeedLimitEditor';
import { liveStore } from '@/features/live/live-store';
import { useLiveVersion, useNow } from '@/features/live/use-live';
import { useAddress } from '@/features/geocoding/use-address';
import { FleetMap } from '@/features/map/FleetMap';
import { api } from '@/lib/api';
import { SERVER_URL } from '@/lib/config';
import { formatDateTime, relativeTime } from '@/lib/format';
import { i18n } from '@/lib/i18n';
import { SPACE, useColors } from '@/lib/theme';

function AddressRow({ lat, lng }: { lat: number | null; lng: number | null }) {
  const { address } = useAddress(lat, lng);
  return address ? <InfoRow label={i18n.t('Address')} value={address} /> : null;
}

const yesNo = (v: boolean | null) => (v === null ? '—' : v ? i18n.t('On') : i18n.t('Off'));
const or = (v: number | null, unit: string, digits = 0) => (v === null ? '—' : `${v.toFixed(digits)} ${unit}`.trim());

export default function VehicleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t } = useTranslation();
  const { can } = useAuth();
  const version = useLiveVersion(1000);
  const now = useNow(5000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const o = useMemo(() => liveStore.get(id), [id, version]);
  const objects = useMemo(() => (o ? [o] : []), [o]);
  // Dashcams only: the API answers NOT_DASHCAM for other trackers. Video plays in the browser (web player, no native deps).
  const video = useQuery({
    queryKey: ['video-channels', id],
    queryFn: () => api.get<VideoChannelsDto>(`/video/${id}/channels`),
    enabled: can('video') && !!o?.deviceId && !o?.licenceLocked,
    retry: false,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (!o && !liveStore.snapshotLoaded) liveStore.loadSnapshot().catch(() => undefined);
  }, [o]);

  if (!o) {
    return <EmptyState icon={CarIcon} title={liveStore.snapshotLoaded ? t('Vehicle not found') : t('Loading…')} description={liveStore.snapshotLoaded ? t('It may have been removed or you no longer have access.') : undefined} />;
  }
  const hasPosition = o.lat !== null && o.lng !== null;
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: SPACE.xl }}>
      <Stack.Screen options={{ title: o.plateNumber || o.name }} />
      {hasPosition ? (
        <FleetMap objects={objects} selectedId={o.objectId} initialZoom={15} style={{ height: 260, flex: 0 }} />
      ) : (
        <View style={{ height: 120, alignItems: 'center', justifyContent: 'center', backgroundColor: c.muted }}>
          <Text tone="muted">{t('No position received yet')}</Text>
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
          {can('history') && <Button title={t('History')} icon={HistoryIcon} variant="outline" style={{ flex: 1 }} onPress={() => router.push(`/history/${o.objectId}`)} />}
          {can('alerts') && <Button title={t('Alerts')} icon={BellIcon} variant="outline" style={{ flex: 1 }} onPress={() => router.push({ pathname: '/alerts', params: { objectId: o.objectId, name: o.plateNumber || o.name } })} />}
        </View>

        {video.isSuccess && (
          <Button title={t('Video')} icon={VideoIcon} variant="outline" onPress={() => void WebBrowser.openBrowserAsync(`${SERVER_URL}/video?objectId=${encodeURIComponent(o.objectId)}`)} />
        )}
        {video.isSuccess && can('driver_events') && (
          <Button title={t('Driver events')} icon={ScanFaceIcon} variant="outline" onPress={() => router.push({ pathname: '/driver-events', params: { objectId: o.objectId } })} />
        )}
        {can('live_map', 'command') && <Button title={t('Commands')} icon={TerminalIcon} variant="outline" onPress={() => router.push(`/commands/${o.objectId}`)} />}

        <SectionTitle>{t('Status')}</SectionTitle>
        <Card style={{ paddingVertical: 0 }}>
          <InfoRow label={t('Status')} value={t(STATUS_META[o.status].label)} />
          <InfoRow label={t('Since')} value={formatDateTime(o.statusSince)} />
          <InfoRow label={t('Driver')} value={o.driverName ? `${o.driverName}${o.driverSource === 'RFID' ? ` ${t('(card)')}` : ''}` : '—'} />
          <InfoRow label={t('Ignition')} value={yesNo(o.ignition)} />
          <SpeedLimitRow o={o} />
          <InfoRow label={t('Last update')} value={`${relativeTime(o.serverTime ?? o.fixTime, now)}`} />
          <InfoRow label={t('GPS time')} value={formatDateTime(o.fixTime)} />
          <AddressRow lat={o.lat} lng={o.lng} />
          <InfoRow label={t('Position')} value={hasPosition ? `${o.lat!.toFixed(5)}, ${o.lng!.toFixed(5)}` : '—'} />
        </Card>

        <SectionTitle>{t('Device')}</SectionTitle>
        <Card style={{ paddingVertical: 0 }}>
          <InfoRow label="IMEI" value={o.uniqueId ?? t('Not assigned')} />
          {o.simNumber ? (
            <Pressable onPress={() => Linking.openURL(`tel:${o.simNumber!.replace(/[^\d+]/g, '')}`).catch(() => undefined)} accessibilityRole="link">
              <InfoRow label={t('SIM number')} value={`${o.simNumber}  ·  ${t('Call')}`} />
            </Pressable>
          ) : (
            <InfoRow label={t('SIM number')} value="—" />
          )}
          <InfoRow label={t('Satellites')} value={o.satellites === null ? '—' : String(o.satellites)} />
          <InfoRow label={t('Mobile signal')} value={o.gsmSignal === null ? '—' : `${o.gsmSignal} / 4`} />
          <InfoRow label={t('Vehicle voltage')} value={or(o.extVoltage, 'V', 1)} />
          {o.acOn !== undefined && (
            <InfoRow label={t('AC')} value={`${o.acOn === null ? '—' : o.acOn ? t('On') : t('Off')}${o.acVoltage != null ? ` (${o.acVoltage.toFixed(1)} V)` : ''}`} />
          )}
          {o.doorOpen !== undefined && (
            <InfoRow label={t('Door')} value={`${o.doorOpen === null ? '—' : o.doorOpen ? t('Open') : t('Closed')}${o.doorVoltage != null ? ` (${o.doorVoltage.toFixed(1)} V)` : ''}`} />
          )}
          {o.fuelL != null && <InfoRow label={t('Fuel')} value={`${o.fuelL.toFixed(1)} L${o.fuelPct != null ? ` · ${Math.round(o.fuelPct)}%` : ''}`} />}
          <InfoRow label={t('Device battery')} value={or(o.batteryLevel, '%')} />
          {o.inMaintenance && <InfoRow label={t('Maintenance')} value={t('In maintenance (alerts off)')} />}
        </Card>
      </View>
    </ScrollView>
  );
}
