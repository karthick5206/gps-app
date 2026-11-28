import { useFocusEffect, router } from 'expo-router';
import { HistoryIcon } from 'lucide-react-native';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, View } from 'react-native';
import { Card, EmptyState, SearchInput, Text } from '@/components/ui';
import { loadRecentVehicles, rememberVehicle } from '@/features/history/recent-vehicles';
import { matches, VehicleSummary } from '@/features/live/components';
import { liveStore } from '@/features/live/live-store';
import { useLiveVersion, useNow } from '@/features/live/use-live';
import { SPACE } from '@/lib/theme';

/** History tab: pick a vehicle (recently replayed ones first) and its replay opens. */
export default function HistoryTab() {
  const { t } = useTranslation();
  const version = useLiveVersion(5000);
  const now = useNow();
  const [q, setQ] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  useFocusEffect(
    useCallback(() => {
      void loadRecentVehicles().then(setRecent);
    }, []),
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const all = useMemo(() => liveStore.all(), [version]);
  const rows = useMemo(() => {
    const rank = new Map(recent.map((id, i) => [id, i]));
    return all
      .filter((o) => matches(o, q, 'ALL'))
      .sort((a, b) => (rank.get(a.objectId) ?? 1e9) - (rank.get(b.objectId) ?? 1e9) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [all, q, recent]);
  const recentCount = q ? 0 : rows.filter((o) => recent.includes(o.objectId)).length;

  const open = (id: string) => {
    void rememberVehicle(id);
    router.push(`/history/${id}`);
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm }}>
        <SearchInput value={q} onChangeText={setQ} placeholder={t('Search vehicle, plate or IMEI')} />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(o) => o.objectId}
        contentContainerStyle={{ padding: SPACE.lg, paddingTop: SPACE.xs, gap: SPACE.sm, flexGrow: 1 }}
        renderItem={({ item, index }) => (
          <>
            {recentCount > 0 && (index === 0 || index === recentCount) && (
              <Text size="xs" tone="muted" weight="600" style={{ marginTop: index ? SPACE.sm : 0 }}>
                {index === 0 ? t('Recently viewed') : t('All vehicles')}
              </Text>
            )}
            <Card onPress={() => open(item.objectId)}>
              <VehicleSummary o={item} now={now} />
            </Card>
          </>
        )}
        ListEmptyComponent={liveStore.snapshotLoaded ? <EmptyState icon={HistoryIcon} title={all.length ? t('No matching vehicles') : t('No vehicles yet')} description={all.length ? t('Try another search.') : undefined} /> : undefined}
      />
    </View>
  );
}
