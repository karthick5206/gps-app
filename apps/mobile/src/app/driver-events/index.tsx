import { useInfiniteQuery } from '@tanstack/react-query';
import type { DriverEventDto, DriverEventStatus, Paginated } from '@veetracer/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { CameraOffIcon, ScanFaceIcon } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, Image, RefreshControl, View } from 'react-native';
import { Card, Chips, EmptyState, ErrorBanner, Pill, Text } from '@/components/ui';
import { AlertTypeIcon } from '@/features/alerts/alert-icons';
import { eventLabel, eventSeverity, mediaUri, STATUS_COLOR, STATUS_LABEL } from '@/features/driver-events/driver-events';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { SPACE, useColors } from '@/lib/theme';

const PAGE_SIZE = 20;
type Filter = DriverEventStatus | 'ALL' | 'PHOTO';

function Thumb({ e }: { e: DriverEventDto }) {
  const c = useColors();
  const [failed, setFailed] = useState(false);
  return (
    <View style={{ width: 112, height: 72, borderRadius: 8, overflow: 'hidden', backgroundColor: c.muted, alignItems: 'center', justifyContent: 'center' }}>
      {e.thumbnailUrl && !failed ? (
        <Image source={{ uri: mediaUri(e.thumbnailUrl) }} style={{ width: '100%', height: '100%' }} resizeMode="cover" onError={() => setFailed(true)} />
      ) : (
        <CameraOffIcon size={20} color={c.mutedForeground} />
      )}
    </View>
  );
}

/** Driver events (ADAS / DMS / crash) with cabin snapshots; `?objectId=` narrows to one vehicle. */
export default function DriverEventsScreen() {
  const { t } = useTranslation();
  const { objectId } = useLocalSearchParams<{ objectId?: string }>();
  const [filter, setFilter] = useState<Filter>('ALL');
  const list = useInfiniteQuery({
    queryKey: ['driver-events', 'list', objectId ?? null, filter],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      api.get<Paginated<DriverEventDto>>(
        '/driver-events',
        { page: pageParam, pageSize: PAGE_SIZE, objectId, status: filter === 'ALL' || filter === 'PHOTO' ? undefined : filter, hasPhoto: filter === 'PHOTO' ? true : undefined },
        signal,
      ),
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
    refetchInterval: 60_000,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, paddingBottom: SPACE.sm }}>
        <Chips<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'ALL', label: t('All') },
            { value: 'NEW', label: t('New') },
            { value: 'PHOTO', label: t('With snapshot') },
            { value: 'REVIEWED', label: t('Reviewed') },
            { value: 'COACHED', label: t('Coached') },
            { value: 'DISMISSED', label: t('Dismissed') },
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
        renderItem={({ item }) => (
          <Card onPress={() => router.push(`/driver-events/${item.id}`)}>
            <View style={{ flexDirection: 'row', gap: SPACE.md }}>
              <Thumb e={item} />
              <View style={{ flex: 1, gap: 3 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <AlertTypeIcon type={item.type} severity={eventSeverity(item.type)} size={22} />
                  <Text weight="600" numberOfLines={1} style={{ flex: 1 }}>
                    {t(eventLabel(item.type))}
                  </Text>
                </View>
                <Text size="sm" numberOfLines={1}>
                  {item.objectName}
                  {item.driverName ? ` · ${item.driverName}` : ''}
                </Text>
                <Text size="xs" tone="muted" numberOfLines={1}>
                  {formatDateTime(item.occurredAt)}
                  {item.speedKph !== null ? ` · ${Math.round(item.speedKph)} km/h` : ''}
                </Text>
                <Pill label={t(STATUS_LABEL[item.status])} color={STATUS_COLOR[item.status]} style={{ alignSelf: 'flex-start' }} />
              </View>
            </View>
          </Card>
        )}
        ListFooterComponent={list.isFetchingNextPage ? <ActivityIndicator style={{ margin: SPACE.lg }} /> : undefined}
        ListEmptyComponent={
          list.isPending ? (
            <ActivityIndicator style={{ margin: SPACE.xl }} />
          ) : (
            <EmptyState icon={ScanFaceIcon} title={t('No driver events')} description={t('Events appear here when a dashcam reports fatigue, phone use, smoking, collision warnings or a crash.')} />
          )
        }
      />
    </View>
  );
}
