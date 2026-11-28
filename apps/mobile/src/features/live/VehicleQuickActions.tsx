import type { LiveObject, VideoChannelsDto } from '@veetracer/shared';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { BellIcon, HistoryIcon, ScanFaceIcon, Share2Icon, TerminalIcon, VideoIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';
import { Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { api } from '@/lib/api';
import { RADIUS, SPACE, useColors } from '@/lib/theme';

type Action = { key: string; Icon: typeof HistoryIcon; label: string; onPress: () => void };

/** Dashcam channels (cached 5 min). The API answers NOT_DASHCAM for other trackers, so success = has video. */
export function useHasVideo(o: LiveObject | undefined): boolean {
  const { can } = useAuth();
  const q = useQuery({
    queryKey: ['video-channels', o?.objectId],
    queryFn: () => api.get<VideoChannelsDto>(`/video/${o!.objectId}/channels`),
    enabled: !!o && can('video') && !!o.deviceId && !o.licenceLocked,
    retry: false,
    staleTime: 5 * 60_000,
  });
  return q.isSuccess;
}

/** One-tap pages for a vehicle: History, Alerts, Share, Commands, Video, Driver events (only those the user may open). */
export function useVehicleActions(o: LiveObject): Action[] {
  const { t } = useTranslation();
  const { can } = useAuth();
  const video = useHasVideo(o);
  const name = o.plateNumber || o.name;
  const all: (Action | false)[] = [
    can('history') && { key: 'history', Icon: HistoryIcon, label: t('History'), onPress: () => router.push(`/history/${o.objectId}`) },
    can('alerts') && { key: 'alerts', Icon: BellIcon, label: t('Alerts'), onPress: () => router.push({ pathname: '/alerts', params: { objectId: o.objectId, name } }) },
    !o.licenceLocked && o.lat !== null && { key: 'share', Icon: Share2Icon, label: t('Share'), onPress: () => router.push(`/share/${o.objectId}`) },
    can('live_map', 'command') && { key: 'commands', Icon: TerminalIcon, label: t('Commands'), onPress: () => router.push(`/commands/${o.objectId}`) },
    video && { key: 'video', Icon: VideoIcon, label: t('Video'), onPress: () => router.push({ pathname: '/video/[id]', params: { id: o.objectId, name } }) },
    video && can('driver_events') && { key: 'events', Icon: ScanFaceIcon, label: t('Driver events'), onPress: () => router.push({ pathname: '/driver-events', params: { objectId: o.objectId } }) },
  ];
  return all.filter(Boolean) as Action[];
}

/**
 * Row of round action buttons. Up to 5 share the width evenly; more scroll sideways so every phone width fits
 * without wrapping or squeezing the labels.
 */
export function VehicleQuickActions({ o }: { o: LiveObject }) {
  const c = useColors();
  const actions = useVehicleActions(o);
  if (!actions.length) return null;
  const fits = actions.length <= 5;
  const item = (a: Action) => (
    <Pressable
      key={a.key}
      accessibilityRole="button"
      accessibilityLabel={a.label}
      onPress={a.onPress}
      hitSlop={4}
      style={({ pressed }) => [{ alignItems: 'center', gap: 4, paddingVertical: 6, borderRadius: RADIUS.md, opacity: pressed ? 0.6 : 1 }, fits ? { flex: 1 } : { width: 72 }]}
    >
      <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: c.accent }}>
        <a.Icon size={20} color={c.accentForeground} />
      </View>
      <Text size="xs" weight="600" numberOfLines={1} style={{ textAlign: 'center' }}>
        {a.label}
      </Text>
    </Pressable>
  );
  return fits ? (
    <View style={{ flexDirection: 'row', gap: SPACE.xs }}>{actions.map(item)}</View>
  ) : (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: SPACE.xs }}>
      {actions.map(item)}
    </ScrollView>
  );
}
