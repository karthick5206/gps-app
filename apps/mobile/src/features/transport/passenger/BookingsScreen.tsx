import type { MeBookingDto } from '@veetracer/shared';
import { router } from 'expo-router';
import { TicketIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, View } from 'react-native';
import { Button, Card, ErrorBanner, Text } from '@/components/ui';
import { currentLocale } from '@/lib/i18n';
import { RADIUS, SPACE, useColors } from '@/lib/theme';
import { BOOKING_STATUS_META, DIRECTION_LABEL } from '../labels';
import { cancellable, isNotPassenger, transportErrorText, useCancelBooking, useMyBookings } from '../passenger-api';
import { clockIn } from '../trip-window';
import { StatusChip, TOUCH, TransportEmpty } from '../ui';

function BookingRow({ b }: { b: MeBookingDto }) {
  const { t } = useTranslation();
  const c = useColors();
  const locale = currentLocale();
  const meta = BOOKING_STATUS_META[b.status];
  const window = `${clockIn(b.windowStart, b.timeZone, locale)}–${clockIn(b.windowEnd, b.timeZone, locale)}`;
  const route = [b.pickupLabel, b.dropLabel].filter(Boolean).join(' → ') || '—';
  const body = (
    <>
      <Text weight="700">
        {b.serviceDate} · {window}
      </Text>
      <Text size="sm" tone="muted">
        {t(DIRECTION_LABEL[b.direction])} · {route}
      </Text>
      <StatusChip label={t(meta.label)} tone={meta.tone} />
    </>
  );
  const style = { minHeight: TOUCH, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs };
  const label = `${b.serviceDate}, ${window}, ${t(DIRECTION_LABEL[b.direction])}, ${route}, ${t(meta.label)}`;
  const cancel = useCancelBooking();
  const confirmCancel = () =>
    Alert.alert(
      t('Cancel this booking?'),
      `${b.serviceDate} · ${window}\n${t('This is possible only before the booking cut-off and before the trip starts. Your seat is given up.')}`,
      [
        { text: t('Keep booking'), style: 'cancel' },
        { text: t('Cancel booking'), style: 'destructive', onPress: () => cancel.mutate(b.id) },
      ],
    );
  const row = !b.tripId ? (
    <View style={style} accessible accessibilityLabel={label}>
      {body}
    </View>
  ) : (
    <Pressable onPress={() => router.push(`/commute/trip/${b.tripId}`)} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={t('Opens the trip')} style={({ pressed }) => [style, pressed && { opacity: 0.85 }]}>
      {body}
    </Pressable>
  );
  if (!cancellable(b)) return row;
  return (
    <View style={{ gap: SPACE.xs }}>
      {row}
      {cancel.isError && <ErrorBanner message={transportErrorText(cancel.error)} />}
      <Button title={t('Cancel booking')} variant="outline" onPress={confirmCancel} loading={cancel.isPending} style={{ minHeight: TOUCH }} />
    </View>
  );
}

/**
 * My bookings. Active ones can be cancelled by the passenger (confirm step; online only) before the cut-off and before
 * the trip starts; the server refuses later cancels (AFTER_CUTOFF / INVALID_STATE) and the screen says to call the desk.
 */
export function BookingsScreen() {
  const { t } = useTranslation();
  const q = useMyBookings();
  if (q.isPending) return <ActivityIndicator style={{ margin: SPACE.xl }} accessibilityLabel={t('Loading')} />;
  if (isNotPassenger(q.error)) {
    return (
      <View style={{ padding: SPACE.lg }}>
        <TransportEmpty title={t('No passenger profile')} description={t('Your account is not linked to an active passenger profile. Ask your transport desk.')} />
      </View>
    );
  }
  return (
    <FlatList
      data={q.data ?? []}
      keyExtractor={(b) => b.id}
      renderItem={({ item }) => <BookingRow b={item} />}
      contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.sm, paddingBottom: SPACE.xl }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />}
      ListHeaderComponent={
        <View style={{ gap: SPACE.sm, marginBottom: SPACE.sm }}>
          {q.isError && <ErrorBanner message={transportErrorText(q.error)} onRetry={() => void q.refetch()} />}
          <Card>
            <Text size="sm" tone="muted">
              {t('You can cancel a booking here until its cut-off, as long as the trip has not started. After that, or to change a booking, contact your transport desk.')}
            </Text>
          </Card>
        </View>
      }
      ListEmptyComponent={q.isError ? undefined : <TransportEmpty icon={TicketIcon} title={t('No bookings')} description={t('Bookings come from your regular schedule or are made by the transport desk.')} />}
    />
  );
}
