import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { Text } from '@/components/ui';
import { SPACE } from '@/lib/theme';
import { profileErrorMessage } from '../self-service-api';
import { TransportPickMap, useTransportMapStyle } from '../ui';
import { AddressAutocomplete } from './AddressAutocomplete';

export interface PickedPoint {
  lat: number;
  lng: number;
  /** The search hit's label (SEARCH) or the label kept from before (PIN). */
  label: string;
  source: 'SEARCH' | 'PIN';
}

/**
 * Choose a one-time point (WP 3.9 wave 2: ride request map point, D-A9 home pin): self-hosted address search through
 * the VeeTrax server (suggestions as you type: AddressAutocomplete), then a tap on the self-hosted map moves the
 * point. Without a self-hosted map style in the build only the search is offered. The phone's location is never read.
 * Coordinates are never shown as text.
 */
export function PointPicker({ value, onChange, center }: { value: PickedPoint | null; onChange: (p: PickedPoint) => void; center?: { lat: number; lng: number } | null }) {
  const { t } = useTranslation();
  const hasMap = !!useTransportMapStyle();
  return (
    <View style={{ gap: SPACE.sm }}>
      <AddressAutocomplete errorText={profileErrorMessage} onPick={(f) => onChange({ lat: f.lat, lng: f.lng, label: f.label, source: 'SEARCH' })} />
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
