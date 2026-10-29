import { router } from 'expo-router';
import { TruckIcon } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, RefreshControl, View } from 'react-native';
import { Card, EmptyState, SearchInput } from '@/components/ui';
import { matches, StatusChips, VehicleSummary, type StatusFilter } from '@/features/live/components';
import { useDayStats, VehicleDayDetails } from '@/features/live/day-stats';
import { liveStore } from '@/features/live/live-store';
import { useLiveVersion, useNow } from '@/features/live/use-live';
import { SPACE } from '@/lib/theme';

export default function VehiclesScreen() {
  const { t } = useTranslation();
  const version = useLiveVersion(2000);
  const now = useNow();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [refreshing, setRefreshing] = useState(false);
  const dayStats = useDayStats();

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const all = useMemo(() => liveStore.all(), [version]);
  const searched = useMemo(() => all.filter((o) => matches(o, q, 'ALL')), [all, q]);
  const rows = useMemo(() => searched.filter((o) => matches(o, '', status)).sort((a, b) => a.name.localeCompare(b.name)), [searched, status]);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([liveStore.loadSnapshot().catch(() => undefined), dayStats.refetch()]);
    setRefreshing(false);
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ gap: SPACE.sm, paddingVertical: SPACE.sm }}>
        <View style={{ paddingHorizontal: SPACE.lg }}>
          <SearchInput value={q} onChangeText={setQ} placeholder={t('Search vehicle, plate or IMEI')} />
        </View>
        <StatusChips objects={searched} value={status} onChange={setStatus} />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(o) => o.objectId}
        contentContainerStyle={{ padding: SPACE.lg, paddingTop: SPACE.xs, gap: SPACE.sm, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        renderItem={({ item }) => (
          <Card onPress={() => router.push(`/vehicle/${item.objectId}`)}>
            <VehicleSummary o={item} now={now} />
            <VehicleDayDetails o={item} stats={dayStats.data?.[item.objectId]} now={now} />
          </Card>
        )}
        ListEmptyComponent={
          liveStore.snapshotLoaded ? <EmptyState icon={TruckIcon} title={all.length ? t('No matching vehicles') : t('No vehicles yet')} description={all.length ? t('Try another search or status.') : t('Vehicles added on the web appear here.')} /> : undefined
        }
      />
    </View>
  );
}
