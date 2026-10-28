import { Camera, GeoJSONSource, Layer, Map } from '@maplibre/maplibre-react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ALERT_TYPE_MAP, isDriverEventType, type AlertDto, type DriverEventDto } from '@veetracer/shared';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { CarIcon, CheckIcon, ScanFaceIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Image, Pressable, ScrollView, View } from 'react-native';
import { mediaUri } from '@/features/driver-events/driver-events';
import { Button, Card, ErrorBanner, Field, InfoRow, Pill, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { AlertTypeIcon, SEVERITY_COLOR, SEVERITY_LABEL } from '@/features/alerts/alert-icons';
import { markAlertRead } from '@/features/alerts/read';
import { api, errorMessage } from '@/lib/api';
import { useMapStyle } from '@/features/map/basemap';
import { noFixText } from '@/features/alerts/no-fix';
import { formatDateTime } from '@/lib/format';
import { SPACE } from '@/lib/theme';

const STATUS_LABEL = { NEW: 'New', ACKNOWLEDGED: 'Acknowledged', RESOLVED: 'Resolved' } as const;

export default function AlertScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const mapStyle = useMapStyle();
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');

  const alert = useQuery({ queryKey: ['alerts', 'one', id], queryFn: ({ signal }) => api.get<AlertDto>(`/alerts/${id}`, undefined, signal) });
  const driverEvent = useQuery({
    queryKey: ['driver-events', 'by-alert', id],
    queryFn: ({ signal }) => api.get<{ event: DriverEventDto | null }>(`/driver-events/by-alert/${id}`, undefined, signal).then((r) => r.event),
    enabled: !!alert.data && isDriverEventType(alert.data.type),
  });
  const ack = useMutation({
    mutationFn: () => api.post<AlertDto>(`/alerts/${id}/ack`, note.trim() ? { note: note.trim() } : {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alerts'] }),
  });
  // Opening an alert (from the list or a push tap) marks it read for this user only; the tab badge and list refresh.
  const unreadId = alert.data && !alert.data.read ? alert.data.id : null;
  useEffect(() => {
    if (unreadId) void markAlertRead(queryClient, unreadId);
  }, [unreadId, queryClient]);

  if (alert.isPending) return <ActivityIndicator style={{ margin: SPACE.xl }} />;
  if (alert.isError) {
    return (
      <View style={{ padding: SPACE.lg }}>
        <ErrorBanner message={errorMessage(alert.error)} onRetry={() => alert.refetch()} />
      </View>
    );
  }
  const a = alert.data;
  const label = t(ALERT_TYPE_MAP[a.type]?.label ?? a.type);
  const point = a.lat !== null && a.lng !== null ? ([a.lng, a.lat] as [number, number]) : null;
  const color = SEVERITY_COLOR[a.severity];
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: SPACE.xl }} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: label }} />
      {point && (
        <Map style={{ height: 220 }} mapStyle={mapStyle} logo={false} attributionPosition={{ bottom: 4, left: 8 }}>
          <Camera initialViewState={{ center: point, zoom: 15 }} />
          <GeoJSONSource id="alert" data={{ type: 'Feature', geometry: { type: 'Point', coordinates: point }, properties: {} }}>
            <Layer id="alert-halo" type="circle" paint={{ 'circle-radius': 16, 'circle-color': color, 'circle-opacity': 0.2 }} />
            <Layer id="alert-dot" type="circle" paint={{ 'circle-radius': 7, 'circle-color': color, 'circle-stroke-width': 2.5, 'circle-stroke-color': '#ffffff' }} />
          </GeoJSONSource>
        </Map>
      )}
      <View style={{ padding: SPACE.lg, gap: SPACE.md }}>
        <Card>
          <View style={{ flexDirection: 'row', gap: SPACE.md, alignItems: 'center' }}>
            <AlertTypeIcon type={a.type} severity={a.severity} size={44} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text size="lg" weight="700">
                {label}
              </Text>
              <Pill label={t(SEVERITY_LABEL[a.severity])} color={color} />
            </View>
          </View>
          <Text style={{ marginTop: SPACE.md }}>{a.message}</Text>
        </Card>

        <Card style={{ paddingVertical: 0 }}>
          <InfoRow label={t('Vehicle')} value={a.plateNumber && a.plateNumber !== a.objectName ? `${a.objectName} · ${a.plateNumber}` : a.objectName} />
          <InfoRow label={t('Time')} value={formatDateTime(a.occurredAt)} />
          {a.geofenceName && <InfoRow label={t('Geofence')} value={a.geofenceName} />}
          {a.address && <InfoRow label={t('Address')} value={a.address} />}
          {noFixText(t, a) && <InfoRow label={t('Location')} value={noFixText(t, a)!} />}
          {/* Alerts that don't need acknowledgement are done once opened: no status to show. */}
          {(a.ackRequired || a.status !== 'NEW') && <InfoRow label={t('Status')} value={a.status === 'NEW' ? t('Needs acknowledgement') : t(STATUS_LABEL[a.status])} />}
          {a.ackByName && <InfoRow label={t('Acknowledged by')} value={`${a.ackByName} · ${formatDateTime(a.ackAt)}`} />}
          {a.ackNote && <InfoRow label={t('Note')} value={a.ackNote} />}
        </Card>

        {driverEvent.data?.thumbnailUrl && (
          <Pressable onPress={() => can('driver_events') && router.push(`/driver-events/${driverEvent.data!.id}`)} accessibilityRole="imagebutton" accessibilityLabel={t('Dashcam snapshot')}>
            <Image source={{ uri: mediaUri(driverEvent.data.thumbnailUrl) }} style={{ width: '100%', aspectRatio: 16 / 9, borderRadius: 10, backgroundColor: '#000' }} resizeMode="contain" />
          </Pressable>
        )}
        {driverEvent.data && can('driver_events') && (
          <Button title={t('Open driver event')} icon={ScanFaceIcon} variant="outline" onPress={() => router.push(`/driver-events/${driverEvent.data!.id}`)} />
        )}
        <Button title={t('Open vehicle')} icon={CarIcon} variant="outline" onPress={() => router.push(`/vehicle/${a.objectId}`)} />

        {a.status === 'NEW' && a.ackRequired && can('alerts', 'edit') && (
          <Card style={{ gap: SPACE.md }}>
            <Field label={t('Note (optional)')} value={note} onChangeText={setNote} placeholder={t('What was done?')} maxLength={500} />
            {ack.isError && <ErrorBanner message={errorMessage(ack.error)} />}
            <Button title={t('Acknowledge')} icon={CheckIcon} onPress={() => ack.mutate()} loading={ack.isPending} />
          </Card>
        )}
      </View>
    </ScrollView>
  );
}
