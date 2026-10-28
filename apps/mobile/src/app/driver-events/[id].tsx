import { Camera, GeoJSONSource, Layer, Map } from '@maplibre/maplibre-react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DriverEventDto, DriverEventStatus } from '@veetracer/shared';
import * as WebBrowser from 'expo-web-browser';
import { Stack, useLocalSearchParams } from 'expo-router';
import { BanIcon, CameraOffIcon, CheckIcon, GraduationCapIcon, RotateCcwIcon, VideoIcon, XIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { Button, Card, ErrorBanner, Field, InfoRow, Pill, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { AlertTypeIcon, SEVERITY_COLOR } from '@/features/alerts/alert-icons';
import { eventLabel, eventSeverity, mediaUri, STATUS_COLOR, STATUS_LABEL, videoUrl } from '@/features/driver-events/driver-events';
import { api, errorMessage } from '@/lib/api';
import { useMapStyle } from '@/features/map/basemap';
import { formatDateTime } from '@/lib/format';
import { SPACE, useColors } from '@/lib/theme';

export default function DriverEventScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  const c = useColors();
  const mapStyle = useMapStyle();
  const { width } = useWindowDimensions();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [zoom, setZoom] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['driver-events', 'one', id],
    queryFn: ({ signal }) => api.get<DriverEventDto>(`/driver-events/${id}`, undefined, signal),
    refetchInterval: 10 * 60_000,
  });
  const e = query.data;
  useEffect(() => setNote(e?.note ?? ''), [e?.id, e?.note]);
  const review = useMutation({
    mutationFn: (status: DriverEventStatus) => api.patch<DriverEventDto>(`/driver-events/${id}/review`, { status, note: note.trim() || null }),
    onSuccess: (row) => {
      qc.setQueryData(['driver-events', 'one', id], row);
      void qc.invalidateQueries({ queryKey: ['driver-events', 'list'] });
    },
  });

  if (query.isPending) return <ActivityIndicator style={{ margin: SPACE.xl }} />;
  if (query.isError || !e) {
    return (
      <View style={{ padding: SPACE.lg }}>
        <ErrorBanner message={errorMessage(query.error)} onRetry={() => void query.refetch()} />
      </View>
    );
  }
  const label = t(eventLabel(e.type));
  const photos = e.media.filter((m) => m.kind === 'PHOTO');
  const point = e.lat !== null && e.lng !== null ? ([e.lng, e.lat] as [number, number]) : null;
  const color = SEVERITY_COLOR[eventSeverity(e.type)];
  const photoW = width - SPACE.lg * 2;
  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: label }} />
      {photos.length ? (
        photos.map((p) => (
          <Pressable key={p.id} onPress={() => setZoom(mediaUri(p.url))} accessibilityRole="imagebutton" accessibilityLabel={t('Snapshot')}>
            <Image source={{ uri: mediaUri(p.url) }} style={{ width: photoW, height: (photoW * 9) / 16, borderRadius: 10, backgroundColor: '#000' }} resizeMode="contain" />
          </Pressable>
        ))
      ) : (
        <Card style={{ alignItems: 'center', gap: SPACE.sm }}>
          <CameraOffIcon size={24} color={c.mutedForeground} />
          <Text size="sm" tone="muted" style={{ textAlign: 'center' }}>
            {t('No snapshot was received from the dashcam for this event.')}
          </Text>
        </Card>
      )}

      <Card>
        <View style={{ flexDirection: 'row', gap: SPACE.md, alignItems: 'center' }}>
          <AlertTypeIcon type={e.type} severity={eventSeverity(e.type)} size={40} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text size="lg" weight="700">
              {label}
            </Text>
            <Pill label={t(STATUS_LABEL[e.status])} color={STATUS_COLOR[e.status]} style={{ alignSelf: 'flex-start' }} />
          </View>
        </View>
      </Card>

      <Card style={{ paddingVertical: 0 }}>
        <InfoRow label={t('Vehicle')} value={e.plateNumber && e.plateNumber !== e.objectName ? `${e.objectName} · ${e.plateNumber}` : e.objectName} />
        <InfoRow label={t('Driver')} value={e.driverName ?? t('Not assigned')} />
        <InfoRow label={t('Time')} value={formatDateTime(e.occurredAt)} />
        {e.speedKph !== null && <InfoRow label={t('Speed')} value={`${Math.round(e.speedKph)} km/h`} />}
        {e.level !== null && <InfoRow label={t('Level')} value={String(e.level)} />}
        {e.address && <InfoRow label={t('Address')} value={e.address} />}
        {e.reviewedByName && <InfoRow label={t('Reviewed by')} value={`${e.reviewedByName} · ${formatDateTime(e.reviewedAt)}`} />}
      </Card>

      {point && (
        <View style={{ height: 200, borderRadius: 10, overflow: 'hidden' }}>
          <Map style={{ flex: 1 }} mapStyle={mapStyle} logo={false} attributionPosition={{ bottom: 4, left: 8 }}>
            <Camera initialViewState={{ center: point, zoom: 15 }} />
            <GeoJSONSource id="event" data={{ type: 'Feature', geometry: { type: 'Point', coordinates: point }, properties: {} }}>
              <Layer id="event-halo" type="circle" paint={{ 'circle-radius': 16, 'circle-color': color, 'circle-opacity': 0.2 }} />
              <Layer id="event-dot" type="circle" paint={{ 'circle-radius': 7, 'circle-color': color, 'circle-stroke-width': 2.5, 'circle-stroke-color': '#ffffff' }} />
            </GeoJSONSource>
          </Map>
        </View>
      )}

      {can('video') && <Button title={t('Watch video')} icon={VideoIcon} variant="outline" onPress={() => void WebBrowser.openBrowserAsync(videoUrl(e.objectId, e.occurredAt))} />}

      {can('driver_events', 'edit') && (
        <Card style={{ gap: SPACE.md }}>
          <Field label={t('Note (optional)')} value={note} onChangeText={setNote} placeholder={t('Note — e.g. spoke to the driver, false alarm')} maxLength={1000} />
          {review.isError && <ErrorBanner message={errorMessage(review.error)} />}
          <Button title={t('Mark reviewed')} icon={CheckIcon} onPress={() => review.mutate('REVIEWED')} loading={review.isPending && review.variables === 'REVIEWED'} disabled={review.isPending} />
          <Button title={t('Driver coached')} icon={GraduationCapIcon} variant="outline" onPress={() => review.mutate('COACHED')} disabled={review.isPending} />
          <Button title={t('Dismiss (false alarm)')} icon={BanIcon} variant="outline" onPress={() => review.mutate('DISMISSED')} disabled={review.isPending} />
          {e.status !== 'NEW' && <Button title={t('Reopen')} icon={RotateCcwIcon} variant="ghost" onPress={() => review.mutate('NEW')} disabled={review.isPending} />}
        </Card>
      )}

      <Modal visible={!!zoom} transparent animationType="fade" onRequestClose={() => setZoom(null)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', justifyContent: 'center' }}>
          {zoom && <Image source={{ uri: zoom }} style={{ width: '100%', height: '80%' }} resizeMode="contain" />}
          <Pressable onPress={() => setZoom(null)} accessibilityRole="button" accessibilityLabel={t('Close')} style={{ position: 'absolute', top: 48, right: 20, padding: 8 }}>
            <XIcon size={28} color="#ffffff" />
          </Pressable>
        </View>
      </Modal>
    </ScrollView>
  );
}
