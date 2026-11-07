import { useQuery } from '@tanstack/react-query';
import { displayStatus, displayStatusLabel, personActivity, type VideoChannelsDto, chargeState } from '@veetracer/shared';
import * as WebBrowser from 'expo-web-browser';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { BellIcon, CarIcon, HistoryIcon, ScanFaceIcon, TerminalIcon, VideoIcon, Share2Icon } from 'lucide-react-native';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
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
import { chargeText, useDayStats } from '@/features/live/day-stats';
import { RADIUS, SPACE, statusColor, useColors, useScheme } from '@/lib/theme';

function AddressRow({ lat, lng }: { lat: number | null; lng: number | null }) {
  const { address } = useAddress(lat, lng);
  return address ? <InfoRow label={i18n.t('Address')} value={address} /> : null;
}

const yesNo = (v: boolean | null) => (v === null ? '—' : v ? i18n.t('On') : i18n.t('Off'));
const or = (v: number | null, unit: string, digits = 0) => (v === null ? '—' : `${v.toFixed(digits)} ${unit}`.trim());

const kmText = (v: number) => (v >= 100 ? `${Math.round(v).toLocaleString('en-IN')} km` : `${v.toFixed(1)} km`);

export default function VehicleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const scheme = useScheme();
  const { t } = useTranslation();
  const { can } = useAuth();
  const version = useLiveVersion(1000);
  const now = useNow(5000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const o = useMemo(() => liveStore.get(id), [id, version]);
  const objects = useMemo(() => (o ? [o] : []), [o]);
  const day = useDayStats().data?.[id];
  // A large map: about 45 % of the screen (never under 260 dp).
  const mapH = Math.max(260, Math.round(useWindowDimensions().height * 0.45));
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
        <FleetMap objects={objects} selectedId={o.objectId} initialZoom={15} style={{ height: mapH, flex: 0 }} />
      ) : (
        <View style={{ height: 120, alignItems: 'center', justifyContent: 'center', backgroundColor: c.muted }}>
          <Text tone="muted">{t('No position received yet')}</Text>
        </View>
      )}
      <View style={{ padding: SPACE.lg, gap: SPACE.md }}>
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md }}>
            {/* Vehicle icon on a soft circle in its status colour, as on the map and in the list. */}
            <View style={{ width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', backgroundColor: `${statusColor(personActivity(o) ? displayStatus(o) : o.status, scheme)}1f` }}>
              <VehicleThumb o={o} size={40} />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <Text size="lg" weight="700" numberOfLines={1}>
                {o.name}
              </Text>
              {o.plateNumber && o.plateNumber !== o.name ? (
                <Text size="sm" tone="muted" numberOfLines={1}>
                  {o.plateNumber}
                </Text>
              ) : null}
              <StatusPill o={o} now={now} />
            </View>
          </View>
        </Card>

        <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
          {(
            [
              [t('Speed'), `${Math.round(o.speedKph)}`, 'km/h'],
              [t('Last update'), relativeTime(o.serverTime ?? o.fixTime, now), ''],
              [t('Ignition'), yesNo(o.ignition), ''],
            ] as const
          ).map(([label, value, unit]) => (
            <Card key={label} style={{ flex: 1, gap: 2, padding: SPACE.md }}>
              <Text size="xs" tone="muted" weight="600" numberOfLines={1}>
                {label}
              </Text>
              <Text size="lg" weight="700" numberOfLines={1}>
                {value}
                {unit ? <Text size="xs" tone="muted">{` ${unit}`}</Text> : null}
              </Text>
            </Card>
          ))}
        </View>

        {/* Distance: today so far and the odometer (recorded km + the vehicle's odometer offset). */}
        {day ? (
          <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
            {(
              [
                [t('Today'), kmText(day.distanceKm)],
                [t('Odometer'), `${Math.round(day.odometerKm).toLocaleString('en-IN')} km`],
              ] as const
            ).map(([label, value]) => (
              <Card key={label} style={{ flex: 1, gap: 2, padding: SPACE.md }}>
                <Text size="xs" tone="muted" weight="600">
                  {label}
                </Text>
                <Text size="lg" weight="700" numberOfLines={1}>
                  {value}
                </Text>
              </Card>
            ))}
          </View>
        ) : null}

        {/* Actions as tiles: one tap each. */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm }}>
          {(
            [
              can('history') && [HistoryIcon, t('History'), () => router.push(`/history/${o.objectId}`)],
              can('alerts') && [BellIcon, t('Alerts'), () => router.push({ pathname: '/alerts', params: { objectId: o.objectId, name: o.plateNumber || o.name } })],
              !o.licenceLocked && o.lat !== null && [Share2Icon, t('Share live location'), () => router.push(`/share/${o.objectId}`)],
              can('live_map', 'command') && [TerminalIcon, t('Commands'), () => router.push(`/commands/${o.objectId}`)],
              video.isSuccess && [VideoIcon, t('Video'), () => void WebBrowser.openBrowserAsync(`${SERVER_URL}/video?objectId=${encodeURIComponent(o.objectId)}`)],
              video.isSuccess && can('driver_events') && [ScanFaceIcon, t('Driver events'), () => router.push({ pathname: '/driver-events', params: { objectId: o.objectId } })],
            ].filter(Boolean) as [typeof HistoryIcon, string, () => void][]
          ).map(([Icon, label, onPress]) => (
            <Pressable
              key={label}
              accessibilityRole="button"
              onPress={onPress}
              style={({ pressed }) => [{ flexBasis: '31%', flexGrow: 1, alignItems: 'center', gap: 6, paddingVertical: SPACE.md, paddingHorizontal: SPACE.sm, borderRadius: RADIUS.md, borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.muted : c.card }]}
            >
              <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: c.accent }}>
                <Icon size={20} color={c.accentForeground} />
              </View>
              <Text size="xs" weight="600" numberOfLines={2} style={{ textAlign: 'center' }}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>

        <SectionTitle>{t('Status')}</SectionTitle>
        <Card style={{ paddingVertical: 0 }}>
          <InfoRow label={t('Status')} value={t(displayStatusLabel(o))} />
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
          <InfoRow label={t('Device battery')} value={`${or(o.batteryLevel, '%')}${chargeState(o)?.kind === 'CHARGER' ? ` · ${chargeText(o, Date.now(), t)}` : ''}`} />
          {chargeState(o)?.kind === 'MAIN_POWER' && <InfoRow label={t('Main power')} value={chargeText(o, Date.now(), t) ?? '—'} />}
          {o.inMaintenance && <InfoRow label={t('Maintenance')} value={t('In maintenance (alerts off)')} />}
        </Card>
      </View>
    </ScrollView>
  );
}
