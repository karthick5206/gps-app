import { MapPinIcon } from 'lucide-react-native';
import { useDeferredValue, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Keyboard, Pressable, View } from 'react-native';
import { ErrorBanner, SearchInput, Text } from '@/components/ui';
import { SPACE, useColors } from '@/lib/theme';
import { profileErrorMessage, useAddressSearch } from '../self-service-api';
import { TOUCH, TransportPickMap, useTransportMapStyle } from '../ui';

export interface PickedPoint {
  lat: number;
  lng: number;
  /** The search hit's label (SEARCH) or the label kept from before (PIN). */
  label: string;
  source: 'SEARCH' | 'PIN';
}

/**
 * Choose a one-time point (WP 3.9 wave 2: ride request map point, D-A9 home pin): self-hosted address search through
 * the VeeTrax server, then a tap on the self-hosted map moves the point. Without a self-hosted map style in the build
 * only the search is offered. The phone's location is never read. Coordinates are never shown as text.
 */
export function PointPicker({ value, onChange, center }: { value: PickedPoint | null; onChange: (p: PickedPoint) => void; center?: { lat: number; lng: number } | null }) {
  const { t } = useTranslation();
  const c = useColors();
  const hasMap = !!useTransportMapStyle();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(true);
  const search = useDeferredValue(q.trim());
  const results = useAddressSearch(search, open);
  const ready = open && search.length >= 3;
  return (
    <View style={{ gap: SPACE.sm }}>
      <SearchInput
        value={q}
        onChangeText={(v) => {
          setQ(v);
          setOpen(true);
        }}
        placeholder={t('Search an address or place')}
        accessibilityLabel={t('Search an address or place')}
        returnKeyType="search"
      />
      {ready && results.isFetching && <ActivityIndicator accessibilityLabel={t('Searching…')} />}
      {ready && results.isError && <ErrorBanner message={profileErrorMessage(results.error)} />}
      {ready && results.isSuccess && results.data.length === 0 && (
        <Text size="sm" tone="muted">
          {t('No places found')}
        </Text>
      )}
      {ready &&
        (results.data ?? []).slice(0, 6).map((f) => (
          <Pressable
            key={`${f.lat},${f.lng}`}
            onPress={() => {
              Keyboard.dismiss();
              setOpen(false);
              setQ(f.label);
              onChange({ lat: f.lat, lng: f.lng, label: f.label, source: 'SEARCH' });
            }}
            accessibilityRole="button"
            style={{ minHeight: TOUCH, flexDirection: 'row', gap: SPACE.sm, alignItems: 'center', borderBottomWidth: 1, borderBottomColor: c.border }}
          >
            <MapPinIcon size={16} color={c.mutedForeground} />
            <Text size="sm" style={{ flex: 1 }}>
              {f.label}
            </Text>
          </Pressable>
        ))}
      {hasMap && (value || center) ? (
        <>
          <TransportPickMap point={value} center={center ?? null} label={t('Map: tap to place the point')} onPick={(p) => onChange({ ...p, label: value?.label ?? '', source: 'PIN' })} />
          <Text size="xs" tone="muted">
            {t('Tap the map to move the point.')}
          </Text>
        </>
      ) : null}
      {value && (
        <Text size="sm" weight="500" accessibilityLiveRegion="polite">
          {value.source === 'PIN' ? t('Point placed on the map') : value.label}
        </Text>
      )}
    </View>
  );
}
