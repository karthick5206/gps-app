import { useQuery } from '@tanstack/react-query';
import { MapPinIcon, XIcon } from 'lucide-react-native';
import { useDeferredValue, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Keyboard, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SearchInput, Text } from '@/components/ui';
import { api } from '@/lib/api';
import { RADIUS, SPACE, useColors } from '@/lib/theme';

export interface Place {
  label: string;
  lat: number;
  lng: number;
}

/** Address box over the geofence map: suggests places as you type. Only reports the pick; it never changes the shape. */
export function PlaceSearch({ near, onPick }: { near: () => Promise<{ lat: number; lng: number } | null>; onPick: (place: Place | null) => void }) {
  const c = useColors();
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const search = useDeferredValue(q.trim());
  const ready = search.length >= 3 && search !== picked;
  const places = useQuery({
    queryKey: ['geocode-search', 'geofence', search],
    queryFn: async ({ signal }) => {
      const at = await near();
      return api.get<Place[]>('/geocode/search', at ? { q: search, lat: at.lat, lng: at.lng } : { q: search }, signal);
    },
    enabled: ready,
    staleTime: 60_000,
  });
  const results = ready ? (places.data ?? []) : [];

  const choose = (p: Place) => {
    Keyboard.dismiss();
    setQ(p.label);
    setPicked(p.label);
    onPick(p);
  };
  const clear = () => {
    setQ('');
    setPicked(null);
    onPick(null);
  };

  return (
    // The list stays inside this box: on Android, touches outside a parent's bounds are lost.
    <View style={styles.wrap} pointerEvents="box-none">
      <View>
        <SearchInput
          value={q}
          onChangeText={setQ}
          placeholder={t('Search an address or place')}
          accessibilityLabel={t('Search an address or place')}
          returnKeyType="search"
          onSubmitEditing={() => results[0] && choose(results[0])}
          style={{ paddingRight: 40 }}
        />
        {!!q && (
          <Pressable onPress={clear} hitSlop={8} accessibilityLabel={t('Clear search')} style={styles.clear}>
            <XIcon size={16} color={c.mutedForeground} />
          </Pressable>
        )}
      </View>
      {ready && (
        <View style={[styles.list, { backgroundColor: c.card, borderColor: c.border }]}>
          {results.length > 0 ? (
            <ScrollView keyboardShouldPersistTaps="handled">
              {results.map((p) => (
                <Pressable key={`${p.lat},${p.lng}`} onPress={() => choose(p)} style={[styles.row, { borderBottomColor: c.border }]}>
                  <MapPinIcon size={14} color={c.mutedForeground} style={{ marginTop: 2 }} />
                  <Text size="sm" style={{ flex: 1 }}>
                    {p.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : places.isFetching ? (
            <View style={styles.row}>
              <ActivityIndicator size="small" />
              <Text size="sm" tone="muted">
                {t('Searching…')}
              </Text>
            </View>
          ) : (
            <View style={styles.row}>
              <Text size="sm" tone="muted">
                {t('No places found')}
              </Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: SPACE.sm, left: SPACE.sm, right: SPACE.sm, gap: 4, elevation: 6 },
  clear: { position: 'absolute', right: 12, top: 0, bottom: 0, justifyContent: 'center' },
  list: { maxHeight: 200, borderRadius: RADIUS.sm, borderWidth: 1, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.sm, paddingHorizontal: SPACE.md, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'transparent' },
});
