import { Camera, GeoJSONSource, Layer, Map } from '@maplibre/maplibre-react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ALERT_TYPE_MAP, type AlertDto } from '@veetracer/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { BellOffIcon, CheckIcon, NavigationIcon, PhoneIcon, SirenIcon, XIcon, type LucideIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { useSiren } from '@/features/notifications/siren';
import { api, errorMessage } from '@/lib/api';
import { MAP_STYLE } from '@/lib/config';
import { formatDateTime, relativeTime } from '@/lib/format';
import { SPACE } from '@/lib/theme';

const RED = '#c62828';
const DARK_RED = '#8e0000';

function SosButton({ icon: Icon, title, onPress, filled, loading }: { icon: LucideIcon; title: string; onPress: () => void; filled?: boolean; loading?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: SPACE.sm,
        minHeight: 56,
        borderRadius: 14,
        paddingHorizontal: SPACE.lg,
        backgroundColor: filled ? '#ffffff' : 'rgba(255,255,255,0.14)',
        borderWidth: filled ? 0 : 1.5,
        borderColor: 'rgba(255,255,255,0.7)',
        opacity: pressed || loading ? 0.7 : 1,
      })}
    >
      {loading ? <ActivityIndicator color={filled ? RED : '#ffffff'} /> : <Icon size={22} color={filled ? RED : '#ffffff'} />}
      <Text size="lg" weight="700" style={{ color: filled ? RED : '#ffffff' }}>
        {title}
      </Text>
    </Pressable>
  );
}

function openDirections(lat: number, lng: number) {
  const url = Platform.OS === 'ios' ? `maps://?daddr=${lat},${lng}&dirflg=d` : `google.navigation:q=${lat},${lng}`;
  const web = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  Linking.openURL(url).catch(() => Linking.openURL(web).catch(() => undefined));
}

/** Full-screen alarm for SOS / crash alerts: loops the siren until acknowledged or silenced. `?test=1` uses no API. */
export default function SosScreen() {
  const { id, test } = useLocalSearchParams<{ id: string; test?: string }>();
  const isTest = test === '1';
  const { t } = useTranslation();
  const { can } = useAuth();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const alert = useQuery({
    queryKey: ['alerts', 'one', id],
    queryFn: ({ signal }) => api.get<AlertDto>(`/alerts/${id}`, undefined, signal),
    enabled: !isTest,
  });
  // Ring for new emergencies only; an alert someone already acknowledged opens silently. If the alert can't be
  // loaded (offline, server down) ring anyway — a missed SOS is worse than a needless siren.
  const { ringing, silence } = useSiren(isTest || alert.data?.status === 'NEW' || alert.isError);
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const ack = useMutation({
    mutationFn: () => api.post<AlertDto>(`/alerts/${id}/ack`, {}),
    onSuccess: () => {
      silence();
      void queryClient.invalidateQueries({ queryKey: ['alerts'] });
      close();
    },
  });

  const a = alert.data;
  const typeLabel = isTest ? t('Test: SOS alarm') : a ? t(ALERT_TYPE_MAP[a.type]?.label ?? a.type) : t('SOS / Emergency');
  const who = isTest ? t('This is a test. No action is needed.') : a ? (a.plateNumber && a.plateNumber !== a.objectName ? `${a.objectName} · ${a.plateNumber}` : a.objectName) : '';
  const point = a && a.lat !== null && a.lng !== null ? ([a.lng, a.lat] as [number, number]) : null;
  const phone = a?.contacts?.driverMobile ?? a?.contacts?.deviceSim ?? null;
  const callLabel = a?.contacts?.driverMobile ? t('Call {{name}}', { name: a.contacts.driverName ?? t('driver') }) : t('Call device');
  const acked = a && a.status !== 'NEW';
  const canAck = isTest || (can('alerts', 'edit') && !acked);

  return (
    <View style={{ flex: 1, backgroundColor: RED }}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + SPACE.lg, paddingBottom: insets.bottom + SPACE.lg, paddingHorizontal: SPACE.lg, gap: SPACE.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md }}>
          <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: DARK_RED, alignItems: 'center', justifyContent: 'center' }}>
            <SirenIcon size={36} color="#ffffff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text size="xl" weight="700" style={{ color: '#ffffff' }}>
              {typeLabel}
            </Text>
            <Text style={{ color: '#ffffffd0' }}>{ringing ? t('Alarm ringing') : t('Alarm silenced')}</Text>
          </View>
        </View>

        {!isTest && alert.isPending && <ActivityIndicator color="#ffffff" style={{ marginVertical: SPACE.lg }} />}
        {!isTest && alert.isError && <Text style={{ color: '#ffffff' }}>{errorMessage(alert.error)}</Text>}

        <View style={{ backgroundColor: DARK_RED, borderRadius: 14, padding: SPACE.lg, gap: 6 }}>
          <Text size="lg" weight="700" style={{ color: '#ffffff' }}>
            {who}
          </Text>
          {a && (
            <Text style={{ color: '#ffffffd0' }}>
              {relativeTime(a.occurredAt, now)} · {formatDateTime(a.occurredAt)}
            </Text>
          )}
          {a?.message ? <Text style={{ color: '#ffffff' }}>{a.message}</Text> : null}
          {a?.address ? <Text style={{ color: '#ffffffd0' }}>{a.address}</Text> : null}
          {acked && a.ackByName ? <Text style={{ color: '#ffffff' }}>{t('Acknowledged by')}: {a.ackByName}</Text> : null}
        </View>

        {point && (
          <View style={{ borderRadius: 14, overflow: 'hidden', height: 180 }}>
            <Map style={{ flex: 1 }} mapStyle={MAP_STYLE.light} logo={false} attributionPosition={{ bottom: 4, left: 8 }}>
              <Camera initialViewState={{ center: point, zoom: 15 }} />
              <GeoJSONSource id="sos" data={{ type: 'Feature', geometry: { type: 'Point', coordinates: point }, properties: {} }}>
                <Layer id="sos-halo" type="circle" paint={{ 'circle-radius': 18, 'circle-color': RED, 'circle-opacity': 0.25 }} />
                <Layer id="sos-dot" type="circle" paint={{ 'circle-radius': 8, 'circle-color': RED, 'circle-stroke-width': 3, 'circle-stroke-color': '#ffffff' }} />
              </GeoJSONSource>
            </Map>
          </View>
        )}

        {canAck && (
          <SosButton
            icon={CheckIcon}
            title={t('Acknowledge')}
            filled
            loading={ack.isPending}
            onPress={() => {
              if (!isTest) return ack.mutate();
              silence();
              close();
            }}
          />
        )}
        {ack.isError && <Text style={{ color: '#ffffff' }}>{errorMessage(ack.error)}</Text>}
        {phone && <SosButton icon={PhoneIcon} title={callLabel} onPress={() => Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`).catch(() => undefined)} />}
        {point && <SosButton icon={NavigationIcon} title={t('Navigate')} onPress={() => openDirections(point[1], point[0])} />}
        {ringing && <SosButton icon={BellOffIcon} title={t('Silence')} onPress={silence} />}
        <SosButton icon={XIcon} title={t('Close')} onPress={close} />
      </ScrollView>
    </View>
  );
}
