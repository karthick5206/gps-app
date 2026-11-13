import type { MeBookingDto } from '@veetracer/shared';
import { router, type Href } from 'expo-router';
import { BellIcon, BellOffIcon, CalendarIcon, CalendarPlusIcon, CarIcon, ChevronRightIcon, MapPinIcon, RepeatIcon, ShieldCheckIcon, TicketIcon, UserIcon, type LucideIcon } from 'lucide-react-native';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Card, ErrorBanner, SectionTitle, Text } from '@/components/ui';
import { pushStatus } from '@/features/notifications/push';
import { RADIUS, SPACE, useColors } from '@/lib/theme';
import { currentLocale } from '@/lib/i18n';
import { bookedForYou, bookingKindLabel, bookingRoute } from '../labels';
import { isNotPassenger, transportErrorText, useMyBookings, useMyConsent, useMyNotices, useMyTrips, useNow } from '../passenger-api';
import { bookingsRoute } from '../push-target';
import { clockIn, nextTrip, tripBuckets } from '../trip-window';
import { useMyPolicy } from '../self-service-api';
import { TOUCH, TransportEmpty } from '../ui';
import { TripCard } from './TripCard';
import { passengerCurrentTrip } from '../sos-context';
import { passengerSos } from '../sos-store';
import { SosPanel } from './SosPanel';

function LinkRow({ icon: Icon, label, href, badge }: { icon: LucideIcon; label: string; href: Href; badge?: number }) {
  const c = useColors();
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={() => router.push(href)}
      accessibilityRole="button"
      accessibilityLabel={badge ? `${label}, ${t('{{n}} new', { n: badge })}` : label}
      style={({ pressed }) => [styles.link, { borderBottomColor: c.border }, pressed && { opacity: 0.6 }]}
    >
      <View style={[styles.linkIcon, { backgroundColor: c.accent }]}>
        <Icon size={20} color={c.accentForeground} />
      </View>
      <Text weight="500" style={{ flex: 1 }}>
        {label}
      </Text>
      {badge ? (
        <View style={[styles.badge, { backgroundColor: c.primary }]}>
          <Text size="xs" weight="700" style={{ color: c.primaryForeground }}>
            {badge > 99 ? '99+' : badge}
          </Text>
        </View>
      ) : null}
      <ChevronRightIcon size={18} color={c.mutedForeground} />
    </Pressable>
  );
}

/** The passenger's own booking; WP 3.9 fields optional (an older server leaves them out). */
type DeskBooking = Omit<MeBookingDto, 'journey' | 'arrangedByDesk'> & Partial<Pick<MeBookingDto, 'journey' | 'arrangedByDesk'>>;

/** WP 3.9: a ride the transport desk booked for the passenger (not on a trip yet); opens it in My bookings. */
function DeskBookingRow({ b }: { b: DeskBooking }) {
  const { t } = useTranslation();
  const c = useColors();
  const locale = currentLocale();
  const kindSource = bookingKindLabel(b);
  const line = [kindSource ? t(kindSource) : null, bookingRoute(b, t)].filter(Boolean).join(' · ');
  const head = `${b.serviceDate} · ${clockIn(b.windowStart, b.timeZone, locale)}–${clockIn(b.windowEnd, b.timeZone, locale)}`;
  return (
    <Pressable
      onPress={() => router.push(bookingsRoute(b.id) as Href)}
      accessibilityRole="button"
      accessibilityLabel={[head, line, t('Arranged by the transport desk')].filter(Boolean).join(', ')}
      accessibilityHint={t('Opens the booking')}
      style={({ pressed }) => [{ minHeight: TOUCH, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs }, pressed && { opacity: 0.85 }]}
    >
      <Text weight="700">{head}</Text>
      {line ? (
        <Text size="sm" tone="muted">
          {line}
        </Text>
      ) : null}
      <Text size="sm" tone="muted">
        {t('Arranged by the transport desk')}
      </Text>
    </Pressable>
  );
}

/**
 * "My commute" home (Passenger shell tab and the fleet shell's My commute entry): consent reminder, the next trip,
 * today's and upcoming trips, links to bookings / notices / consent. Data only from /api/me/transport (own records).
 */
export function CommuteHome() {
  const { t } = useTranslation();
  const c = useColors();
  const now = useNow(30_000);
  const trips = useMyTrips();
  const consent = useMyConsent();
  const notices = useMyNotices();
  const policy = useMyPolicy();
  // WP 3.9: rides the desk booked for me that are not on a trip yet (none on an older server without arrangedByDesk).
  const bookings = useMyBookings();
  const deskBookings = useMemo(() => bookedForYou(bookings.data as DeskBooking[] | undefined), [bookings.data]);
  // SOS context (QA B4): the current trip and the desk phone are remembered on the phone, so the SOS button (header,
  // here, and the offline screen) attaches the trip and offers the call even after an offline cold start.
  const current = useMemo(() => (trips.data ? passengerCurrentTrip(trips.data, now) : undefined), [trips.data, now]);
  const currentDto = current ? trips.data?.find((x) => x.id.toLowerCase() === current.tripId) : undefined;
  const deskPhone = currentDto?.deskPhone ?? policy.data?.deskPhone ?? null;
  const currentTripId = current === undefined ? undefined : (current?.tripId ?? null);
  const currentUntil = current?.until ?? null;
  useEffect(() => {
    if (currentTripId !== undefined) passengerSos.setContext({ tripId: currentTripId, until: currentUntil });
  }, [currentTripId, currentUntil]);
  useEffect(() => {
    if (deskPhone) passengerSos.setContext({ deskPhone });
  }, [deskPhone]);
  const selfBooking = !!policy.data?.selfBooking;
  // WP 3.9 wave 2 (D-A7): ride requests only when the server says so (an older server has no such field).
  const adhocRequests = selfBooking && (policy.data as { adhocRequests?: boolean } | undefined)?.adhocRequests === true;
  const buckets = useMemo(() => tripBuckets(trips.data ?? [], now), [trips.data, now]);
  const next = useMemo(() => nextTrip(trips.data ?? [], now), [trips.data, now]);
  const refreshing = trips.isRefetching || consent.isRefetching;
  const refresh = () => {
    void trips.refetch();
    void consent.refetch();
    void notices.refetch();
    void bookings.refetch();
  };

  if (isNotPassenger(trips.error) || isNotPassenger(consent.error)) {
    return (
      <View style={{ padding: SPACE.lg }}>
        <TransportEmpty title={t('No passenger profile')} description={t('Your account is not linked to an active passenger profile. Ask your transport desk.')} />
      </View>
    );
  }

  const routingConsent = consent.data?.find((s) => s.purpose === 'TRANSPORT_PROFILE');
  const needsConsent = consent.isSuccess && !routingConsent?.active;
  const recentNotices = (notices.data ?? []).filter((n) => now - Date.parse(n.createdAt) < 7 * 24 * 3600_000).length;

  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
      {needsConsent && (
        <Card style={{ gap: SPACE.sm }}>
          <View style={{ flexDirection: 'row', gap: SPACE.sm, alignItems: 'center' }}>
            <ShieldCheckIcon size={22} color={c.warning} />
            <Text weight="700" style={{ flex: 1 }} accessibilityRole="header">
              {t('Your consent is needed')}
            </Text>
          </View>
          <Text size="sm" tone="muted">
            {t('Without your transport consent your pickup point is not used for planning and is not shown to you. Read the notice and decide.')}
          </Text>
          <Pressable onPress={() => router.push('/commute/consent')} accessibilityRole="button" style={{ minHeight: TOUCH, justifyContent: 'center' }}>
            <Text weight="700" tone="primary">
              {t('Read the notice')}
            </Text>
          </Pressable>
        </Card>
      )}

      {pushStatus && (
        <Card style={{ flexDirection: 'row', gap: SPACE.sm, alignItems: 'center' }}>
          <BellOffIcon size={20} color={c.mutedForeground} />
          <Text size="sm" tone="muted" style={{ flex: 1 }}>
            {t('Notifications are off on this phone: check this screen for pickup changes.')} ({t(pushStatus)})
          </Text>
        </Card>
      )}

      {current && policy.data?.sos !== false ? (
        <>
          <SectionTitle>{t('Emergency')}</SectionTitle>
          <SosPanel channel={passengerSos} tripId={current.tripId} deskPhone={deskPhone} />
        </>
      ) : null}

      <SectionTitle>{t('Next trip')}</SectionTitle>
      {trips.isPending ? (
        <ActivityIndicator style={{ margin: SPACE.lg }} accessibilityLabel={t('Loading')} />
      ) : trips.isError ? (
        <ErrorBanner message={transportErrorText(trips.error)} onRetry={() => void trips.refetch()} />
      ) : next ? (
        <TripCard trip={next} highlight testID="next-trip-card" />
      ) : (
        <TransportEmpty icon={CalendarIcon} title={t('No trips in the next days')} description={t('When the transport desk seats you on a trip, it appears here.')} />
      )}

      {deskBookings.length > 0 && (
        <>
          <SectionTitle>{t('Booked for you')}</SectionTitle>
          {deskBookings.map((b) => (
            <DeskBookingRow key={b.id} b={b} />
          ))}
        </>
      )}

      {buckets.today.filter((x) => x.id !== next?.id).length > 0 && (
        <>
          <SectionTitle>{t('Today')}</SectionTitle>
          {buckets.today.filter((x) => x.id !== next?.id).map((trip) => <TripCard key={trip.passengerTripId} trip={trip} />)}
        </>
      )}
      {buckets.upcoming.filter((x) => x.id !== next?.id).length > 0 && (
        <>
          <SectionTitle>{t('Upcoming trips')}</SectionTitle>
          {buckets.upcoming.filter((x) => x.id !== next?.id).map((trip) => <TripCard key={trip.passengerTripId} trip={trip} />)}
        </>
      )}
      {buckets.past.length > 0 && (
        <>
          <SectionTitle>{t('Recent trips')}</SectionTitle>
          {buckets.past.slice(0, 5).map((trip) => <TripCard key={trip.passengerTripId} trip={trip} />)}
        </>
      )}

      <Card style={{ paddingVertical: 0 }}>
        {adhocRequests && <LinkRow icon={CarIcon} label={t('Request a ride')} href="/commute/request" />}
        {selfBooking && <LinkRow icon={CalendarPlusIcon} label={t('Book a trip')} href="/commute/book" />}
        {selfBooking && <LinkRow icon={RepeatIcon} label={t('Regular commute')} href="/commute/schedule" />}
        {selfBooking && <LinkRow icon={MapPinIcon} label={t('Saved places')} href="/commute/places" />}
        <LinkRow icon={TicketIcon} label={t('My bookings')} href="/commute/bookings" />
        <LinkRow icon={BellIcon} label={t('Notices')} href="/commute/notices" badge={recentNotices} />
        <LinkRow icon={UserIcon} label={t('My transport profile')} href="/commute/profile" />
        <LinkRow icon={ShieldCheckIcon} label={t('Privacy & consent')} href="/commute/consent" />
      </Card>
      <Text size="xs" tone="muted" style={{ textAlign: 'center' }}>
        {t('VeeTrax does not track your phone. The vehicle is shown only around your trip.')}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  link: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth },
  linkIcon: { width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  badge: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
});
