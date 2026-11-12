import type { MePlaceRef, TransportDirection } from '@veetracer/shared';
import { router } from 'expo-router';
import { CalendarPlusIcon } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { Button, Card, Chips, ErrorBanner, Field, SectionTitle, Text } from '@/components/ui';
import { SPACE, useColors } from '@/lib/theme';
import { DIRECTION_LABEL } from '../labels';
import { isNotPassenger, transportErrorText } from '../passenger-api';
import { bookableDays, bookingRequest, SELF_LIMITS, shiftTimeFor, todayKeyIn } from '../self-service';
import { selfServiceErrorText, useAttemptKey, useBookTrip, useMyPlaces, useMyPolicy } from '../self-service-api';
import { TOUCH, TransportEmpty } from '../ui';

function Choice({ label, hint, selected, onPress }: { label: string; hint?: string; selected: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={hint ? `${label}, ${hint}` : label}
      style={({ pressed }) => [{ minHeight: TOUCH, borderWidth: selected ? 2 : 1, borderColor: selected ? c.primary : c.border, backgroundColor: c.card, borderRadius: 12, padding: SPACE.md, gap: 2 }, pressed && { opacity: 0.8 }]}
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

const placeKey = (p: MePlaceRef | null) => (!p ? '' : p.kind === 'HOME' ? 'HOME' : p.kind === 'SAVED' ? `SAVED:${p.placeId}` : `STOP:${p.poiId}`);

/**
 * Book a trip (E5 WP 5.3; doc 08 "Book (ad-hoc)"): one of the company's shifts, a day within the company's horizon,
 * the direction and where the passenger is picked up (login) or dropped (logout): home, a saved place or a company
 * stop. Online only (doc 08 §6.1); the server enforces the cut-off, consent and duplicates and says why it refuses.
 */
export function BookScreen() {
  const { t } = useTranslation();
  const policy = useMyPolicy();
  const p = policy.data;
  const places = useMyPlaces(!!p?.selfBooking);
  const book = useBookTrip();
  const [key, renewKey] = useAttemptKey();
  const [shiftId, setShiftId] = useState<string | null>(null);
  const [direction, setDirection] = useState<TransportDirection>('IN');
  const [serviceDate, setServiceDate] = useState<string | null>(null);
  const [place, setPlace] = useState<MePlaceRef | null>({ kind: 'HOME' });
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const shift = p?.shifts.find((s) => s.id === shiftId) ?? null;
  const days = useMemo(() => (shift ? bookableDays(todayKeyIn(shift.timeZone), shift.days, p?.maxDaysAhead ?? SELF_LIMITS.maxDaysAhead) : []), [shift, p?.maxDaysAhead]);

  if (policy.isPending) return <ActivityIndicator style={{ margin: SPACE.xl }} accessibilityLabel={t('Loading')} />;
  if (isNotPassenger(policy.error)) {
    return (
      <View style={{ padding: SPACE.lg }}>
        <TransportEmpty title={t('No passenger profile')} description={t('Your account is not linked to an active passenger profile. Ask your transport desk.')} />
      </View>
    );
  }
  if (policy.isError) return <ErrorBanner message={transportErrorText(policy.error)} onRetry={() => void policy.refetch()} />;
  if (!p?.selfBooking) {
    return (
      <View style={{ padding: SPACE.lg }}>
        <TransportEmpty title={t('Booking in the app is off')} description={t('Your company has not switched on booking in the app. Contact your transport desk.')} />
      </View>
    );
  }

  const submit = () => {
    setFormError(null);
    const req = bookingRequest({ shiftId, serviceDate, direction, place, note });
    if (!req.ok) {
      setFormError(t(req.error));
      return;
    }
    book.mutate(
      { body: req.body, key },
      {
        onSuccess: () => {
          renewKey();
          router.replace('/commute/bookings');
        },
      },
    );
  };

  const homeHint = p.routingConsent ? t('Your home pickup point on file') : t('Without your transport consent no home point is used: the desk will ask where to pick you up.');
  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }} keyboardShouldPersistTaps="handled">
      <Card>
        <Text size="sm" tone="muted">
          {t('Book up to {{days}} days ahead. Bookings close {{minutes}} minutes before the pickup window starts.', { days: p.maxDaysAhead, minutes: p.cutoffMin })}
        </Text>
      </Card>

      <SectionTitle>{t('Shift')}</SectionTitle>
      {p.shifts.length === 0 ? (
        <TransportEmpty icon={CalendarPlusIcon} title={t('No shifts to book')} description={t('Your company has no active shifts yet. Contact your transport desk.')} />
      ) : (
        <View style={{ gap: SPACE.sm }} accessibilityRole="radiogroup">
          {p.shifts.map((s) => (
            <Choice
              key={s.id}
              label={s.name}
              hint={[`${shiftTimeFor(s, 'IN')}–${shiftTimeFor(s, 'OUT')}`, s.siteName].filter(Boolean).join(' · ')}
              selected={s.id === shiftId}
              onPress={() => {
                setShiftId(s.id);
                setServiceDate(null);
              }}
            />
          ))}
        </View>
      )}

      <SectionTitle>{t('Direction')}</SectionTitle>
      <Chips<TransportDirection>
        options={[
          { value: 'IN', label: t(DIRECTION_LABEL.IN) },
          { value: 'OUT', label: t(DIRECTION_LABEL.OUT) },
        ]}
        value={direction}
        onChange={setDirection}
      />

      {shift && (
        <>
          <SectionTitle>{t('Day')}</SectionTitle>
          {days.length === 0 ? (
            <Text size="sm" tone="muted">
              {t('This shift does not run in the next days.')}
            </Text>
          ) : (
            <Chips<string> options={days.map((d) => ({ value: d, label: d }))} value={serviceDate ?? ''} onChange={setServiceDate} />
          )}
        </>
      )}

      <SectionTitle>{direction === 'IN' ? t('Pick me up at') : t('Drop me at')}</SectionTitle>
      <View style={{ gap: SPACE.sm }} accessibilityRole="radiogroup">
        <Choice label={t('Home')} hint={homeHint} selected={placeKey(place) === 'HOME'} onPress={() => setPlace({ kind: 'HOME' })} />
        {(places.data ?? []).map((pl) => (
          <Choice
            key={pl.id}
            label={pl.label}
            hint={pl.lat === null ? t('Needs your transport consent') : t('Saved place')}
            selected={placeKey(place) === `SAVED:${pl.id}`}
            onPress={() => setPlace({ kind: 'SAVED', placeId: pl.id })}
          />
        ))}
        {p.stops.map((s) => (
          <Choice key={s.id} label={s.name} hint={t('Company stop')} selected={placeKey(place) === `STOP:${s.id}`} onPress={() => setPlace({ kind: 'STOP', poiId: s.id })} />
        ))}
        <Button title={t('Manage saved places')} variant="ghost" onPress={() => router.push('/commute/places')} style={{ minHeight: TOUCH }} />
      </View>

      <Field label={t('Note for the desk (optional)')} value={note} onChangeText={setNote} maxLength={SELF_LIMITS.bookingNoteMax} multiline />

      {formError && <ErrorBanner message={formError} />}
      {book.isError && <ErrorBanner message={selfServiceErrorText(book.error, 'book')} />}
      <Button title={t('Book trip')} onPress={submit} loading={book.isPending} style={{ minHeight: TOUCH }} />
      <Text size="xs" tone="muted" style={{ textAlign: 'center' }}>
        {t('Booking needs a connection. Without one, call your transport desk.')}
      </Text>
    </ScrollView>
  );
}
