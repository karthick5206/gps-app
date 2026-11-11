import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TransportNotificationDto, TransportNotificationKind } from '@veetracer/shared';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { Card, Text } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { RADIUS, SPACE, useColors } from '@/lib/theme';
import { TOUCH } from './ui';

/** Generic texts per kind (same English as TRANSPORT_NOTIFICATION_TEXT in @veetracer/shared; translated here). */
const KIND_TEXT: Record<TransportNotificationKind, string> = {
  TRIP_ASSIGNED: 'New trip assigned',
  TRIP_CHANGED: 'Trip updated',
  TRIP_UNASSIGNED: 'Trip removed',
  TRIP_CANCELLED: 'Trip cancelled',
  TRIP_STARTING_SOON: 'Your trip starts soon',
  VEHICLE_APPROACHING: 'Your cab is arriving',
  TRIP_DELAYED: 'Trip delayed',
};

export function useTransportNotifications(audience: 'passenger' | 'driver') {
  const base = audience === 'driver' ? '/driver/v1' : '/me/transport';
  return useQuery({
    queryKey: ['transport-notifications', audience],
    queryFn: ({ signal }) => api.get<TransportNotificationDto[]>(`${base}/notifications`, undefined, signal),
    // 404 = this server does not have the inbox yet: show nothing rather than an error.
    retry: (n, err) => n < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
    refetchInterval: 5 * 60_000,
  });
}

/**
 * In-app transport notifications (the authoritative history; a push is only a wake-up with a generic text, D7).
 * Each row opens the trip, which fetches the details. Unread rows are marked read when the list is shown.
 */
export function TransportInbox({ audience }: { audience: 'passenger' | 'driver' }) {
  const { t } = useTranslation();
  const c = useColors();
  const qc = useQueryClient();
  const q = useTransportNotifications(audience);
  const base = audience === 'driver' ? '/driver/v1' : '/me/transport';
  const markRead = useMutation({
    mutationFn: (ids: string[]) => api.post(`${base}/notifications/read`, { ids }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['transport-notifications', audience] }),
  });
  const unread = (q.data ?? []).filter((n) => !n.readAt).map((n) => n.id);
  const unreadKey = unread.join(',');
  useEffect(() => {
    if (unreadKey) markRead.mutate(unreadKey.split(','));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadKey]);

  if (!q.data?.length) return null;
  return (
    <View style={{ gap: SPACE.sm }}>
      {q.data.map((n) => {
        const title = t(KIND_TEXT[n.kind] ?? n.title);
        const open = () => n.tripId && router.push(audience === 'driver' ? `/duty/trip/${n.tripId}` : `/commute/trip/${n.tripId}`);
        return (
          <Pressable
            key={n.id}
            onPress={open}
            disabled={!n.tripId}
            accessibilityRole={n.tripId ? 'button' : 'text'}
            accessibilityLabel={`${title}, ${formatDateTime(n.createdAt)}${n.readAt ? '' : `, ${t('new')}`}`}
            style={{ minHeight: TOUCH }}
          >
            <Card style={{ flexDirection: 'row', gap: SPACE.sm, alignItems: 'center', borderRadius: RADIUS.md }}>
              {!n.readAt && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.primary }} />}
              <View style={{ flex: 1 }}>
                <Text weight={n.readAt ? '500' : '700'}>{title}</Text>
                <Text size="xs" tone="muted">
                  {formatDateTime(n.createdAt)}
                </Text>
              </View>
            </Card>
          </Pressable>
        );
      })}
    </View>
  );
}
