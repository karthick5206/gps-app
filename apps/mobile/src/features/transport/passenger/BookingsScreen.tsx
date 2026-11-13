import { ACTIVE_BOOKING_STATUSES, type MeBookingDto } from '@veetracer/shared';
import { router } from 'expo-router';
import { TicketIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, View } from 'react-native';
import { Button, Card, ErrorBanner, Text } from '@/components/ui';
import { currentLocale } from '@/lib/i18n';
import { RADIUS, SPACE, useColors } from '@/lib/theme';
import { ARRANGED_BY_DESK_LABEL, arrangedByDesk, BOOKING_STATUS_META, bookingKindLabel, bookingRoute, focusBookings } from '../labels';
import { cancellable, isNotPassenger, transportErrorText, useCancelBooking, useMyBooking, useMyBookings, useNow } from '../passenger-api';
import { passengerStatusLine, passengerStatusMeta } from '../adhoc-request';
import { ApiError } from '@/lib/api';
import { clockIn, cutoffState, cutoffText } from '../trip-window';
import { StatusChip, TOUCH, TransportEmpty } from '../ui';
import { useMyPolicy } from '../self-service-api';

/**
 * The passenger's own booking (fields an older server may leave out are optional: WP 3.9 `journey` / `arrangedByDesk`).
 */
type Booking = Omit<MeBookingDto, 'journey' | 'arrangedByDesk'> &
  Partial<Pick<MeBookingDto, 'journey' | 'arrangedByDesk'>> & {
    /** WP 3.9 wave 2 (optional until the server sends them): why the ride is needed, approval state, reject reason. */
    purpose?: string | null;
    needsApproval?: boolean;
    statusReason?: string | null;
  };

function BookingRow({ b, focused }: { b: Booking; focused?: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const locale = currentLocale();
  // WP 3.9 wave 2 (D-A5): Requested / Approved / Rejected for the passenger's own requests.
  const meta = passengerStatusMeta(b, BOOKING_STATUS_META);
  const statusLine = passengerStatusLine(b);
  const statusText = statusLine ? t(statusLine.text, statusLine.reason ? { reason: statusLine.reason } : undefined) : null;
  const purpose = typeof b.purpose === 'string' && b.purpose.trim() ? b.purpose.trim() : null;
  const window = `${clockIn(b.windowStart, b.timeZone, locale)}–${clockIn(b.windowEnd, b.timeZone, locale)}`;
  // WP 3.9: "Point-to-point" instead of the to / from site wording; pickup → destination from the labels only.
  const kindSource = bookingKindLabel(b);
  const kind = kindSource ? t(kindSource) : null;
  const route = bookingRoute(b, t) ?? '—';
  const byDesk = arrangedByDesk(b);
  const now = useNow();
  const active = (ACTIVE_BOOKING_STATUSES as readonly string[]).includes(b.status);
  // The cut-off is computed by the server (MeBookingDto.cutoffAt); shown in the booking's own zone.
  const cut = active ? cutoffState(b.cutoffAt, now) : 'NONE';
  const cutoff = cutoffText(b.cutoffAt, b.timeZone, locale);
  const cutoffLine =
    cut === 'OPEN'
      ? t('Cancel by {{time}}', { time: cutoff })
      : cut === 'PASSED'
        ? t('Cancellation cut-off passed ({{time}}). To change this booking, call your transport desk.', { time: cutoff })
        : null;
  const body = (
    <>
      <Text weight="700">
        {b.serviceDate} · {window}
      </Text>
      <Text size="sm" tone="muted">
        {[kind, route].filter(Boolean).join(' · ')}
      </Text>
      {purpose && (
        <Text size="sm" tone="muted">
          {t('Purpose: {{purpose}}', { purpose })}
        </Text>
      )}
      {byDesk && (
        <Text size="sm" tone="muted">
          {t('Arranged by the transport desk')}
        </Text>
      )}
      {cutoffLine && (
        <Text size="sm" tone="muted">
          {cutoffLine}
        </Text>
      )}
      <StatusChip label={t(meta.label)} tone={meta.tone} />
      {statusText && (
        <Text size="sm" tone={b.status === 'REJECTED' ? 'destructive' : 'muted'}>
          {statusText}
        </Text>
      )}
    </>
  );
  const style = { minHeight: TOUCH, borderWidth: focused ? 2 : 1, borderColor: focused ? c.primary : c.border, backgroundColor: c.card, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs };
  const label = [b.serviceDate, window, kind, route, purpose ? t('Purpose: {{purpose}}', { purpose }) : null, byDesk ? t(ARRANGED_BY_DESK_LABEL) : null, t(meta.label), statusText, cutoffLine].filter(Boolean).join(', ');
  const cancel = useCancelBooking();
  const confirmCancel = () =>
    Alert.alert(
      t('Cancel this booking?'),
      [
        `${b.serviceDate} · ${window}`,
        cut === 'OPEN' ? t('You can cancel until {{time}}.', { time: cutoff }) : null,
        t('This is possible only before the booking cut-off and before the trip starts. Your seat is given up.'),
      ]
        .filter(Boolean)
        .join('\n'),
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
  if (!cancellable(b, now)) return row;
  return (
    <View style={{ gap: SPACE.xs }}>
      {row}
      {cancel.isError && <ErrorBanner message={transportErrorText(cancel.error)} />}
      <Button title={t('Cancel booking')} variant="outline" onPress={confirmCancel} loading={cancel.isPending} style={{ minHeight: TOUCH }} />
    </View>
  );
}

/** The focused booking from the detail route when loaded; 404 = not in the list any more; otherwise the list's own. */
function focusedRows(list: Booking[], focusId: string | null, detail: Booking | undefined, error: unknown): { rows: Booking[]; focusMissing: boolean } {
  if (focusId && detail) return { rows: [detail, ...list.filter((b) => b.id.toLowerCase() !== focusId)], focusMissing: false };
  if (focusId && error instanceof ApiError && error.status === 404) return { rows: list, focusMissing: true };
  return focusBookings(list, focusId);
}

/**
 * My bookings. Active ones can be cancelled by the passenger (confirm step; online only) before the cut-off and before
 * the trip starts; the server refuses later cancels (AFTER_CUTOFF / INVALID_STATE) and the screen says to call the desk.
 */
export function BookingsScreen({ focusId = null }: { focusId?: string | null } = {}) {
  const { t } = useTranslation();
  const q = useMyBookings();
  const policy = useMyPolicy().data as ({ selfBooking: boolean; adhocRequests?: boolean } | undefined);
  const selfBooking = !!policy?.selfBooking;
  const adhocRequests = selfBooking && policy?.adhocRequests === true;
  // WP 3.9: opened from a booking notification (`focusId` = a validated booking id): that booking first. Wave 2: the
  // booking itself comes from GET /me/transport/bookings/:id (also one outside the list's range); 404 = no longer yours.
  const detail = useMyBooking(focusId);
  const { rows, focusMissing } = focusedRows((q.data ?? []) as Booking[], focusId, detail.data as Booking | undefined, detail.error);
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
      data={rows}
      keyExtractor={(b) => b.id}
      renderItem={({ item }) => <BookingRow b={item} focused={!!focusId && item.id.toLowerCase() === focusId} />}
      contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.sm, paddingBottom: SPACE.xl }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />}
      ListHeaderComponent={
        <View style={{ gap: SPACE.sm, marginBottom: SPACE.sm }}>
          {q.isError && <ErrorBanner message={transportErrorText(q.error)} onRetry={() => void q.refetch()} />}
          {q.isSuccess && focusMissing && (
            <Card>
              <Text size="sm" tone="muted">
                {t('This booking is no longer in your list. It may have been cancelled or already taken place.')}
              </Text>
            </Card>
          )}
          {adhocRequests && <Button title={t('Request a ride')} onPress={() => router.push('/commute/request')} style={{ minHeight: TOUCH }} />}
          {selfBooking && <Button title={t('Book a trip')} onPress={() => router.push('/commute/book')} style={{ minHeight: TOUCH }} />}
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
