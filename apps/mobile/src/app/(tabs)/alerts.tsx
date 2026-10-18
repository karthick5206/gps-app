import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ALERT_TYPE_MAP, type AlertDto, type AlertSeverity, type Paginated } from '@veetracer/shared';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { BellOffIcon, CheckCheckIcon, XIcon } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { Card, Chips, EmptyState, ErrorBanner, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { AlertTypeIcon } from '@/features/alerts/alert-icons';
import { useNow } from '@/features/live/use-live';
import { api, errorMessage } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { RADIUS, SPACE, useColors } from '@/lib/theme';

const PAGE_SIZE = 30;
type SeverityFilter = AlertSeverity | 'ALL';
type StatusFilter = 'NEW' | 'ALL';

function AlertRow({ a, now }: { a: AlertDto; now: number }) {
  const c = useColors();
  return (
    <Card onPress={() => router.push(`/alert/${a.id}`)} style={a.status === 'NEW' ? { borderLeftWidth: 3, borderLeftColor: c.primary } : undefined}>
      <View style={{ flexDirection: 'row', gap: SPACE.md }}>
        <AlertTypeIcon type={a.type} severity={a.severity} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
            <Text weight={a.status === 'NEW' ? '700' : '500'} numberOfLines={1} style={{ flex: 1 }}>
              {ALERT_TYPE_MAP[a.type]?.label ?? a.type}
            </Text>
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
        </View>
      </View>
    </Card>
  );
}

export default function AlertsScreen() {
  const c = useColors();
  const now = useNow();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ objectId?: string; name?: string }>();
  const [severity, setSeverity] = useState<SeverityFilter>('ALL');
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const objectId = params.objectId || undefined;

  const list = useInfiniteQuery({
    queryKey: ['alerts', 'list', { severity, status, objectId }],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      api.get<Paginated<AlertDto>>(
        '/alerts',
        { page: pageParam, pageSize: PAGE_SIZE, sort: 'occurredAt', order: 'desc', severity: severity === 'ALL' ? undefined : severity, status: status === 'ALL' ? undefined : status, objectId },
        signal,
      ),
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  const ackAll = useMutation({
    mutationFn: () => api.post('/alerts/ack-all', {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alerts'] }),
    onError: (err) => Alert.alert('Could not acknowledge', errorMessage(err)),
  });
  const confirmAckAll = () =>
    Alert.alert('Acknowledge all?', 'Marks every new alert as acknowledged.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Acknowledge', onPress: () => ackAll.mutate() },
    ]);

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          headerRight: () =>
            can('alerts', 'edit') ? (
              <Pressable onPress={confirmAckAll} hitSlop={10} style={{ paddingHorizontal: SPACE.lg }} accessibilityLabel="Acknowledge all">
                {ackAll.isPending ? <ActivityIndicator /> : <CheckCheckIcon size={22} color={c.foreground} />}
              </Pressable>
            ) : null,
        }}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ padding: SPACE.lg, paddingBottom: SPACE.sm, gap: SPACE.sm }}>
        <Chips
          value={status}
          onChange={setStatus}
          options={[
            { value: 'ALL', label: 'All' },
            { value: 'NEW', label: 'Unread' },
          ]}
        />
        <Chips
          value={severity}
          onChange={setSeverity}
          options={[
            { value: 'ALL', label: 'Any severity' },
            { value: 'CRITICAL', label: 'Critical', color: '#dc2626' },
            { value: 'WARNING', label: 'Warning', color: '#d97706' },
            { value: 'INFO', label: 'Info', color: '#2563eb' },
          ]}
        />
      </ScrollView>
      {objectId && (
        <View style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginHorizontal: SPACE.lg, marginBottom: SPACE.sm, gap: 6, paddingLeft: 12, paddingRight: 6, paddingVertical: 4, borderRadius: RADIUS.full, backgroundColor: c.accent }}>
          <Text size="sm" weight="500">
            {params.name ?? 'One vehicle'}
          </Text>
          <Pressable onPress={() => router.setParams({ objectId: '', name: '' })} hitSlop={8} accessibilityLabel="Show all vehicles">
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
        ListEmptyComponent={list.isPending ? <ActivityIndicator style={{ margin: SPACE.xl }} /> : <EmptyState icon={BellOffIcon} title="No alerts" description="Alerts matching these filters will appear here." />}
      />
    </View>
  );
}
