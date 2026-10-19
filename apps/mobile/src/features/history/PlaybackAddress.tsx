import { MapPinIcon } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui';
import { useAddress } from '@/features/geocoding/use-address';
import { SPACE, useColors } from '@/lib/theme';

/** While playing, the address follows the vehicle: at most every 3 s, and only after it moved ~200 m. */
const ADDRESS_EVERY_MS = 3000;
const ADDRESS_MOVE_M = 200;

const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const k = Math.PI / 180;
  const x = (b.lng - a.lng) * k * Math.cos(((a.lat + b.lat) / 2) * k);
  const y = (b.lat - a.lat) * k;
  return Math.sqrt(x * x + y * y) * 6_371_000;
};

/** Address and coordinates of the playback point (address trails the vehicle by a few seconds while playing). */
export function PlaybackAddress({ lat, lng, playing }: { lat: number; lng: number; playing: boolean }) {
  const c = useColors();
  const [point, setPoint] = useState({ lat, lng });
  const last = useRef({ lat, lng, at: 0 });

  useEffect(() => {
    const now = Date.now();
    const prev = last.current;
    if (playing && (now - prev.at < ADDRESS_EVERY_MS || metres(prev, { lat, lng }) < ADDRESS_MOVE_M)) return;
    if (!playing) {
      // Paused / seeking: the exact point, once the cursor settles.
      const timer = setTimeout(() => {
        last.current = { lat, lng, at: Date.now() };
        setPoint({ lat, lng });
      }, 350);
      return () => clearTimeout(timer);
    }
    last.current = { lat, lng, at: now };
    setPoint({ lat, lng });
  }, [lat, lng, playing]);

  const { address } = useAddress(point.lat, point.lng);
  // Keep showing the previous address while the next one loads.
  const shown = useRef<string | null>(null);
  if (address) shown.current = address;

  return (
    <View style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-start', paddingHorizontal: SPACE.md, paddingBottom: SPACE.sm }}>
      <MapPinIcon size={14} color={c.mutedForeground} style={{ marginTop: 2 }} />
      <View style={{ flex: 1 }}>
        {shown.current ? (
          <Text size="sm" numberOfLines={2}>
            {shown.current}
          </Text>
        ) : null}
        <Text size="xs" tone="muted" selectable style={{ fontVariant: ['tabular-nums'] }}>
          {`${lat.toFixed(5)}, ${lng.toFixed(5)}`}
        </Text>
      </View>
    </View>
  );
}
