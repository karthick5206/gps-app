import { useInfiniteQuery } from '@tanstack/react-query';
import type { Paginated } from '@veetracer/shared';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { ChevronRightIcon, DatabaseIcon, PlusIcon } from 'lucide-react-native';
import { useDeferredValue, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, View } from 'react-native';
import { Card, EmptyState, ErrorBanner, SearchInput, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { isKind, KINDS } from '@/features/manage/kinds';
import { api, errorMessage } from '@/lib/api';
import { SPACE, useColors } from '@/lib/theme';

const PAGE_SIZE = 30;

export default function ManageListScreen() {
  const { kind } = useLocalSearchParams<{ kind: string }>();
  const c = useColors();
  const { t } = useTranslation();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const search = useDeferredValue(q.trim());
  const def = isKind(kind) ? KINDS[kind] : null;

  const list = useInfiniteQuery({
    queryKey: ['manage', kind, search],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => api.get<Paginated<Record<string, unknown>>>(def!.endpoint, { page: pageParam, pageSize: PAGE_SIZE, q: search }, signal),
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
    enabled: !!def,
  });
  if (!def || !isKind(kind)) return <EmptyState icon={DatabaseIcon} title={t('Unknown list')} />;
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;
  const canCreate = can(def.menu, 'create');
  const canEdit = can(def.menu, 'edit');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const kd = def as { rowTitle: (r: any) => string; rowSubtitle: (r: any) => string };

  return (
    <>
      <Stack.Screen
        options={{
          title: t(def.title),
          headerRight: () =>
            canCreate ? (
              <Pressable onPress={() => router.push(`/manage/${kind}/new`)} hitSlop={10} accessibilityLabel={t(def.addLabel)} style={{ paddingHorizontal: SPACE.sm }}>
                <PlusIcon size={24} color={c.primary} />
              </Pressable>
            ) : null,
        }}
      />
      <View style={{ padding: SPACE.lg, paddingBottom: SPACE.sm, gap: SPACE.sm }}>
        <SearchInput value={q} onChangeText={setQ} placeholder={t(def.search)} />
        <Text size="sm" tone="muted">
          {total === 1 ? t(def.countOne) : t(def.countMany, { n: total.toLocaleString() })}
        </Text>
      </View>
      {list.isError && (
        <View style={{ paddingHorizontal: SPACE.lg }}>
          <ErrorBanner message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
        </View>
      )}
      <FlatList
        data={rows}
        keyExtractor={(r) => String(r.id)}
        contentContainerStyle={{ padding: SPACE.lg, paddingTop: SPACE.xs, gap: SPACE.sm, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={list.isRefetching && !list.isFetchingNextPage} onRefresh={() => void list.refetch()} />}
        onEndReachedThreshold={0.5}
        onEndReached={() => list.hasNextPage && !list.isFetchingNextPage && list.fetchNextPage()}
        renderItem={({ item }) => (
          <Card onPress={canEdit ? () => router.push(`/manage/${kind}/${String(item.id)}`) : undefined}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
              <View style={{ flex: 1 }}>
                <Text weight="600" numberOfLines={1}>
                  {kd.rowTitle(item)}
                </Text>
                <Text size="sm" tone="muted" numberOfLines={2}>
                  {kd.rowSubtitle(item)}
                </Text>
              </View>
              {canEdit && <ChevronRightIcon size={18} color={c.mutedForeground} />}
            </View>
          </Card>
        )}
        ListFooterComponent={list.isFetchingNextPage ? <ActivityIndicator style={{ margin: SPACE.lg }} /> : undefined}
        ListEmptyComponent={
          list.isPending ? <ActivityIndicator style={{ margin: SPACE.xl }} /> : <EmptyState icon={DatabaseIcon} title={t(def.emptyTitle)} description={canCreate ? t('Tap + to add one.') : undefined} />
        }
      />
    </>
  );
}
