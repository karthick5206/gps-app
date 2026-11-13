import type { DriverPassengerDto, DriverStopDto, DriverTripDetailDto, DriverVehicleMotionDto } from '@veetracer/shared';
import { DRIVER_NO_SHOW_REASONS } from '@veetracer/shared';
import { router, Stack } from 'expo-router';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { AccessibilityIcon, AlertTriangleIcon, CheckIcon, FlagIcon, LogOutIcon, MapPinIcon, NavigationIcon, PhoneIcon, PlayIcon, UserCheckIcon, UserXIcon } from 'lucide-react-native';
import { useAppActive } from '@/lib/motion';
import { useNow } from '../passenger-api';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, ActivityIndicator, Alert, Linking, Platform, ScrollView, View } from 'react-native';
import { Card, ErrorBanner, SectionTitle, Text } from '@/components/ui';
import { currentLocale } from '@/lib/i18n';
import { SPACE, useColors } from '@/lib/theme';
import { driverCodeText, driverErrorText, isNotDriver, useDriverMe, useDriverTrip, useStartTrip, useTripMotion } from '../driver-api';
import { countdown, currentStop, noShowAvailableAt, offerTripAction, passengerButtons, passengerPending, pickupUnlocked, stopActionState, tripActionState } from '../driver-projection';
import { DRIVER_EVENT_LABEL, PASSENGER_STATUS_META, REASON_LABEL, TRIP_STATE_META, tripKindLabel } from '../labels';
import { actionAllowed } from '../motion';
import { geoUri } from '../nav-handoff';
import { useNavHandoff } from '../nav-setting';
import { driverQueue, queueDriverEvent, useDriverQueue } from '../queue-store';
import { clockIn } from '../trip-window';
import { BigAction, StatusChip, SyncBadge, TransportEmpty } from '../ui';
import { driverCurrentTrip } from '../sos-context';
import { driverSos } from '../sos-store';
import { SosEntryButton } from '../SosScreen';
import { SyncBanner } from './SyncBanner';
import { useVehicleMotion } from './useVehicleMotion';
import { manifestScreenGuard } from './screen-guard';

/** Doc 09 §7.1 / 10 §6: no screenshots or recordings of the manifest (FLAG_SECURE on Android). */
const useManifestScreenGuard = manifestScreenGuard(usePreventScreenCapture, Platform.OS);

type QueueFn = (input: Parameters<typeof queueDriverEvent>[0]) => Promise<void>;

/** Motion sample for the lock: a stale / missing fix counts as "unknown" (never locked on it). */
function motionSample(m: DriverVehicleMotionDto | null | undefined): { speedKph: number | null; fixAt: string | null } | null {
  if (!m || m.stale || m.speedKph === null) return null;
  return { speedKph: m.speedKph, fixAt: m.fixAt };
}

/** Calls the operator's transport desk (never a passenger). Allowed while moving (doc 09 §5.1). */
function CallButton({ phone, title }: { phone: string | null | undefined; title: string }) {
  const { t } = useTranslation();
  if (!phone) return null;
  return (
    <BigAction
      title={title}
      icon={PhoneIcon}
      tone="info"
      hint={t('Use hands-free while driving')}
      onPress={() => Linking.openURL(`tel:${phone.replace(/[^0-9+]/g, '')}`).catch(() => undefined)}
    />
  );
}

function PassengerRow({ p, stop, tripId, moving, queue, now }: { p: DriverPassengerDto; stop: DriverStopDto; tripId: string; moving: boolean; queue: QueueFn; now: number }) {
  const { t } = useTranslation();
  const c = useColors();
  const q = useDriverQueue();
  const local = q.events.filter((e) => e.tripId === tripId);
  const pending = passengerPending(p, local);
  const buttons = passengerButtons(p, local, stop.seq);
  const atPickup = stop.seq === p.pickupSeq;
  // Event order: ARRIVED first (queued or GPS), then BOARDED / NO_SHOW; NO_SHOW only 5 min after the arrival.
  const unlocked = !atPickup || pickupUnlocked(stop, local);
  const noShowAt = atPickup ? noShowAvailableAt(stop, local) : null;
  const wait = noShowAt ? countdown(noShowAt, now) : null;
  const meta = PASSENGER_STATUS_META[p.status];
  const noShow = () =>
    Alert.alert(
      t('No-show: {{name}}', { name: p.displayName }),
      t('Choose a reason'),
      [
        ...DRIVER_NO_SHOW_REASONS.map((r) => ({ text: t(REASON_LABEL[r] ?? r), onPress: () => void queue({ tripId, type: 'NO_SHOW', passengerTripId: p.passengerTripId, reasonCode: r }) })),
        { text: t('Cancel'), style: 'cancel' as const },
      ],
    );
  return (
    <View style={{ gap: SPACE.xs, paddingVertical: SPACE.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }} accessible accessibilityLabel={[`${p.number}. ${p.displayName}`, p.accessibility ? t('Needs assistance') : null, t(meta.label)].filter(Boolean).join(', ')}>
        <Text weight="700" style={{ flex: 1 }}>
          {p.number}. {p.displayName}
          {p.seats > 1 ? ` (${t('{{n}} seats', { n: p.seats })})` : ''}
        </Text>
        {p.accessibility && <AccessibilityIcon size={18} color={c.info} accessibilityLabel={t('Needs assistance')} />}
        <StatusChip label={t(meta.label)} tone={meta.tone} />
      </View>
      {pending && (
        <View style={{ flexDirection: 'row', gap: SPACE.xs, alignItems: 'center', flexWrap: 'wrap' }}>
          <Text size="sm" tone="muted">
            {t(DRIVER_EVENT_LABEL[pending.type])}:
          </Text>
          <SyncBadge state={pending.state.display} code={pending.state.code} />
          {pending.state.display === 'REJECTED' && pending.state.code ? (
            <Text size="xs" tone="destructive">
              {driverCodeText(pending.state.code)}
            </Text>
          ) : null}
        </View>
      )}
      {!moving && buttons.length > 0 && !unlocked && (
        <Text size="sm" tone="muted">
          {t('Mark the stop as arrived first.')}
        </Text>
      )}
      {!moving && buttons.length > 0 && unlocked && (
        <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
          {buttons.includes('BOARDED') && <BigAction style={{ flex: 1 }} title={t('Boarded')} icon={UserCheckIcon} tone="success" onPress={() => void queue({ tripId, type: 'BOARDED', passengerTripId: p.passengerTripId })} />}
          {buttons.includes('NO_SHOW') && (
            <BigAction
              style={{ flex: 1 }}
              title={wait ? t('No-show in {{time}}', { time: wait }) : t('No-show')}
              icon={UserXIcon}
              tone="destructive"
              onPress={noShow}
              disabled={!!wait}
              hint={wait ? t('No-show can be recorded 5 minutes after arriving') : undefined}
            />
          )}
          {buttons.includes('DROPPED') && <BigAction style={{ flex: 1 }} title={t('Dropped')} icon={CheckIcon} onPress={() => void queue({ tripId, type: 'DROPPED', passengerTripId: p.passengerTripId, stopSeq: stop.seq })} />}
        </View>
      )}
    </View>
  );
}

function StopCard({ stop, trip, current, moving, queue, tz, now }: { stop: DriverStopDto; trip: DriverTripDetailDto; current: boolean; moving: boolean; queue: QueueFn; tz: string; now: number }) {
  const { t } = useTranslation();
  const c = useColors();
  const navOn = useNavHandoff();
  const q = useDriverQueue();
  const local = q.events.filter((e) => e.tripId === trip.id);
  const arrived = stopActionState(stop, 'ARRIVED', local);
  const departed = stopActionState(stop, 'DEPARTED', local);
  const running = trip.plannedTripStatus === 'STARTED' || trip.plannedTripStatus === 'IN_PROGRESS';
  const passengers = trip.passengers.filter((p) => p.pickupSeq === stop.seq || p.dropSeq === stop.seq);
  const uri = stop.lat !== null && stop.lng !== null ? geoUri(stop.lat, stop.lng, stop.seq) : null;
  const navigate = () => {
    if (!uri) return;
    // Coordinates and "Stop <n>" only (no names). iOS has no geo: chooser: Apple Maps by coordinates.
    const target = Platform.OS === 'ios' && stop.lat !== null && stop.lng !== null ? `maps://?daddr=${stop.lat},${stop.lng}` : uri;
    Linking.openURL(target).catch(() => Alert.alert(t('No navigation app found')));
  };
  const label = stop.label ?? t('Stop {{n}}', { n: stop.seq });
  const counts = t('{{p}} pickups · {{d}} drops · {{w}} waiting', { p: stop.pickups, d: stop.drops, w: stop.pending });
  return (
    <Card style={{ gap: SPACE.sm, borderWidth: current ? 2 : 1, borderColor: current ? c.primary : c.border }}>
      <View accessible accessibilityRole="header" accessibilityLabel={`${t('Stop {{n}}', { n: stop.seq })}, ${label}, ${clockIn(stop.plannedArrival, tz, currentLocale())}, ${counts}`}>
        <Text weight="700">
          {stop.seq}. {label}
        </Text>
        <Text size="sm" tone="muted">
          {clockIn(stop.plannedArrival, tz, currentLocale())} · {counts}
        </Text>
        {stop.pointHidden === 'CONSENT_REQUIRED' && (
          <Text size="sm" tone="muted">
            {t('The location of this stop is not shared. Call your dispatcher for directions.')}
          </Text>
        )}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs }}>
        {arrived.display !== 'NONE' && (
          <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
            <Text size="xs" tone="muted">
              {t('Arrived')}:
            </Text>
            <SyncBadge state={arrived.display} code={arrived.code} />
          </View>
        )}
        {departed.display !== 'NONE' && (
          <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
            <Text size="xs" tone="muted">
              {t('Left')}:
            </Text>
            <SyncBadge state={departed.display} code={departed.code} />
          </View>
        )}
      </View>
      {arrived.display === 'REJECTED' && arrived.code ? <ErrorBanner message={driverCodeText(arrived.code)} /> : null}
      {departed.display === 'REJECTED' && departed.code ? <ErrorBanner message={driverCodeText(departed.code)} /> : null}

      {current && navOn && uri && <BigAction title={t('Navigate')} icon={NavigationIcon} tone="info" onPress={navigate} hint={t('Opens a navigation app with the stop coordinates only')} />}
      {current && running && arrived.display === 'NONE' && (
        <BigAction
          title={t('Arrived at stop')}
          icon={MapPinIcon}
          onPress={() => void queue({ tripId: trip.id, type: 'ARRIVED', stopSeq: stop.seq })}
          disabled={!actionAllowed('ARRIVED', { moving })}
          hint={moving ? t('Available once the vehicle has stopped') : undefined}
        />
      )}
      {current && !moving && passengers.length > 0 && (
        <View>
          {passengers.map((p) => (
            <PassengerRow key={p.passengerTripId} p={p} stop={stop} tripId={trip.id} moving={moving} queue={queue} now={now} />
          ))}
        </View>
      )}
      {current && running && !moving && (arrived.display === 'CONFIRMED' || arrived.display === 'PENDING') && departed.display === 'NONE' && (
        <BigAction title={t('Leave the stop')} icon={LogOutIcon} tone="neutral" onPress={() => void queue({ tripId: trip.id, type: 'DEPARTED', stopSeq: stop.seq })} />
      )}
    </Card>
  );
}

/**
 * Driver trip: ordered stops, the minimal manifest, and the actions. Start is ONLINE ONLY (confirmed by the server
 * before the screen moves on). Arrived / boarded / no-show / dropped / left / complete / acknowledge are queued
 * offline with idempotency keys and shown as "Pending sync" until the server answers; a rejected one shows its reason.
 * While the vehicle moves only Navigate and the next-stop card stay (doc 09 §5.1).
 */
export function DriverTripScreen({ id }: { id: string }) {
  useManifestScreenGuard();
  const { t } = useTranslation();
  const c = useColors();
  const query = useDriverTrip(id);
  const me = useDriverMe();
  const start = useStartTrip(id);
  const q = useDriverQueue();
  const trip = query.data;
  const active = useAppActive();
  const running = trip?.plannedTripStatus === 'STARTED' || trip?.plannedTripStatus === 'IN_PROGRESS';
  // Poll the vehicle's live speed every 10 s while this screen is open, the app is in front and the trip is open.
  const motionQuery = useTripMotion(id, !!trip && active && (running || trip.plannedTripStatus === 'SCHEDULED'));
  const sample = motionSample(motionQuery.data ?? trip?.vehicleMotion);
  const motion = useVehicleMotion(sample);
  const now = useNow(1_000);
  const [saveError, setSaveError] = useState<string | null>(null);
  const local = q.events.filter((e) => e.tripId === id);

  // Keep the local seq above what the server has stored for this trip (reinstall / second phone).
  useEffect(() => {
    if (trip?.lastSeq) void driverQueue.ensureSeqAtLeast(id, trip.lastSeq).catch(() => undefined);
  }, [id, trip?.lastSeq]);

  // SOS (doc 09 §7.3, r114): this trip is what the driver SOS attaches while it is current; the dispatcher phone is kept
  // for the SOS call buttons. Both survive an offline restart (sos-context.ts).
  const sosUntil = trip ? (driverCurrentTrip([trip], now)?.until ?? null) : null;
  useEffect(() => {
    if (sosUntil !== null) driverSos.setContext({ tripId: id, until: sosUntil });
  }, [id, sosUntil]);
  const sosPhone = trip?.dispatcherPhone ?? me.data?.dispatcherPhone ?? null;
  useEffect(() => {
    if (sosPhone) driverSos.setContext({ deskPhone: sosPhone });
  }, [sosPhone]);

  const lastMoving = useRef(motion.moving);
  useEffect(() => {
    if (lastMoving.current !== motion.moving) AccessibilityInfo.announceForAccessibility(motion.moving ? t('Vehicle moving: only navigation is available') : t('Vehicle stopped'));
    lastMoving.current = motion.moving;
  }, [motion.moving, t]);

  const queue: QueueFn = async (input) => {
    setSaveError(null);
    try {
      await queueDriverEvent(input);
    } catch {
      setSaveError(t('Could not save the action on this phone. Try again.'));
    }
  };

  if (query.isPending) return <ActivityIndicator style={{ margin: SPACE.xl }} accessibilityLabel={t('Loading')} />;
  if (query.isError || !trip) {
    return (
      <View style={{ padding: SPACE.lg, gap: SPACE.md }}>
        <Stack.Screen options={{ title: t('Trip') }} />
        {isNotDriver(query.error) ? <TransportEmpty title={t('No driver profile')} description={driverErrorText(query.error)} /> : <ErrorBanner message={driverErrorText(query.error)} onRetry={() => void query.refetch()} />}
        <SosEntryButton audience="driver" />
        <SyncBanner />
      </View>
    );
  }

  // Trip times in the company's zone (from /driver/v1/me), else the phone's.
  const tz = me.data?.company.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const state = TRIP_STATE_META[trip.derivedState];
  const ack = tripActionState(trip, 'ACKNOWLEDGE', local);
  const complete = tripActionState(trip, 'COMPLETE_TRIP', local);
  const cur = currentStop(trip.stops, local);
  const stops = [...trip.stops].sort((a, b) => a.seq - b.seq);
  const moving = motion.moving;
  const confirmStart = () =>
    Alert.alert(t('Start trip?'), t('Starting needs a connection. The server checks the trip before it starts.'), [
      { text: t('Cancel'), style: 'cancel' },
      {
        text: t('Start trip'),
        onPress: () =>
          start.mutate(undefined, {
            onSuccess: (res) => {
              if (res.warnings.includes('TELEMETRY_STALE')) Alert.alert(t('Trip started'), t('The vehicle has not reported its position recently. The trip is tracked once it does.'));
            },
          }),
      },
    ]);
  const confirmComplete = () =>
    Alert.alert(t('Complete trip?'), t('The trip shows "waiting to sync" until the server confirms it.'), [
      { text: t('Cancel'), style: 'cancel' },
      { text: t('Complete trip'), onPress: () => void queue({ tripId: trip.id, type: 'COMPLETE_TRIP' }) },
    ]);

  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }}>
      <Stack.Screen options={{ title: trip.name }} />
      <SyncBanner />
      {saveError && <ErrorBanner message={saveError} />}

      <Card style={{ gap: SPACE.xs }}>
        <Text size="lg" weight="700" accessibilityRole="header">
          {trip.name}
        </Text>
        <Text size="sm" tone="muted">
          {trip.serviceDate} · {t(tripKindLabel(trip))} · {clockIn(trip.plannedStart, tz, currentLocale())}–{clockIn(trip.plannedEnd, tz, currentLocale())}
        </Text>
        {trip.vehicle && (
          <Text size="sm" tone="muted">
            {trip.vehicle.name}
            {trip.vehicle.plateNumber ? ` · ${trip.vehicle.plateNumber}` : ''}
          </Text>
        )}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs }}>
          <StatusChip label={t(state.label)} tone={state.tone} />
          {ack.display === 'CONFIRMED' ? <StatusChip label={t('Acknowledged')} tone="success" icon={CheckIcon} /> : <SyncBadge state={ack.display} code={ack.code} />}
          {complete.display !== 'NONE' && complete.display !== 'CONFIRMED' && (
            <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
              <Text size="xs" tone="muted">
                {t('Completed')}:
              </Text>
              <SyncBadge state={complete.display} code={complete.code} />
            </View>
          )}
        </View>
        <Text size="sm">
          {t('{{b}} boarded · {{n}} no-show · {{w}} waiting', { b: trip.counts.boarded, n: trip.counts.noShow, w: trip.counts.pending })}
        </Text>
        {trip.overlays.map((o) => (
          <StatusChip key={`${o.kind}-${o.reportedAt}`} label={`${o.kind === 'DELAY' ? t('Delay reported') : t('Breakdown reported')}${o.reasonCode ? `: ${t(REASON_LABEL[o.reasonCode] ?? o.reasonCode)}` : ''}${o.etaMin ? ` (+${o.etaMin} min)` : ''}`} tone="warning" icon={AlertTriangleIcon} />
        ))}
      </Card>

      {moving ? (
        <Card style={{ borderColor: c.warning }}>
          <Text weight="700">{t('Vehicle moving: only navigation is available')}</Text>
        </Card>
      ) : !sample && running ? (
        <Text size="xs" tone="muted">
          {t('The vehicle has no fresh GPS position, so actions are not locked. Do not use the phone while driving.')}
        </Text>
      ) : null}
      {/* SOS stays available while moving (doc 09 §5.1 / §7.3): one tap to the full-screen hold-to-send SOS. */}
      <SosEntryButton audience="driver" />
      <CallButton phone={trip.dispatcherPhone ?? me.data?.dispatcherPhone} title={t('Call dispatcher')} />

      {start.isError && <ErrorBanner message={driverErrorText(start.error)} />}
      {!moving && trip.allowedActions.includes('start') && (
        <BigAction title={start.isPending ? t('Starting…') : t('Start trip')} icon={PlayIcon} onPress={confirmStart} disabled={start.isPending} hint={t('Needs a connection')} />
      )}
      {!moving && offerTripAction(trip.allowedActions.includes('acknowledge'), ack) && <BigAction title={t('Acknowledge trip')} icon={CheckIcon} tone="neutral" onPress={() => void queue({ tripId: trip.id, type: 'ACKNOWLEDGE' })} />}

      <SectionTitle>{t('Stops')}</SectionTitle>
      {trip.manifestHidden === 'TRIP_CLOSED' && (
        <Text size="sm" tone="muted">
          {t('The trip is closed: passenger names and stop points are no longer shown.')}
        </Text>
      )}
      {(moving && cur ? [cur] : stops).map((s) => (
        <StopCard key={s.seq} stop={s} trip={trip} current={cur?.seq === s.seq} moving={moving} queue={queue} tz={tz} now={now} />
      ))}

      {!moving && (
        <View style={{ gap: SPACE.sm }}>
          {offerTripAction(trip.allowedActions.includes('complete'), complete) && <BigAction title={t('Complete trip')} icon={FlagIcon} tone="success" onPress={confirmComplete} />}
          {trip.allowedActions.includes('report') && <BigAction title={t('Report delay or breakdown')} icon={AlertTriangleIcon} tone="warning" onPress={() => router.push(`/duty/report/${trip.id}`)} />}
        </View>
      )}
    </ScrollView>
  );
}
