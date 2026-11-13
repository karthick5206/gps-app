import type { MePlaceDto } from '@veetracer/shared';
import { router } from 'expo-router';
import { MapPinIcon, PencilIcon, Trash2Icon } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, ScrollView, View } from 'react-native';
import { Button, Card, ErrorBanner, Field, SectionTitle, Text } from '@/components/ui';
import { api } from '@/lib/api';
import { SPACE, useColors } from '@/lib/theme';
import { isNotPassenger, transportErrorText } from '../passenger-api';
import { SELF_LIMITS } from '../self-service';
import { selfServiceErrorText, useDeletePlace, useMyPlaces, useMyPolicy, useSavePlace } from '../self-service-api';
import { TOUCH, TransportEmpty } from '../ui';
import { AddressAutocomplete } from './AddressAutocomplete';

interface Found {
  label: string;
  lat: number;
  lng: number;
}

const searchPlaces = (q: string, signal: AbortSignal) => api.get<Found[]>('/geocode/search', { q }, signal);

/** Address search through the VeeTrax server (`/geocode/search`, self-hosted geocoder), suggestions as you type: the phone's location is never read. */
function AddPlace({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const save = useSavePlace();
  const [picked, setPicked] = useState<Found | null>(null);
  const [label, setLabel] = useState('');
  const choose = (f: Found) => {
    setPicked(f);
    if (!label) setLabel(f.label.split(',')[0]?.slice(0, SELF_LIMITS.placeLabelMax) ?? '');
  };
  return (
    <Card style={{ gap: SPACE.sm }}>
      <AddressAutocomplete<Found> search={searchPlaces} onPick={choose} onTextChange={() => setPicked(null)} />
      {picked && (
        <>
          <Field label={t('Name of the place')} value={label} onChangeText={setLabel} maxLength={SELF_LIMITS.placeLabelMax} />
          {save.isError && <ErrorBanner message={selfServiceErrorText(save.error, 'place')} />}
          <Button
            title={t('Save place')}
            loading={save.isPending}
            disabled={!label.trim()}
            onPress={() => save.mutate({ body: { label: label.trim(), lat: picked.lat, lng: picked.lng } }, { onSuccess: onDone })}
            style={{ minHeight: TOUCH }}
          />
        </>
      )}
    </Card>
  );
}

function PlaceRow({ place }: { place: MePlaceDto }) {
  const { t } = useTranslation();
  const c = useColors();
  const del = useDeletePlace();
  const save = useSavePlace();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(place.label);
  const confirmDelete = () =>
    Alert.alert(t('Delete this place?'), place.label, [
      { text: t('Cancel'), style: 'cancel' },
      { text: t('Delete'), style: 'destructive', onPress: () => del.mutate(place.id) },
    ]);
  return (
    <Card style={{ gap: SPACE.sm }}>
      {editing ? (
        <>
          <Field label={t('Name of the place')} value={label} onChangeText={setLabel} maxLength={SELF_LIMITS.placeLabelMax} />
          <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
            <Button title={t('Cancel')} variant="outline" onPress={() => setEditing(false)} style={{ flex: 1, minHeight: TOUCH }} />
            <Button title={t('Save')} loading={save.isPending} disabled={!label.trim()} onPress={() => save.mutate({ id: place.id, body: { label: label.trim() } }, { onSuccess: () => setEditing(false) })} style={{ flex: 1, minHeight: TOUCH }} />
          </View>
        </>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
          <MapPinIcon size={18} color={c.foreground} />
          <View style={{ flex: 1 }}>
            <Text weight="600">{place.label}</Text>
            {place.lat === null && (
              <Text size="xs" tone="muted">
                {t('Hidden and not usable until you allow the use of your location for transport.')}
              </Text>
            )}
          </View>
          {place.lat !== null && <Button title={t('Rename')} icon={PencilIcon} variant="ghost" onPress={() => setEditing(true)} style={{ minHeight: TOUCH }} />}
          <Button title={t('Delete')} icon={Trash2Icon} variant="ghost" loading={del.isPending} onPress={confirmDelete} style={{ minHeight: TOUCH }} />
        </View>
      )}
      {(del.isError || save.isError) && <ErrorBanner message={selfServiceErrorText(del.error ?? save.error, 'place')} />}
    </Card>
  );
}

/**
 * Saved places (E5 WP 5.3; doc 08 "Saved places"): personal pickup / drop points kept on the passenger's own profile.
 * Adding or using one needs the transport consent (TRANSPORT_PROFILE); without it the coordinates are not shown and the
 * place cannot be booked. Deleting is always possible.
 */
export function PlacesScreen() {
  const { t } = useTranslation();
  const policy = useMyPolicy();
  const on = !!policy.data?.selfBooking;
  const places = useMyPlaces(on);
  const [adding, setAdding] = useState(false);
  if (policy.isPending || (on && places.isPending)) return <ActivityIndicator style={{ margin: SPACE.xl }} accessibilityLabel={t('Loading')} />;
  if (isNotPassenger(policy.error) || isNotPassenger(places.error)) {
    return (
      <View style={{ padding: SPACE.lg }}>
        <TransportEmpty title={t('No passenger profile')} description={t('Your account is not linked to an active passenger profile. Ask your transport desk.')} />
      </View>
    );
  }
  if (!on) {
    return (
      <View style={{ padding: SPACE.lg }}>
        <TransportEmpty title={t('Booking in the app is off')} description={t('Your company has not switched on booking in the app. Contact your transport desk.')} />
      </View>
    );
  }
  const list = places.data ?? [];
  const consent = !!policy.data?.routingConsent;
  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }} keyboardShouldPersistTaps="handled">
      {places.isError && <ErrorBanner message={transportErrorText(places.error)} onRetry={() => void places.refetch()} />}
      {!consent && (
        <Card style={{ gap: SPACE.sm }}>
          <Text size="sm" tone="muted">
            {t('Saved places are personal locations. Allow the use of your location for transport to add or use them.')}
          </Text>
          <Button title={t('Privacy & consent')} variant="outline" onPress={() => router.push('/commute/consent')} style={{ minHeight: TOUCH }} />
        </Card>
      )}
      <SectionTitle>{t('Saved places')}</SectionTitle>
      {list.length === 0 && <TransportEmpty icon={MapPinIcon} title={t('No saved places')} description={t('Add a place you are often picked up from or dropped at.')} />}
      {list.map((p) => (
        <PlaceRow key={p.id} place={p} />
      ))}
      {consent && list.length < SELF_LIMITS.maxPlaces && (adding ? <AddPlace onDone={() => setAdding(false)} /> : <Button title={t('Add a place')} icon={MapPinIcon} onPress={() => setAdding(true)} style={{ minHeight: TOUCH }} />)}
      <Text size="xs" tone="muted" style={{ textAlign: 'center' }}>
        {t('VeeTrax does not track your phone. Places are found by address search only.')}
      </Text>
    </ScrollView>
  );
}
