import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ALERT_TYPE_MAP, type AlertDto, type AlertSeverity, type AlertUnreadCount, type Paginated } from '@veetracer/shared';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { BellOffIcon, CheckCheckIcon, XIcon } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { Card, Chips, EmptyState, ErrorBanner, Pill, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { AlertTypeIcon } from '@/features/alerts/alert-icons';
import { useNow } from '@/features/live/use-live';
import { api, errorMessage } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { RADIUS, SPACE, useColors } from '@/lib/theme';

const PAGE_SIZE = 30;
type SeverityFilter = AlertSeverity | 'ALL';
type ReadFilter = 'UNREAD' | 'PENDING_ACK' | 'ALL';

function AlertRow({ a, now }: { a: AlertDto; now: number }) {
  const c = useColors();
  const { t } = useTranslation();
  const unread = !a.read && a.status === 'NEW';
  return (
    <Card onPress={() => router.push(`/alert/${a.id}`)} style={unread ? { borderLeftWidth: 3, borderLeftColor: c.primary } : undefined}>
      <View style={{ flexDirection: 'row', gap: SPACE.md }}>
        <AlertTypeIcon type={a.type} severity={a.severity} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
            <Text weight={unread ? '700' : '500'} numberOfLines={1} style={{ flex: 1 }}>
              {t(ALERT_TYPE_MAP[a.type]?.label ?? a.type)}
            </Text>
            {unread && <View accessible accessibilityLabel={t('Unread')} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.primary }} />}
            <Text size="xs" tone="muted">
              {relativeTime(a.occurredAt, now)}
            </Text>
          </View>
          <Text size="sm" weight="500" numberOfLines={1}>
            {a.objectName}
            {a.plateNumber && a.plateNumber !== a.objectName ? ` · ${a.plateNumber}` : ''}
          </Text>
          <Text size="sm" tone="muted" numberOfLines={2}>
            {a.message}
          </Text>
          {a.ackRequired && a.status === 'NEW' && (
            <View style={{ flexDirection: 'row' }}>
              <Pill label={t('Needs acknowledgement')} color="#dc2626" />
            </View>
          )}
          {a.address && (
            <Text size="xs" tone="muted" numberOfLines={1}>
              {a.address}
            </Text>
          )}
        </View>
      </View>
    </Card>
  );
}

export default function AlertsScreen() {
  const c = useColors();
  const { t } = useTranslation();
  const now = useNow();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ objectId?: string; name?: string }>();
  const [severity, setSeverity] = useState<SeverityFilter>('ALL');
  const [readFilter, setReadFilter] = useState<ReadFilter>('ALL');
  const objectId = params.objectId || undefined;

  const list = useInfiniteQuery({
    queryKey: ['alerts', 'list', { severity, readFilter, objectId }],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      api.get<Paginated<AlertDto>>(
        '/alerts',
        { page: pageParam, pageSize: PAGE_SIZE, sort: 'occurredAt', order: 'desc', severity: severity === 'ALL' ? undefined : severity, read: readFilter === 'UNREAD' ? false : undefined, pendingAck: readFilter === 'PENDING_ACK' ? true : undefined, objectId },
        signal,
      ),
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  // Same query as the tab badge (shared cache): how many alerts still need acknowledgement.
  const counts = useQuery({
    queryKey: ['alerts', 'unread-count'],
    queryFn: ({ signal }) => api.get<AlertUnreadCount>('/alerts/unread-count', undefined, signal),
  });
  const pendingAck = counts.data?.pendingAck ?? 0;

  const ackAll = useMutation({
    mutationFn: () => api.post('/alerts/ack-all', {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alerts'] }),
    onError: (err) => Alert.alert(t('Could not acknowledge'), errorMessage(err)),
  });
  // Read is per user (any role); acknowledging is shared and needs alerts:edit.
  const readAll = useMutation({
    mutationFn: () => api.post('/alerts/read-all', {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alerts'] }),
    onError: (err) => Alert.alert(t('Could not mark as read'), errorMessage(err)),
  });
  const busy = ackAll.isPending || readAll.isPending;
  const openActions = () =>
    Alert.alert(t('Alerts'), undefined, [
      { text: t('Mark all as read'), onPress: () => readAll.mutate() },
      ...(can('alerts', 'edit')
        ? [{ text: t('Acknowledge all'), onPress: () => Alert.alert(t('Acknowledge all?'), t('Marks every new alert as acknowledged.'), [
            { text: t('Cancel'), style: 'cancel' as const },
            { text: t('Acknowledge'), onPress: () => ackAll.mutate() },
          ]) }]
        : []),
      { text: t('Cancel'), style: 'cancel' as const },
    ]);

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={openActions} hitSlop={10} style={{ paddingHorizontal: SPACE.lg }} accessibilityLabel={can('alerts', 'edit') ? t('Mark all as read or acknowledge all') : t('Mark all as read')}>
              {busy ? <ActivityIndicator /> : <CheckCheckIcon size={22} color={c.foreground} />}
            </Pressable>
          ),
        }}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ padding: SPACE.lg, paddingBottom: SPACE.sm, gap: SPACE.sm }}>
        <Chips
          value={readFilter}
          onChange={setReadFilter}
          options={[
            { value: 'ALL', label: t('All') },
            { value: 'UNREAD', label: t('Unread') },
            { value: 'PENDING_ACK', label: pendingAck ? `${t('Needs acknowledgement')} (${pendingAck})` : t('Needs acknowledgement') },
          ]}
        />
        <Chips
          value={severity}
          onChange={setSeverity}
          options={[
            { value: 'ALL', label: t('Any severity') },
            { value: 'CRITICAL', label: t('Critical'), color: '#dc2626' },
            { value: 'WARNING', label: t('Warning'), color: '#d97706' },
            { value: 'INFO', label: t('Info'), color: '#2563eb' },
          ]}
        />
      </ScrollView>
      {objectId && (
        <View style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginHorizontal: SPACE.lg, marginBottom: SPACE.sm, gap: 6, paddingLeft: 12, paddingRight: 6, paddingVertical: 4, borderRadius: RADIUS.full, backgroundColor: c.accent }}>
          <Text size="sm" weight="500">
            {params.name ?? t('One vehicle')}
          </Text>
          <Pressable onPress={() => router.setParams({ objectId: '', name: '' })} hitSlop={8} accessibilityLabel={t('Show all vehicles')}>
            <XIcon size={16} color={c.foreground} />
          </Pressable>
        </View>
      )}
      {list.isError && (
        <View style={{ paddingHorizontal: SPACE.lg }}>
          <ErrorBanner message={errorMessage(list.error)} onRetry={() => list.refetch()} />
        </View>
      )}
      <FlatList
        data={rows}
        keyExtractor={(a) => a.id}
        contentContainerStyle={{ padding: SPACE.lg, paddingTop: SPACE.xs, gap: SPACE.sm, flexGrow: 1 }}
        renderItem={({ item }) => <AlertRow a={item} now={now} />}
        refreshControl={<RefreshControl refreshing={list.isRefetching && !list.isFetchingNextPage} onRefresh={() => void list.refetch()} />}
        onEndReachedThreshold={0.5}
        onEndReached={() => list.hasNextPage && !list.isFetchingNextPage && list.fetchNextPage()}
        ListFooterComponent={list.isFetchingNextPage ? <ActivityIndicator style={{ margin: SPACE.lg }} /> : undefined}
        ListEmptyComponent={list.isPending ? <ActivityIndicator style={{ margin: SPACE.xl }} /> : <EmptyState icon={BellOffIcon} title={t('No alerts')} description={t('Alerts matching these filters will appear here.')} />}
      />
    </View>
  );
}
