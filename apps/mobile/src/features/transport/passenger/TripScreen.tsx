import type { MeConfirmKind, MeTripDto, MeVehicleDto } from '@veetracer/shared';
import { router, Stack } from 'expo-router';
import { CheckCircle2Icon, FlagIcon, MapPinIcon, PhoneIcon } from 'lucide-react-native';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, ActivityIndicator, Linking, ScrollView, View } from 'react-native';
import { Card, ErrorBanner, SectionTitle, Text } from '@/components/ui';
import { useAppActive } from '@/lib/motion';
import { currentLocale } from '@/lib/i18n';
import { SPACE, useColors } from '@/lib/theme';
import { DIRECTION_LABEL, PASSENGER_STATUS_META, TRIP_STATE_META } from '../labels';
import { isNotPassenger, transportErrorText, useMyTrip, useMyVehicle, useNow } from '../passenger-api';
import { clockIn, distanceKm, hiddenVehicleText, myMapStops, shouldPollVehicle } from '../trip-window';
import { BigAction, Line, StatusChip, TransportEmpty, TransportMap, useTransportMapStyle, type MapPoint } from '../ui';
import { canConfirm, canReport, CONFIRM_LABEL, confirmKinds } from '../self-service';
import { selfServiceErrorText, useAttemptKey, useConfirmRide, useMyPolicy } from '../self-service-api';
import { SosPanel } from './SosPanel';

/**
 * E5 WP 5.3 passenger actions on the trip (only while the company has self-service on): confirm pickup / drop (owner
 * decision P5: a dispute signal, the driver's record stays what the trip shows) and "Report a problem".
 */
function SelfServiceActions({ tripId, trip, now }: { tripId: string; trip: MeTripDto; now: number }) {
  const { t } = useTranslation();
  const confirm = useConfirmRide(tripId);
  const [key, renewKey] = useAttemptKey();
  const kinds = canConfirm(trip, now) ? confirmKinds(trip.myStatus) : [];
  const send = (kind: MeConfirmKind) => confirm.mutate({ clientEventId: key, kind }, { onSuccess: renewKey });
  const r = confirm.data;
  return (
    <>
      {kinds.map((k) => (
        <BigAction key={k} title={t(CONFIRM_LABEL[k])} icon={CheckCircle2Icon} tone="success" disabled={confirm.isPending} onPress={() => send(k)} />
      ))}
      {r && (
        <Card>
          <Text size="sm">{r.mismatch ? t('Thank you. Your confirmation differs from the driver’s record, so the transport desk will check it.') : t('Thank you. Your confirmation was recorded.')}</Text>
        </Card>
      )}
      {confirm.isError && <ErrorBanner message={selfServiceErrorText(confirm.error, 'confirm')} />}
      {canReport(trip, now) && <BigAction title={t('Report a problem')} icon={FlagIcon} tone="neutral" onPress={() => router.push(`/commute/report/${tripId}`)} />}
    </>
  );
}

/** Plain-language summary of where the vehicle is (the text equivalent of the map, doc 08 §6.2). */
function vehicleSentence(t: (k: string, o?: Record<string, unknown>) => string, trip: MeTripDto, v: Extract<MeVehicleDto, { visible: true }>, locale: string): string {
  const parts = [t('Vehicle position at {{time}}', { time: clockIn(v.fixAt, trip.timeZone, locale) })];
  if (trip.myPickupPoint && trip.myStatus === 'PENDING') {
    const km = distanceKm(v, trip.myPickupPoint);
    parts.push(t('about {{km}} km from your pickup (straight line)', { km: km < 10 ? km.toFixed(1) : Math.round(km) }));
  }
  const eta = v.eta?.at ?? null;
  if (eta) parts.push(t('estimated arrival {{time}}', { time: clockIn(eta, trip.timeZone, locale) }));
  return parts.join(' · ');
}

/**
 * Trip-day view for the passenger: assignment, my pickup / drop, status, and the vehicle on the map ONLY inside the
 * trip window (polled every 15 s while this screen is open and the app is in the foreground; no socket, no background
 * work). The passenger's own phone location is never read here.
 */
export function PassengerTripScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const locale = currentLocale();
  const now = useNow(15_000);
  const active = useAppActive();
  const query = useMyTrip(id);
  const trip = query.data;
  const poll = !!trip && active && shouldPollVehicle(trip, now);
  const vehicle = useMyVehicle(id, poll);
  const hasStyle = !!useTransportMapStyle();
  const policy = useMyPolicy().data;

  // Announce status changes to screen readers (status never only by colour, doc 08 §6.2).
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    if (!trip) return;
    const s = `${t(TRIP_STATE_META[trip.derivedState].label)}, ${t(PASSENGER_STATUS_META[trip.myStatus].label)}`;
    if (lastStatus.current && lastStatus.current !== s) AccessibilityInfo.announceForAccessibility(s);
    lastStatus.current = s;
  }, [trip, t]);

  if (query.isPending) return <ActivityIndicator style={{ margin: SPACE.xl }} accessibilityLabel={t('Loading')} />;
  if (query.isError || !trip) {
    return (
      <View style={{ padding: SPACE.lg }}>
        {isNotPassenger(query.error) ? (
          <TransportEmpty title={t('No passenger profile')} description={t('Your account is not linked to an active passenger profile. Ask your transport desk.')} />
        ) : (
          <ErrorBanner message={transportErrorText(query.error)} onRetry={() => void query.refetch()} />
        )}
      </View>
    );
  }

  const v = poll && vehicle.data?.visible ? vehicle.data : null;
  const mine = myMapStops(trip);
  const points: MapPoint[] = [...mine.map((p) => ({ lat: p.lat, lng: p.lng, kind: p.kind, label: t(p.label) })), ...(v ? [{ lat: v.lat, lng: v.lng, kind: 'vehicle' as const }] : [])];
  const state = TRIP_STATE_META[trip.derivedState];
  const myState = PASSENGER_STATUS_META[trip.myStatus];
  const pickupEta = trip.myStop?.eta?.at ?? null;
  const hiddenText = !poll ? t('The vehicle is shown from 30 minutes before your pickup until the trip ends.') : vehicle.isPending ? t('Looking for the vehicle…') : vehicle.isError ? transportErrorText(vehicle.error) : t(hiddenVehicleText(vehicle.data));

  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }}>
      <Stack.Screen options={{ title: t('My trip') }} />
      <Card style={{ gap: SPACE.sm }}>
        <Text size="lg" weight="700" accessibilityRole="header">
          {trip.serviceDate} · {t(DIRECTION_LABEL[trip.direction])}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs }}>
          <StatusChip label={t(state.label)} tone={state.tone} />
          <StatusChip label={t(myState.label)} tone={myState.tone} />
          {trip.liveVisible && <StatusChip label={t('Vehicle visible now')} tone="info" icon={MapPinIcon} />}
        </View>
      </Card>

      <Card style={{ paddingVertical: 0 }}>
        <Line label={t('My pickup')}>{trip.myStop ? `${clockIn(trip.myStop.plannedAt, trip.timeZone, locale)} · ${trip.myStop.label}` : t('Pickup to be confirmed')}</Line>
        {pickupEta && trip.myStatus === 'PENDING' ? <Line label={t('Estimated pickup')}>{clockIn(pickupEta, trip.timeZone, locale)}</Line> : null}
        <Line label={t('My drop')}>{trip.myDrop ? `${clockIn(trip.myDrop.plannedAt, trip.timeZone, locale)} · ${trip.myDrop.label}` : '—'}</Line>
        <Line label={t('Vehicle')}>{trip.vehicle ? `${trip.vehicle.name}${trip.vehicle.plate ? ` · ${trip.vehicle.plate}` : ''}` : t('Vehicle to be confirmed')}</Line>
        <Line label={t('Driver')}>{trip.driverFirstName ?? '—'}</Line>
        <Line label={t('Trip window')}>{`${clockIn(trip.window.start, trip.timeZone, locale)} – ${clockIn(trip.window.end, trip.timeZone, locale)} (${trip.timeZone})`}</Line>
        <Line label={t('Other passengers')}>{String(trip.coRiders)}</Line>
      </Card>

      {policy?.selfBooking && <SelfServiceActions tripId={id} trip={trip} now={now} />}

      {policy?.sos ? (
        <>
          <SectionTitle>{t('Emergency')}</SectionTitle>
          <SosPanel enabled tripId={id} deskPhone={trip.deskPhone ?? policy.deskPhone} />
        </>
      ) : trip.deskPhone ? (
        <BigAction
          title={t('Call transport desk')}
          icon={PhoneIcon}
          tone="info"
          onPress={() => Linking.openURL(`tel:${(trip.deskPhone ?? '').replace(/[^0-9+]/g, '')}`).catch(() => undefined)}
        />
      ) : null}

      <SectionTitle>{t('Where is my vehicle?')}</SectionTitle>
      {points.length > 0 && <TransportMap points={points} label={v ? t('Map with your vehicle') : t('Map with your pickup and drop')} />}
      <Card style={{ gap: SPACE.xs }}>
        {v ? (
          <>
            <Text weight="600">{vehicleSentence(t, trip, v, locale)}</Text>
            <Text size="xs" tone="muted">
              {v.speedKph !== null ? `${Math.round(v.speedKph)} km/h · ` : ''}
              {t('Updated every 15 seconds')}
            </Text>
          </>
        ) : (
          <Text size="sm" tone="muted">
            {hiddenText}
          </Text>
        )}
        {trip.pointsHidden === 'CONSENT_REQUIRED' && (
          <Text size="xs" tone="muted">
            {t('Your pickup point is not shown: you have not given (or have withdrawn) your transport consent.')}
          </Text>
        )}
        {!hasStyle && (
          <Text size="xs" tone="muted">
            {t('This app build has no map server configured, so the map is not shown.')}
          </Text>
        )}
      </Card>
      <Text size="xs" tone="muted" style={{ textAlign: 'center', color: c.mutedForeground }}>
        {t('VeeTrax does not track your phone. The vehicle is shown only around your trip.')}
      </Text>
    </ScrollView>
  );
}
