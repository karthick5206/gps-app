import type { MeTripDto } from '@veetracer/shared';
import { router } from 'expo-router';
import { ChevronRightIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui';
import { currentLocale } from '@/lib/i18n';
import { RADIUS, SPACE, useColors } from '@/lib/theme';
import { PASSENGER_STATUS_META, TRIP_STATE_META, tripKindLabel } from '../labels';
import { clockIn } from '../trip-window';
import { StatusChip, TOUCH } from '../ui';

/** One of my trips in a list: date, direction, my pickup time / label, vehicle; opens the trip screen. */
export function TripCard({ trip, highlight }: { trip: MeTripDto; highlight?: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const locale = currentLocale();
  const pickup = trip.myStop ? `${clockIn(trip.myStop.plannedAt, trip.timeZone, locale)} · ${trip.myStop.label}` : t('Pickup to be confirmed');
  const vehicle = trip.vehicle ? `${trip.vehicle.name}${trip.vehicle.plate ? ` · ${trip.vehicle.plate}` : ''}` : t('Vehicle to be confirmed');
  const state = TRIP_STATE_META[trip.derivedState];
  const mine = PASSENGER_STATUS_META[trip.myStatus];
  const a11y = [trip.serviceDate, t(tripKindLabel(trip)), t('My pickup'), pickup, vehicle, t(state.label), t(mine.label)].join(', ');
  return (
    <Pressable
      onPress={() => router.push(`/commute/trip/${trip.id}`)}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityHint={t('Opens the trip')}
      style={({ pressed }) => [
        { minHeight: TOUCH, borderWidth: highlight ? 2 : 1, borderColor: highlight ? c.primary : c.border, backgroundColor: c.card, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs },
        pressed && { opacity: 0.85 },
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
        <Text weight="700" style={{ flex: 1 }}>
          {trip.serviceDate} · {t(tripKindLabel(trip))}
        </Text>
        <ChevronRightIcon size={18} color={c.mutedForeground} />
      </View>
      <Text size="sm">
        {t('My pickup')}: {pickup}
      </Text>
      <Text size="sm" tone="muted">
        {vehicle}
        {trip.driverFirstName ? ` · ${t('Driver {{name}}', { name: trip.driverFirstName })}` : ''}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs, marginTop: 2 }}>
        <StatusChip label={t(state.label)} tone={state.tone} />
        <StatusChip label={t(mine.label)} tone={mine.tone} />
      </View>
    </Pressable>
  );
}
