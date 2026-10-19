import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { DocumentDto, DocumentStatus, Paginated, ServiceReminderDto, ServiceStatus } from '@veetracer/shared';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { ChevronRightIcon, FileTextIcon, PaperclipIcon, PlusIcon, WrenchIcon } from 'lucide-react-native';
import { useDeferredValue, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, View } from 'react-native';
import { Card, Chips, EmptyState, ErrorBanner, Pill, SearchInput, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { docTypeLabel, documentChip, formatKm, serviceChip } from '@/features/documents/status';
import { api, errorMessage } from '@/lib/api';
import { SPACE, useColors } from '@/lib/theme';

const PAGE_SIZE = 30;
type Tab = 'documents' | 'service';

function DocumentsList({ q }: { q: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const { can } = useAuth();
  const [expiry, setExpiry] = useState<DocumentStatus | 'ALL'>('ALL');
  const list = useInfiniteQuery({
    queryKey: ['documents', 'list', q, expiry],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      api.get<Paginated<DocumentDto>>('/documents', { page: pageParam, pageSize: PAGE_SIZE, q, expiry: expiry === 'ALL' ? undefined : expiry, sort: 'expiresOn', order: 'asc' }, signal),
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <View style={{ paddingHorizontal: SPACE.lg, paddingBottom: SPACE.sm }}>
        <Chips<DocumentStatus | 'ALL'>
          value={expiry}
          onChange={setExpiry}
          options={[
            { value: 'ALL', label: t('All') },
            { value: 'EXPIRED', label: t('Expired') },
            { value: 'EXPIRING', label: t('Expiring soon') },
            { value: 'VALID', label: t('Valid') },
          ]}
        />
      </View>
      {list.isError && (
        <View style={{ paddingHorizontal: SPACE.lg }}>
          <ErrorBanner message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
        </View>
      )}
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ padding: SPACE.lg, paddingTop: SPACE.xs, gap: SPACE.sm, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={list.isRefetching && !list.isFetchingNextPage} onRefresh={() => void list.refetch()} />}
        onEndReachedThreshold={0.5}
        onEndReached={() => list.hasNextPage && !list.isFetchingNextPage && list.fetchNextPage()}
        renderItem={({ item }) => {
          const chip = documentChip(item);
          return (
            <Card onPress={() => router.push(`/documents/${item.id}`)}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text weight="600" numberOfLines={1}>
                    {docTypeLabel(item.type)}
                    {item.number ? ` · ${item.number}` : ''}
                  </Text>
                  <Text size="sm" tone="muted" numberOfLines={1}>
                    {[item.driverName ? t('Driver: {{name}}', { name: item.driverName }) : item.objectName, item.expiresOn ? t('expires {{date}}', { date: item.expiresOn }) : null].filter(Boolean).join(' · ')}
                  </Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
                    <Pill label={chip.label} color={chip.color} />
                    {item.file && <PaperclipIcon size={14} color={c.mutedForeground} />}
                  </View>
                </View>
                <ChevronRightIcon size={18} color={c.mutedForeground} />
              </View>
            </Card>
          );
        }}
        ListFooterComponent={list.isFetchingNextPage ? <ActivityIndicator style={{ margin: SPACE.lg }} /> : undefined}
        ListEmptyComponent={
          list.isPending ? <ActivityIndicator style={{ margin: SPACE.xl }} /> : <EmptyState icon={FileTextIcon} title={t('No documents')} description={can('documents', 'create') ? t('Tap + to add one.') : undefined} />
        }
      />
    </>
  );
}

function ServiceList({ q }: { q: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const [due, setDue] = useState<ServiceStatus | 'ALL'>('ALL');
  const list = useQuery({
    queryKey: ['service-reminders', 'all', q],
    queryFn: ({ signal }) => api.get<ServiceReminderDto[]>('/service-reminders', { q }, signal),
  });
  const counts = useMemo(() => {
    const out: Record<ServiceStatus, number> = { OK: 0, DUE_SOON: 0, OVERDUE: 0 };
    for (const r of list.data ?? []) if (r.isActive) out[r.status]++;
    return out;
  }, [list.data]);
  const rows = (list.data ?? []).filter((r) => due === 'ALL' || (r.isActive && r.status === due));
  return (
    <>
      <View style={{ paddingHorizontal: SPACE.lg, paddingBottom: SPACE.sm }}>
        <Chips<ServiceStatus | 'ALL'>
          value={due}
          onChange={setDue}
          options={[
            { value: 'ALL', label: t('All') },
            { value: 'OVERDUE', label: t('Overdue'), count: counts.OVERDUE },
            { value: 'DUE_SOON', label: t('Due soon'), count: counts.DUE_SOON },
            { value: 'OK', label: t('OK'), count: counts.OK },
          ]}
        />
      </View>
      {list.isError && (
        <View style={{ paddingHorizontal: SPACE.lg }}>
          <ErrorBanner message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
        </View>
      )}
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ padding: SPACE.lg, paddingTop: SPACE.xs, gap: SPACE.sm, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={list.isRefetching} onRefresh={() => void list.refetch()} />}
        renderItem={({ item }) => {
          const chip = serviceChip(item);
          const dueText = [item.dueAt, item.dueOdometerKm !== null ? formatKm(item.dueOdometerKm) : null].filter(Boolean).join(' · ');
          return (
            <Card onPress={() => router.push(`/documents/service/${item.id}`)}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text weight="600" numberOfLines={1}>
                    {item.title} · {item.objectName}
                  </Text>
                  <Text size="sm" tone="muted" numberOfLines={1}>
                    {dueText ? t('Next due: {{when}}', { when: dueText }) : '—'} · {t('Odometer {{km}}', { km: formatKm(item.odometerKm) })}
                  </Text>
                  <Pill label={chip.label} color={chip.color} />
                </View>
                <ChevronRightIcon size={18} color={c.mutedForeground} />
              </View>
            </Card>
          );
        }}
        ListEmptyComponent={list.isPending ? <ActivityIndicator style={{ margin: SPACE.xl }} /> : <EmptyState icon={WrenchIcon} title={t('No service reminders')} />}
      />
    </>
  );
}

export default function DocumentsScreen() {
  const { t } = useTranslation();
  const c = useColors();
  const { can } = useAuth();
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<Tab>(params.tab === 'service' ? 'service' : 'documents');
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  return (
    <>
      <Stack.Screen
        options={{
          title: t('Documents & service'),
          headerRight: () =>
            can('documents', 'create') ? (
              <Pressable
                onPress={() => router.push(tab === 'service' ? '/documents/service/new' : '/documents/new')}
                hitSlop={10}
                accessibilityLabel={tab === 'service' ? t('Add service reminder') : t('Add document')}
                style={{ paddingHorizontal: SPACE.sm }}
              >
                <PlusIcon size={24} color={c.primary} />
              </Pressable>
            ) : null,
        }}
      />
      <View style={{ padding: SPACE.lg, paddingBottom: SPACE.sm, gap: SPACE.sm }}>
        <Chips<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'documents', label: t('Documents') },
            { value: 'service', label: t('Service') },
          ]}
        />
        <SearchInput value={search} onChangeText={setSearch} placeholder={tab === 'service' ? t('Search vehicle or service…') : t('Search number, vehicle or driver')} />
      </View>
      {tab === 'service' ? <ServiceList q={q} /> : <DocumentsList q={q} />}
    </>
  );
}
