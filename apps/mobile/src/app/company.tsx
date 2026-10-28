import { useInfiniteQuery } from '@tanstack/react-query';
import type { CompanyDto, Paginated } from '@veetracer/shared';
import { router } from 'expo-router';
import { Building2Icon, CheckIcon } from 'lucide-react-native';
import { useDeferredValue, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, RefreshControl, View } from 'react-native';
import { ALL_COMPANIES } from '@veetracer/shared';
import { Card, EmptyState, ErrorBanner, SearchInput, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { api, errorMessage } from '@/lib/api';
import { SPACE, useColors } from '@/lib/theme';

const PAGE_SIZE = 50;

/**
 * Super Admin only: choose the company to act in (same as the web company switcher). The choice is sent as
 * X-Company-Id / the socket companyId; switching clears the previous company's live data and cached queries.
 */
export default function CompanyScreen() {
  const c = useColors();
  const { t } = useTranslation();
  const { me, companyId, switchCompany } = useAuth();
  const [q, setQ] = useState('');
  const search = useDeferredValue(q.trim());

  const list = useInfiniteQuery({
    queryKey: ['company-switcher', search],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      api.get<Paginated<CompanyDto>>('/admin/companies', { page: pageParam, pageSize: PAGE_SIZE, q: search, sort: 'name', order: 'asc' }, signal),
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
    enabled: !!me?.user.isSuperAdmin,
  });

  if (!me?.user.isSuperAdmin) return <EmptyState icon={Building2Icon} title={t('Only Super Admin can switch companies.')} />;

  const choose = (id: string | null) => {
    switchCompany(id);
    // Back to the vehicle list of the chosen company.
    router.dismissTo('/');
  };

  const platform = { id: null, name: t('Platform (no company)'), hint: t('Super Admin home') };
  const all = { id: ALL_COMPANIES as string | null, name: t('All companies'), hint: t('Live map, vehicles, devices and drivers of every company') };
  const rows = [all, platform, ...(list.data?.pages.flatMap((p) => p.items) ?? []).map((co) => ({
    id: co.id as string | null,
    name: co.name,
    hint: co.status === 'SUSPENDED' ? t('{{count}} objects · suspended', { count: co.objectCount }) : t('{{count}} objects', { count: co.objectCount }),
  }))];

  return (
    <>
      <View style={{ padding: SPACE.lg, paddingBottom: SPACE.sm, gap: SPACE.sm }}>
        <SearchInput value={q} onChangeText={setQ} placeholder={t('Search companies…')} />
        <Text size="sm" tone="muted">
          {t('Now viewing: {{name}}', { name: companyId === ALL_COMPANIES ? t('All companies') : me.company.name })}
        </Text>
      </View>
      {list.isError && (
        <View style={{ paddingHorizontal: SPACE.lg }}>
          <ErrorBanner message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
        </View>
      )}
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id ?? 'platform'}
        contentContainerStyle={{ padding: SPACE.lg, paddingTop: SPACE.xs, gap: SPACE.sm, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={list.isRefetching && !list.isFetchingNextPage} onRefresh={() => void list.refetch()} />}
        onEndReachedThreshold={0.5}
        onEndReached={() => list.hasNextPage && !list.isFetchingNextPage && list.fetchNextPage()}
        renderItem={({ item }) => {
          const selected = (item.id ?? null) === (companyId ?? null);
          return (
            <Card onPress={() => choose(item.id)}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
                <Building2Icon size={20} color={c.primary} />
                <View style={{ flex: 1 }}>
                  <Text weight={selected ? '700' : '600'} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text size="sm" tone="muted" numberOfLines={1}>
                    {item.hint}
                  </Text>
                </View>
                {selected && <CheckIcon size={20} color={c.primary} />}
              </View>
            </Card>
          );
        }}
        ListFooterComponent={list.isFetching && !list.isRefetching ? <ActivityIndicator style={{ margin: SPACE.lg }} /> : undefined}
        ListEmptyComponent={list.isSuccess ? <EmptyState icon={Building2Icon} title={t('No companies found')} /> : undefined}
      />
    </>
  );
}
