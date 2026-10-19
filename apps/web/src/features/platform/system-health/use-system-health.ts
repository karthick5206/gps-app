import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SystemHealthDto, SystemHealthSettingsDto, SystemHealthSummary } from '@veetracer/shared';
import { useEffect } from 'react';
import { useAuth } from '@/features/auth/auth-context';
import { realtime } from '@/features/live/realtime';
import { api } from '@/lib/api';

export const HEALTH_KEY = ['system-health'] as const;
export const HEALTH_STATUS_KEY = ['system-health', 'status'] as const;
const REFRESH_MS = 5000;

/** Full report, refreshed every 5 s while the tab is visible (React Query pauses intervals in background tabs). */
export function useSystemHealth() {
  return useQuery({
    queryKey: HEALTH_KEY,
    queryFn: ({ signal }) => api.get<SystemHealthDto>('/admin/system-health', undefined, signal),
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });
}

export function useSystemHealthSettings(enabled: boolean) {
  return useQuery({
    queryKey: ['system-health', 'settings'],
    queryFn: ({ signal }) => api.get<SystemHealthSettingsDto>('/admin/system-health/settings', undefined, signal),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Super Admin only: last monitor evaluation for the top-bar banner, kept current by the `system:health` socket event
 * (which also refreshes the System Health page immediately).
 */
export function useSystemHealthStatus(): SystemHealthSummary | undefined {
  const { me } = useAuth();
  const isSuperAdmin = !!me?.user.isSuperAdmin;
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: HEALTH_STATUS_KEY,
    queryFn: ({ signal }) => api.get<SystemHealthSummary>('/admin/system-health/status', undefined, signal),
    enabled: isSuperAdmin,
    refetchInterval: 60_000,
    retry: false,
  });
  useEffect(() => {
    if (!isSuperAdmin) return;
    return realtime.on<[SystemHealthSummary]>('system:health', (summary) => {
      queryClient.setQueryData(HEALTH_STATUS_KEY, summary);
      if (summary.transitions?.length) void queryClient.invalidateQueries({ queryKey: HEALTH_KEY, exact: true });
    });
  }, [isSuperAdmin, queryClient]);
  return isSuperAdmin ? data : undefined;
}
