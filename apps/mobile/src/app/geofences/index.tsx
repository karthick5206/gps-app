import { useInfiniteQuery } from '@tanstack/react-query';
import type { GeofenceDto, Paginated } from '@veetracer/shared';
import { router, Stack } from 'expo-router';
import { ChevronRightIcon, HexagonIcon, PlusIcon } from 'lucide-react-native';
import { useDeferredValue, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, View } from 'react-native';
import { Card, EmptyState, ErrorBanner, SearchInput, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { describeGeometry } from '@/features/geofences/geo-shapes';
import { api, errorMessage } from '@/lib/api';
import { SPACE, useColors } from '@/lib/theme';

const MODE_LABEL = { NORMAL: 'Normal', NO_GO: 'No-go zone', KEEP_IN: 'Keep-in zone' } as const;

export default function GeofencesScreen() {
  const c = useColors();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const search = useDeferredValue(q.trim());
  const list = useInfiniteQuery({
    queryKey: ['geofences', search],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => api.get<Paginated<GeofenceDto>>('/geofences', { page: pageParam, pageSize: 50, q: search }, signal),
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const canCreate = can('geofences', 'create');
  return (
    <>
      <Stack.Screen
        options={{
          title: 'Geofences',
          headerRight: () =>
            canCreate ? (
              <Pressable onPress={() => router.push('/geofences/new')} hitSlop={10} accessibilityLabel="Add geofence" style={{ paddingHorizontal: SPACE.sm }}>
                <PlusIcon size={24} color={c.primary} />
              </Pressable>
            ) : null,
        }}
      />
      <View style={{ padding: SPACE.lg, paddingBottom: SPACE.sm }}>
        <SearchInput value={q} onChangeText={setQ} placeholder="Search geofences" />
      </View>
      {list.isError && (
        <View style={{ paddingHorizontal: SPACE.lg }}>
          <ErrorBanner message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
        </View>
      )}
      <FlatList
        data={rows}
        keyExtractor={(g) => g.id}
        contentContainerStyle={{ padding: SPACE.lg, paddingTop: SPACE.xs, gap: SPACE.sm, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={list.isRefetching && !list.isFetchingNextPage} onRefresh={() => void list.refetch()} />}
        onEndReached={() => list.hasNextPage && !list.isFetchingNextPage && list.fetchNextPage()}
        renderItem={({ item: g }) => (
          <Card onPress={() => router.push(`/geofences/${g.id}`)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md }}>
              <View style={{ width: 14, height: 14, borderRadius: 4, backgroundColor: g.color }} />
              <View style={{ flex: 1 }}>
                <Text weight="600" numberOfLines={1}>
                  {g.name}
                </Text>
                <Text size="sm" tone="muted" numberOfLines={1}>
                  {[describeGeometry(g.geometry), MODE_LABEL[g.mode], g.isActive ? null : 'Inactive'].filter(Boolean).join(' · ')}
                </Text>
              </View>
              <ChevronRightIcon size={18} color={c.mutedForeground} />
            </View>
          </Card>
        )}
        ListEmptyComponent={
          list.isPending ? <ActivityIndicator style={{ margin: SPACE.xl }} /> : <EmptyState icon={HexagonIcon} title="No geofences" description={canCreate ? 'Tap + to draw one on the map.' : undefined} />
        }
      />
    </>
  );
}
