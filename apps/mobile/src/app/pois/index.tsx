import { useInfiniteQuery } from '@tanstack/react-query';
import type { Paginated, PoiDto } from '@veetracer/shared';
import { router, Stack } from 'expo-router';
import { ChevronRightIcon, MapPinIcon, PlusIcon } from 'lucide-react-native';
import { useDeferredValue, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, View } from 'react-native';
import { Card, EmptyState, ErrorBanner, SearchInput, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { formatRadius, usePoiCategories } from '@/features/pois/categories';
import { api, errorMessage } from '@/lib/api';
import { SPACE, useColors } from '@/lib/theme';

export default function PoisScreen() {
  const c = useColors();
  const { t } = useTranslation();
  const { can } = useAuth();
  const categories = usePoiCategories();
  const [q, setQ] = useState('');
  const search = useDeferredValue(q.trim());
  const list = useInfiniteQuery({
    queryKey: ['pois', 'list', search],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => api.get<Paginated<PoiDto>>('/pois', { page: pageParam, pageSize: 50, q: search, sort: 'name', order: 'asc' }, signal),
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const canCreate = can('pois', 'create');
  return (
    <>
      <Stack.Screen
        options={{
          title: t('Points of interest'),
          headerRight: () =>
            canCreate ? (
              <Pressable onPress={() => router.push('/pois/new')} hitSlop={10} accessibilityLabel={t('Add point of interest')} style={{ paddingHorizontal: SPACE.sm }}>
                <PlusIcon size={24} color={c.primary} />
              </Pressable>
            ) : null,
        }}
      />
      <View style={{ padding: SPACE.lg, paddingBottom: SPACE.sm }}>
        <SearchInput value={q} onChangeText={setQ} placeholder={t('Search points of interest')} />
      </View>
      {list.isError && (
        <View style={{ paddingHorizontal: SPACE.lg }}>
          <ErrorBanner message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
        </View>
      )}
      <FlatList
        data={rows}
        keyExtractor={(p) => p.id}
        contentContainerStyle={{ padding: SPACE.lg, paddingTop: SPACE.xs, gap: SPACE.sm, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={list.isRefetching && !list.isFetchingNextPage} onRefresh={() => void list.refetch()} />}
        onEndReachedThreshold={0.5}
        onEndReached={() => list.hasNextPage && !list.isFetchingNextPage && list.fetchNextPage()}
        renderItem={({ item: p }) => (
          <Card onPress={() => router.push(`/pois/${p.id}`)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md }}>
              <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: p.color }} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text weight="600" numberOfLines={1}>
                  {p.name}
                </Text>
                <Text size="sm" tone="muted" numberOfLines={1}>
                  {[categories.label(p.category), formatRadius(p.radiusM), p.isActive ? null : t('Inactive')].filter(Boolean).join(' · ')}
                </Text>
                {!!p.address && (
                  <Text size="xs" tone="muted" numberOfLines={1}>
                    {p.address}
                  </Text>
                )}
              </View>
              <ChevronRightIcon size={18} color={c.mutedForeground} />
            </View>
          </Card>
        )}
        ListFooterComponent={list.isFetchingNextPage ? <ActivityIndicator style={{ margin: SPACE.lg }} /> : undefined}
        ListEmptyComponent={
          list.isPending ? (
            <ActivityIndicator style={{ margin: SPACE.xl }} />
          ) : (
            <EmptyState icon={MapPinIcon} title={t('No points of interest')} description={canCreate ? t('Tap + to add one, or use "Add POI here" on the live map.') : undefined} />
          )
        }
      />
    </>
  );
}
