import { PASSENGER_NOTIFICATION_KINDS, TRANSPORT_NOTIFICATION_KINDS, type TransportNotificationKind, type TransportNotificationPreferences } from '@veetracer/shared';
import { useTranslation } from 'react-i18next';
import { Switch, View } from 'react-native';
import { Card, ErrorBanner, Text } from '@/components/ui';
import { SPACE } from '@/lib/theme';
import { useNotificationPreferences, useSaveNotificationPreferences } from '../passenger-api';

const KIND_LABEL: Partial<Record<TransportNotificationKind, string>> & Record<string, string | undefined> = {
  TRIP_STARTING_SOON: 'Your trip starts soon',
  VEHICLE_APPROACHING: 'Your cab is arriving',
  TRIP_DELAYED: 'Trip delayed',
  TRIP_CANCELLED: 'Trip cancelled',
  BOOKING_CREATED: 'Ride booked for you',
  BOOKING_APPROVED: 'Ride request approved',
  BOOKING_REJECTED: 'Ride request rejected',
};

/**
 * WP 3.9 wave 2: BOOKING_APPROVED / BOOKING_REJECTED get a switch as soon as the shared kind list (and so the server)
 * knows them; until then a switch would only send a key the server does not accept.
 */
export function passengerPushKinds(known: readonly string[] = TRANSPORT_NOTIFICATION_KINDS): string[] {
  const extra = ['BOOKING_APPROVED', 'BOOKING_REJECTED'].filter((k) => known.includes(k) && !(PASSENGER_NOTIFICATION_KINDS as readonly string[]).includes(k));
  return [...PASSENGER_NOTIFICATION_KINDS, ...extra];
}

function Row({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md, minHeight: 48 }}>
      <Text style={{ flex: 1 }} weight="500">
        {label}
      </Text>
      <Switch value={value} onValueChange={onChange} disabled={disabled} accessibilityLabel={label} />
    </View>
  );
}

/**
 * Passenger push preferences (GET / PUT /me/transport/notifications/preferences). They switch only the PUSH off: the
 * in-app notices are always written and stay the authoritative history.
 */
export function PushPreferences() {
  const { t } = useTranslation();
  const q = useNotificationPreferences();
  const save = useSaveNotificationPreferences();
  if (!q.data) return null; // not loaded / server without the route: nothing to switch
  const prefs = save.isPending && save.variables ? save.variables : q.data;
  const set = (next: TransportNotificationPreferences) => save.mutate(next);
  return (
    <Card style={{ gap: SPACE.xs }}>
      <Row label={t('Trip notifications on this phone')} value={prefs.push} onChange={(push) => set({ ...prefs, push })} />
      {passengerPushKinds().map((k) => (
        <Row key={k} label={t(KIND_LABEL[k] ?? k)} value={prefs.push && (prefs.kinds as Record<string, boolean | undefined>)[k] !== false} disabled={!prefs.push} onChange={(v) => set({ ...prefs, kinds: { ...prefs.kinds, [k]: v } })} />
      ))}
      {save.isError && <ErrorBanner message={t('Could not save. Try again.')} />}
      <Text size="xs" tone="muted">
        {t('This only turns the push messages off. Every update is still listed under Notices in the app.')}
      </Text>
    </Card>
  );
}
