import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ALERT_TYPES,
  DEFAULT_CHANNELS,
  type AlertLevel,
  type AlertSettingDto,
  type AlertSeverity,
  type AlertTypeCode,
  type AlertTypeDef,
  type EffectiveAlertSetting,
  type NotifyChannel,
  type RecipientEntry,
  type RecipientListDto,
  type RecipientMode,
} from '@veetracer/shared';
import { toast } from 'sonner';
import { api, errorMessage, request } from '@/lib/api';
import type { Defaults } from './inheritance';

export interface AlertTypeWithSupport extends AlertTypeDef {
  supportedBy: { count: number; total: number };
}

/** `/alert-settings/conflicts` row (mirrors the API's GroupConflict). */
export interface GroupConflict {
  alertType: AlertTypeCode;
  field: string;
  winner: { groupId: string; groupName: string; priority: number; value: unknown };
  others: { groupId: string; groupName: string; priority: number; value: unknown }[];
  overriddenByObject: boolean;
}

export interface ResolvedRecipient {
  address: string;
  kind: RecipientEntry['kind'];
  label: string;
  userId: string | null;
}

export interface ResolvedChannel {
  channel: NotifyChannel;
  mode: RecipientMode;
  decidedBy: { level: AlertLevel; targetId: string; alertType: string; severity: string } | null;
  entries: RecipientEntry[];
  recipients: ResolvedRecipient[];
  enabled: boolean;
}

export interface ResolvedRecipientsResponse {
  objectId: string;
  alertType: AlertTypeCode;
  severity: AlertSeverity;
  channels: ResolvedChannel[];
}

/**
 * Catalogue default cooldowns (minutes). Mirrors the API's DEFAULT_COOLDOWN_MIN, which is not in the shared package;
 * only used to label "Default" values on Company/Branch/Group screens (object level uses the API's effective values).
 */
export const DEFAULT_COOLDOWN_MIN: Record<AlertTypeCode, number> = {
  OVERSPEED: 0,
  IDLING: 0,
  IGNITION_ON: 0,
  IGNITION_OFF: 0,
  GEOFENCE_ENTER: 0,
  GEOFENCE_EXIT: 0,
  GEOFENCE_STAY: 0,
  GEOFENCE_OVERSPEED: 5,
  POWER_CUT: 5,
  SOS: 1,
  LOW_BATTERY: 60,
  DEVICE_OFFLINE: 0,
};

export function catalogueDefaults(def: AlertTypeDef): Defaults {
  return {
    enabled: def.defaultEnabled,
    severity: def.defaultSeverity,
    cooldownMin: DEFAULT_COOLDOWN_MIN[def.code] ?? 0,
    params: Object.fromEntries(def.params.map((p) => [p.key, p.default])),
    channels: { ...DEFAULT_CHANNELS },
  };
}

export const SENDABLE_CHANNELS: NotifyChannel[] = ['EMAIL', 'SMS', 'WHATSAPP', 'PUSH'];
export const CHANNEL_LABEL: Record<NotifyChannel, string> = { INAPP: 'In-app', EMAIL: 'Email', SMS: 'SMS', WHATSAPP: 'WhatsApp', PUSH: 'Push' };
export const LEVEL_NAME: Record<AlertLevel, string> = { COMPANY: 'Company', BRANCH: 'Branch', GROUP: 'Vehicle group', OBJECT: 'Vehicle' };

export const settingsKey = (level: AlertLevel, targetId: string) => ['alert-settings', 'rows', level, targetId] as const;

export function useAlertTypes() {
  return useQuery({
    queryKey: ['alert-types'],
    queryFn: ({ signal }) => api.get<AlertTypeWithSupport[]>('/alert-types', undefined, signal),
    staleTime: 5 * 60_000,
    placeholderData: ALERT_TYPES.map((t) => ({ ...t, supportedBy: { count: 0, total: 0 } })),
  });
}

export function useSettingRows(level: AlertLevel, targetId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: settingsKey(level, targetId ?? ''),
    queryFn: ({ signal }) => api.get<AlertSettingDto[]>('/alert-settings', { level, targetId }, signal),
    enabled: enabled && !!targetId,
  });
}

export function useEffective(objectId: string | null | undefined) {
  return useQuery({
    queryKey: ['alert-settings', 'effective', objectId],
    queryFn: ({ signal }) => api.get<EffectiveAlertSetting[]>('/alert-settings/effective', { objectId }, signal),
    enabled: !!objectId,
  });
}

export function useConflicts(objectId: string | null | undefined) {
  return useQuery({
    queryKey: ['alert-settings', 'conflicts', objectId],
    queryFn: ({ signal }) => api.get<GroupConflict[]>('/alert-settings/conflicts', { objectId }, signal),
    enabled: !!objectId,
  });
}

export function useRecipientLists(level: AlertLevel, targetId: string | null | undefined) {
  return useQuery({
    queryKey: ['alert-settings', 'recipients', level, targetId],
    queryFn: ({ signal }) => api.get<RecipientListDto[]>('/recipient-lists', { level, targetId }, signal),
    enabled: !!targetId,
  });
}

export interface SettingPatch {
  enabled?: boolean | null;
  params?: Record<string, unknown> | null;
  schedule?: unknown;
  cooldownMin?: number | null;
  severity?: AlertSeverity | null;
  channels?: Partial<Record<AlertSeverity, NotifyChannel[] | null>> | null;
}

/**
 * Field-level upsert: the API keeps absent fields, treats null as "inherit", and merges `params`/`channels` per key
 * (a key set to null is removed). Invalidates every settings view so inherited values refresh.
 */
export function usePutSetting(level: AlertLevel, targetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ alertType, patch }: { alertType: AlertTypeCode; patch: SettingPatch }) =>
      request<{ setting: AlertSettingDto | null }>('/alert-settings', { method: 'PUT', body: { level, targetId, alertType, ...patch } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alert-settings'] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function usePutRecipientList(level: AlertLevel, targetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { alertType: AlertTypeCode | '*'; severity: AlertSeverity | '*'; channel: NotifyChannel; mode: RecipientMode; entries: RecipientEntry[] }) =>
      request<RecipientListDto>('/recipient-lists', { method: 'PUT', body: { level, targetId, ...body } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alert-settings'] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function useDeleteRecipientList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<unknown>(`/recipient-lists/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alert-settings'] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
}
