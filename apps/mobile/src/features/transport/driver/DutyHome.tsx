import type { DriverTripSummaryDto } from '@veetracer/shared';
import { router } from 'expo-router';
import { CalendarIcon, CheckIcon, ChevronRightIcon, PhoneIcon, PlayIcon, SquareIcon } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Linking, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { Card, ErrorBanner, SectionTitle, Text } from '@/components/ui';
import { currentLocale } from '@/lib/i18n';
import { RADIUS, SPACE, useColors } from '@/lib/theme';
import { driverErrorText, isNotDriver, useDriverDuty, useDriverMe, useDutyCommand } from '../driver-api';
import { offerTripAction, tripActionState } from '../driver-projection';
import { TRIP_STATE_META, tripKindLabel } from '../labels';
import { queueDriverEvent, useDriverQueue } from '../queue-store';
import { clockIn } from '../trip-window';
import { BigAction, StatusChip, SyncBadge, TOUCH, TransportEmpty } from '../ui';
import { SyncBanner } from './SyncBanner';
import { useNow } from '../passenger-api';
import { driverCurrentTrip } from '../sos-context';
import { driverSos } from '../sos-store';
import { SosEntryButton } from '../SosScreen';

function TripRow({ trip, tz }: { trip: DriverTripSummaryDto; tz: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const locale = currentLocale();
  const q = useDriverQueue();
  const local = q.events.filter((e) => e.tripId === trip.id);
  const ack = tripActionState({ acknowledgedAt: trip.acknowledgedAt, plannedTripStatus: trip.plannedTripStatus }, 'ACKNOWLEDGE', local);
  const [error, setError] = useState<string | null>(null);
  const state = TRIP_STATE_META[trip.derivedState];
  const time = `${clockIn(trip.plannedStart, tz, locale)}–${clockIn(trip.plannedEnd, tz, locale)}`;
  const counts = t('{{stops}} stops · {{n}} passengers', { stops: trip.stopCount, n: trip.passengerCount });
  const acknowledge = async () => {
    setError(null);
    try {
      await queueDriverEvent({ tripId: trip.id, type: 'ACKNOWLEDGE' });
    } catch {
      setError(t('Could not save the action on this phone. Try again.'));
    }
  };
  return (
    <View style={{ borderWidth: 1, borderColor: c.border, backgroundColor: c.card, borderRadius: RADIUS.md, overflow: 'hidden' }}>
      <Pressable
        onPress={() => router.push(`/duty/trip/${trip.id}`)}
        accessibilityRole="button"
        accessibilityLabel={[time, trip.name, t(tripKindLabel(trip)), counts, t(state.label)].join(', ')}
        accessibilityHint={t('Opens the trip')}
        style={({ pressed }) => [{ padding: SPACE.md, gap: SPACE.xs, minHeight: TOUCH }, pressed && { opacity: 0.85 }]}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
          <Text size="lg" weight="700" style={{ flex: 1 }}>
            {time}
          </Text>
          <ChevronRightIcon size={20} color={c.mutedForeground} />
        </View>
        <Text weight="600">{trip.name}</Text>
        <Text size="sm" tone="muted">
          {t(tripKindLabel(trip))} · {counts}
          {trip.vehicle ? ` · ${trip.vehicle.plateNumber ?? trip.vehicle.name}` : ''}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs }}>
          <StatusChip label={t(state.label)} tone={state.tone} />
          {ack.display === 'CONFIRMED' ? <StatusChip label={t('Acknowledged')} tone="success" icon={CheckIcon} /> : <SyncBadge state={ack.display} code={ack.code} />}
        </View>
      </Pressable>
      {offerTripAction(trip.allowedActions.includes('acknowledge'), ack) && (
        <View style={{ padding: SPACE.md, paddingTop: 0 }}>
          <BigAction title={t('Acknowledge trip')} icon={CheckIcon} onPress={() => void acknowledge()} hint={t('Saved on this phone and synced when online')} />
        </View>
      )}
      {error && (
        <View style={{ padding: SPACE.md, paddingTop: 0 }}>
          <ErrorBanner message={error} />
        </View>
      )}
    </View>
  );
}

/**
 * Driver home ("Today"): who I am, duty (start / end: online only), the sync banner, and today's assigned trips with
 * Acknowledge (queued offline). Driver tab and "My transport duty" inside the fleet shell.
 */
export function DutyHome() {
  const { t } = useTranslation();
  const me = useDriverMe();
  const duty = useDriverDuty();
  const dutyCmd = useDutyCommand();
  // Driver SOS context (doc 09 §7.3, r114): the current trip and the dispatcher phone are remembered on the phone, so
  // the SOS attaches the trip and offers the call also after an offline cold start.
  const now = useNow(30_000);
  const current = useMemo(() => (duty.data ? driverCurrentTrip(duty.data.trips, now) : undefined), [duty.data, now]);
  const currentTripId = current === undefined ? undefined : (current?.tripId ?? null);
  const currentUntil = current?.until ?? null;
  useEffect(() => {
    if (currentTripId !== undefined) driverSos.setContext({ tripId: currentTripId, until: currentUntil });
  }, [currentTripId, currentUntil]);
  const dispatcherPhone = me.data?.dispatcherPhone ?? null;
  useEffect(() => {
    if (dispatcherPhone) driverSos.setContext({ deskPhone: dispatcherPhone });
  }, [dispatcherPhone]);
  const refresh = () => {
    void me.refetch();
    void duty.refetch();
  };

  if (isNotDriver(me.error) || isNotDriver(duty.error)) {
    return (
      <View style={{ padding: SPACE.lg }}>
        <TransportEmpty title={t('No driver profile')} description={driverErrorText(me.error ?? duty.error)} />
      </View>
    );
  }
  if (me.isPending || duty.isPending) return <ActivityIndicator style={{ margin: SPACE.xl }} accessibilityLabel={t('Loading')} />;

  const open = duty.data?.duty?.status === 'OPEN' ? duty.data.duty : null;
  const tz = duty.data?.timeZone ?? me.data?.company.timeZone ?? 'Asia/Kolkata';
  const confirmEnd = () =>
    Alert.alert(t('End duty?'), t('You can start a new duty later.'), [
      { text: t('Cancel'), style: 'cancel' },
      { text: t('End duty'), style: 'destructive', onPress: () => dutyCmd.mutate({ kind: 'end' }) },
    ]);

  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }} refreshControl={<RefreshControl refreshing={me.isRefetching || duty.isRefetching} onRefresh={refresh} />}>
      <SyncBanner />
      <SosEntryButton audience="driver" />
      {!!(me.error || duty.error) && <ErrorBanner message={driverErrorText(me.error ?? duty.error)} onRetry={refresh} />}

      {me.data && (
        <Card style={{ gap: SPACE.sm }}>
          <Text size="lg" weight="700" accessibilityRole="header">
            {t('Hello, {{name}}', { name: me.data.driver.firstName })}
          </Text>
          {!me.data.documents.licenseValid && <StatusChip label={t('Your licence has expired. Trips cannot be started.')} tone="destructive" />}
          <Text size="sm" tone="muted">
            {open
              ? t('On duty since {{time}}', { time: clockIn(open.startedAt, tz, currentLocale()) }) + (open.vehicle ? ` · ${open.vehicle.plateNumber ?? open.vehicle.name}` : '')
              : t('Off duty')}
          </Text>
          {dutyCmd.isError && <ErrorBanner message={driverErrorText(dutyCmd.error)} />}
          {open ? (
            <BigAction title={t('End duty')} icon={SquareIcon} tone="neutral" onPress={confirmEnd} disabled={dutyCmd.isPending} hint={t('Needs a connection')} />
          ) : (
            <BigAction title={t('Start duty')} icon={PlayIcon} onPress={() => dutyCmd.mutate({ kind: 'start' })} disabled={dutyCmd.isPending} hint={t('Needs a connection')} />
          )}
          {me.data.dispatcherPhone ? (
            <BigAction
              title={t('Call dispatcher')}
              icon={PhoneIcon}
              tone="info"
              onPress={() => Linking.openURL(`tel:${(me.data?.dispatcherPhone ?? '').replace(/[^0-9+]/g, '')}`).catch(() => undefined)}
            />
          ) : null}
        </Card>
      )}

      <SectionTitle>{t("Today's trips")}</SectionTitle>
      {duty.data && duty.data.trips.length > 0 ? (
        duty.data.trips.map((trip) => <TripRow key={trip.id} trip={trip} tz={tz} />)
      ) : (
        <TransportEmpty icon={CalendarIcon} title={t('No trips today')} description={t('Trips the dispatcher assigns to you appear here.')} />
      )}
      <Text size="xs" tone="muted" style={{ textAlign: 'center' }}>
        {t('The vehicle GPS tracks the trip. This app never sends your phone’s location.')}
      </Text>
    </ScrollView>
  );
}
