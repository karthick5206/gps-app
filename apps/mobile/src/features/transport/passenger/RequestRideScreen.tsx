import type { MeAdhocEndRef, MeBookableShiftDto, MeTransportPolicyDto, TransportBookingJourney, TransportDirection } from '@veetracer/shared';
import { router, type Href } from 'expo-router';
import { CheckCircle2Icon, ClockIcon } from 'lucide-react-native';
import { useDeferredValue, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { Button, Card, Chips, ErrorBanner, Field, SearchInput, SectionTitle, Text } from '@/components/ui';
import { SPACE, useColors } from '@/lib/theme';
import { adhocRequest, CONSENT_EXPLANATION, defaultCommuteEnds, endKindAvailability, endKindsFor, REQUEST_LIMITS, requestDays, requestResultText, requestTimeZone, WAITING_FOR_APPROVAL, type EndKind } from '../adhoc-request';
import { DIRECTION_LABEL, POINT_TO_POINT_LABEL } from '../labels';
import { isNotPassenger, transportErrorText } from '../passenger-api';
import { bookingsRoute } from '../push-target';
import { shiftTimeFor, todayKeyIn } from '../self-service';
import { requestErrorMessage, useAttemptKey, useMyPlaces, useMyPolicy, useRequestPlaces, useRequestRide, type MeRequestResult } from '../self-service-api';
import { StatusChip, TOUCH, TransportEmpty } from '../ui';
import { PointPicker, type PickedPoint } from './PointPicker';

/** Wave-2 policy fields (D-A5) are optional: an older server leaves them out and the screen says requests are off. */
type Policy = MeTransportPolicyDto & { adhocRequests?: boolean; approvalRequired?: boolean };

type Ends = { pickup: MeAdhocEndRef | null; destination: MeAdhocEndRef | null; v: number };

const END_LABEL: Record<EndKind, string> = { HOME: 'Home', SAVED: 'Saved place', PLACE: 'Company place', MAP: 'Map point', SHIFT_SITE: 'Shift site' };

function Choice({ label, hint, selected, disabled, onPress }: { label: string; hint?: string; selected: boolean; disabled?: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: !!disabled }}
      accessibilityLabel={hint ? `${label}, ${hint}` : label}
      style={({ pressed }) => [
        { minHeight: TOUCH, borderWidth: selected ? 2 : 1, borderColor: selected ? c.primary : c.border, backgroundColor: c.card, borderRadius: 12, padding: SPACE.md, gap: 2 },
        disabled && { opacity: 0.5 },
        pressed && { opacity: 0.8 },
      ]}
    >
      <Text weight={selected ? '700' : '500'}>{label}</Text>
      {hint ? (
        <Text size="xs" tone="muted">
          {hint}
        </Text>
      ) : null}
    </Pressable>
  );
}

function CompanyPlaces({ value, onChange }: { value: string | null; onChange: (poiId: string) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const search = useDeferredValue(q.trim());
  const places = useRequestPlaces(search);
  return (
    <View style={{ gap: SPACE.sm }}>
      <SearchInput value={q} onChangeText={setQ} placeholder={t('Search company places')} accessibilityLabel={t('Search company places')} />
      {places.isPending && <ActivityIndicator accessibilityLabel={t('Loading')} />}
      {places.isError && <ErrorBanner message={requestErrorMessage(places.error)} onRetry={() => void places.refetch()} />}
      {places.isSuccess && places.data.length === 0 && (
        <Text size="sm" tone="muted">
          {t('No places found')}
        </Text>
      )}
      {(places.data ?? []).slice(0, 12).map((pl) => (
        <Choice key={pl.id} label={pl.name} hint={pl.category ?? undefined} selected={value === pl.id} onPress={() => onChange(pl.id)} />
      ))}
    </View>
  );
}

/** One end of the ride (pickup or destination): the kind first, then the place of that kind. */
function EndPicker({
  title,
  value,
  onChange,
  journey,
  shift,
  policy,
}: {
  title: string;
  value: MeAdhocEndRef | null;
  onChange: (v: MeAdhocEndRef | null) => void;
  journey: TransportBookingJourney;
  shift: MeBookableShiftDto | null;
  policy: Policy;
}) {
  const { t } = useTranslation();
  const places = useMyPlaces(policy.routingConsent);
  const [kind, setKind] = useState<EndKind | null>(value?.kind ?? null);
  const [map, setMap] = useState<PickedPoint | null>(null);
  const [mapLabel, setMapLabel] = useState('');
  const shown = value?.kind ?? kind;
  const saved = places.data ?? [];
  const center = saved.find((s) => s.lat !== null && s.lng !== null);
  const pick = (k: EndKind) => {
    setKind(k);
    if (k === 'HOME' || k === 'SHIFT_SITE') onChange({ kind: k });
    else onChange(null);
  };
  const setMapPoint = (p: PickedPoint, label: string) => onChange({ kind: 'MAP', lat: p.lat, lng: p.lng, label: label.trim() || null });
  return (
    <>
      <SectionTitle>{title}</SectionTitle>
      <View style={{ gap: SPACE.sm }} accessibilityRole="radiogroup">
        {endKindsFor(journey).map((k) => {
          const av = endKindAvailability(k, { routingConsent: policy.routingConsent, journey, shiftId: shift?.id ?? null });
          const hint = !av.ok ? t(av.reason) : k === 'SHIFT_SITE' ? (shift?.siteName ?? undefined) : k === 'HOME' ? t('Your home pickup point on file') : undefined;
          return <Choice key={k} label={t(END_LABEL[k])} hint={hint} selected={shown === k} disabled={!av.ok} onPress={() => pick(k)} />;
        })}
      </View>
      {shown === 'SAVED' && (
        <Card style={{ gap: SPACE.sm }}>
          {saved.length === 0 ? (
            <Text size="sm" tone="muted">
              {t('No saved places')}
            </Text>
          ) : (
            saved.map((pl) => (
              <Choice
                key={pl.id}
                label={pl.label}
                hint={pl.lat === null ? t('Needs your transport consent') : undefined}
                disabled={pl.lat === null}
                selected={value?.kind === 'SAVED' && value.placeId === pl.id}
                onPress={() => onChange({ kind: 'SAVED', placeId: pl.id })}
              />
            ))
          )}
          <Button title={t('Manage saved places')} variant="ghost" onPress={() => router.push('/commute/places')} style={{ minHeight: TOUCH }} />
        </Card>
      )}
      {shown === 'PLACE' && (
        <Card>
          <CompanyPlaces value={value?.kind === 'PLACE' ? value.poiId : null} onChange={(poiId) => onChange({ kind: 'PLACE', poiId })} />
        </Card>
      )}
      {shown === 'MAP' && (
        <Card style={{ gap: SPACE.sm }}>
          <PointPicker
            value={map}
            center={center ? { lat: center.lat!, lng: center.lng! } : null}
            onChange={(p) => {
              setMap(p);
              const label = mapLabel || (p.source === 'SEARCH' ? (p.label.split(',')[0] ?? '').slice(0, REQUEST_LIMITS.mapLabelMax) : '');
              if (label !== mapLabel) setMapLabel(label);
              setMapPoint(p, label);
            }}
          />
          <Field
            label={t('Name of the point (optional)')}
            value={mapLabel}
            maxLength={REQUEST_LIMITS.mapLabelMax}
            onChangeText={(v) => {
              setMapLabel(v);
              if (map) setMapPoint(map, v);
            }}
          />
        </Card>
      )}
    </>
  );
}

/** After a successful request: waiting for approval (REQUESTED) or sent to the desk; opens the booking. */
function Done({ result, onAnother }: { result: MeRequestResult; onAnother: () => void }) {
  const { t } = useTranslation();
  const text = requestResultText(result);
  const waiting = text === WAITING_FOR_APPROVAL;
  return (
    <View style={{ padding: SPACE.lg, gap: SPACE.md }}>
      <Card style={{ gap: SPACE.sm }}>
        <StatusChip label={t('Requested')} tone={waiting ? 'warning' : 'info'} icon={waiting ? ClockIcon : CheckCircle2Icon} />
        <Text weight="700" accessibilityRole="header" accessibilityLiveRegion="polite">
          {t(text)}
        </Text>
        <Text size="sm" tone="muted">
          {waiting ? t('The transport team checks your request. You get a notification when it is approved or rejected.') : t('You get a notification when your cab is assigned.')}
        </Text>
      </Card>
      <Button title={t('Open the booking')} onPress={() => router.replace(bookingsRoute(result.id) as Href)} style={{ minHeight: TOUCH }} />
      <Button title={t('Request another ride')} variant="outline" onPress={onAnother} style={{ minHeight: TOUCH }} />
    </View>
  );
}

/**
 * Request a ride (WP 3.9 wave 2, D-A7): a commute or a point-to-point ride, a day within the company's horizon, an
 * optional shift, pickup and destination each from home / a saved place / a company place / a map point / the shift
 * site (commute), an optional own time window, purpose and note. One seat, own profile, online only. Requests may need
 * approval (D-A5); the server enforces cut-off, horizon, consent, eligibility, duplicates and overlap.
 */
export function RequestRideScreen() {
  const { t } = useTranslation();
  const policy = useMyPolicy();
  const p = policy.data as Policy | undefined;
  const request = useRequestRide();
  const [key, renewKey] = useAttemptKey();
  const [journey, setJourney] = useState<TransportBookingJourney>('COMMUTE');
  const [direction, setDirection] = useState<TransportDirection>('IN');
  const [shiftId, setShiftId] = useState<string | null>(null);
  const [serviceDate, setServiceDate] = useState<string | null>(null);
  // null = untouched: the commute defaults (home → shift site to log in) once the policy says whether consent exists.
  const [touched, setEnds] = useState<Ends | null>(null);
  const ends: Ends = touched ?? { ...defaultCommuteEnds('IN', !!p?.routingConsent), v: 0 };
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  const [purpose, setPurpose] = useState('');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<MeRequestResult | null>(null);
  const shift = p?.shifts.find((s) => s.id === shiftId) ?? null;
  // r115 B8: the company zone (policy.timeZone) first, then the shift zone; the phone zone only for an older server.
  const timeZone = requestTimeZone(p, shiftId, Intl.DateTimeFormat().resolvedOptions().timeZone);
  const days = useMemo(() => requestDays(todayKeyIn(timeZone), p?.maxDaysAhead ?? REQUEST_LIMITS.maxDaysAhead, journey === 'COMMUTE' && shift ? shift.days : null), [timeZone, p?.maxDaysAhead, journey, shift]);

  if (policy.isPending) return <ActivityIndicator style={{ margin: SPACE.xl }} accessibilityLabel={t('Loading')} />;
  if (isNotPassenger(policy.error)) {
    return (
      <View style={{ padding: SPACE.lg }}>
        <TransportEmpty title={t('No passenger profile')} description={t('Your account is not linked to an active passenger profile. Ask your transport desk.')} />
      </View>
    );
  }
  if (policy.isError) return <ErrorBanner message={transportErrorText(policy.error)} onRetry={() => void policy.refetch()} />;
  if (!p?.selfBooking || p.adhocRequests !== true) {
    return (
      <View style={{ padding: SPACE.lg }}>
        <TransportEmpty title={t('Ride requests are off')} description={t('Your company has not switched on ride requests in the app. Contact your transport desk.')} />
      </View>
    );
  }
  if (done) {
    return (
      <Done
        result={done}
        onAnother={() => {
          setDone(null);
          request.reset();
        }}
      />
    );
  }

  const resetEnds = (j: TransportBookingJourney, d: TransportDirection) => {
    const def = j === 'COMMUTE' ? defaultCommuteEnds(d, p.routingConsent) : { pickup: null, destination: null };
    setEnds({ ...def, v: ends.v + 1 });
  };
  const submit = () => {
    setFormError(null);
    const req = adhocRequest({ journey, serviceDate, direction, shiftId, pickup: ends.pickup, destination: ends.destination, windowStart, windowEnd, purpose, note }, { routingConsent: p.routingConsent, timeZone });
    if (!req.ok) {
      setFormError(t(req.error));
      return;
    }
    request.mutate(
      { body: req.body, key },
      {
        onSuccess: (r) => {
          renewKey();
          setDone(r);
        },
      },
    );
  };

  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }} keyboardShouldPersistTaps="handled">
      <Card style={{ gap: SPACE.xs }}>
        <Text size="sm" tone="muted">
          {t('Request up to {{days}} days ahead. Requests close {{minutes}} minutes before the pickup window starts.', { days: p.maxDaysAhead, minutes: p.cutoffMin })}
        </Text>
        {p.approvalRequired !== false && (
          <Text size="sm" tone="muted">
            {t('The transport team approves each request before a cab is assigned.')}
          </Text>
        )}
      </Card>
      {!p.routingConsent && (
        <Card style={{ gap: SPACE.xs }}>
          <Text size="sm" tone="muted">
            {t(CONSENT_EXPLANATION)}
          </Text>
          <Button title={t('Privacy & consent')} variant="ghost" onPress={() => router.push('/commute/consent')} style={{ minHeight: TOUCH }} />
        </Card>
      )}

      <SectionTitle>{t('Journey')}</SectionTitle>
      <Chips<TransportBookingJourney>
        options={[
          { value: 'COMMUTE', label: t('Commute') },
          { value: 'POINT_TO_POINT', label: t(POINT_TO_POINT_LABEL) },
        ]}
        value={journey}
        onChange={(j) => {
          setJourney(j);
          setServiceDate(null);
          resetEnds(j, direction);
        }}
      />

      {journey === 'COMMUTE' && (
        <>
          <SectionTitle>{t('Direction')}</SectionTitle>
          <Chips<TransportDirection>
            options={[
              { value: 'IN', label: t(DIRECTION_LABEL.IN) },
              { value: 'OUT', label: t(DIRECTION_LABEL.OUT) },
            ]}
            value={direction}
            onChange={(d) => {
              setDirection(d);
              resetEnds(journey, d);
            }}
          />
        </>
      )}

      <SectionTitle>{t('Shift (optional)')}</SectionTitle>
      <View style={{ gap: SPACE.sm }} accessibilityRole="radiogroup">
        {p.shifts.map((s) => (
          <Choice
            key={s.id}
            label={s.name}
            hint={[`${shiftTimeFor(s, 'IN')}–${shiftTimeFor(s, 'OUT')}`, s.siteName].filter(Boolean).join(' · ')}
            selected={s.id === shiftId}
            onPress={() => {
              setShiftId(s.id === shiftId ? null : s.id);
              setServiceDate(null);
            }}
          />
        ))}
        {p.shifts.length === 0 && (
          <Text size="sm" tone="muted">
            {t('No shifts to book')}
          </Text>
        )}
      </View>

      <SectionTitle>{t('Day')}</SectionTitle>
      {days.length === 0 ? (
        <Text size="sm" tone="muted">
          {t('This shift does not run in the next days.')}
        </Text>
      ) : (
        <Chips<string> options={days.map((d) => ({ value: d, label: d }))} value={serviceDate ?? ''} onChange={setServiceDate} />
      )}

      <EndPicker key={`pickup-${ends.v}`} title={t('Pickup')} value={ends.pickup} onChange={(v) => setEnds((e) => ({ ...(e ?? ends), pickup: v }))} journey={journey} shift={shift} policy={p} />
      <EndPicker key={`dest-${ends.v}`} title={t('Destination')} value={ends.destination} onChange={(v) => setEnds((e) => ({ ...(e ?? ends), destination: v }))} journey={journey} shift={shift} policy={p} />

      <SectionTitle>{journey === 'POINT_TO_POINT' ? t('Time window') : t('Time window (optional)')}</SectionTitle>
      <Text size="xs" tone="muted">
        {journey === 'POINT_TO_POINT' ? t('When you want to be picked up, for example 09:30 to 10:00.') : t('Leave empty to use the shift times.')}
      </Text>
      <View style={{ flexDirection: 'row', gap: SPACE.md }}>
        <View style={{ flex: 1 }}>
          <Field label={t('From (HH:MM)')} value={windowStart} onChangeText={setWindowStart} placeholder="09:30" keyboardType="numbers-and-punctuation" maxLength={5} />
        </View>
        <View style={{ flex: 1 }}>
          <Field label={t('To (HH:MM)')} value={windowEnd} onChangeText={setWindowEnd} placeholder="10:00" keyboardType="numbers-and-punctuation" maxLength={5} />
        </View>
      </View>

      <Field label={t('Purpose (optional)')} hint={t('For example: client visit. Shown to the transport team.')} value={purpose} onChangeText={setPurpose} maxLength={REQUEST_LIMITS.purposeMax} />
      <Field label={t('Note for the desk (optional)')} value={note} onChangeText={setNote} maxLength={REQUEST_LIMITS.noteMax} multiline />

      {formError && <ErrorBanner message={formError} />}
      {request.isError && <ErrorBanner message={requestErrorMessage(request.error)} />}
      <Button title={t('Send request')} onPress={submit} loading={request.isPending} style={{ minHeight: TOUCH }} />
      <Text size="xs" tone="muted" style={{ textAlign: 'center' }}>
        {t('Booking needs a connection. Without one, call your transport desk.')}
      </Text>
    </ScrollView>
  );
}
