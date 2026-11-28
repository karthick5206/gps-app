import { useQuery } from '@tanstack/react-query';
import { BATTERY_STATUS_META, type BatteryHealthReportRow, type IdleCostReportRow, type LiveObject, type ReportResponse } from '@veetracer/shared';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { InfoRow, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { api } from '@/lib/api';
import { useColors } from '@/lib/theme';

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * "Vehicle battery" (verdict over the last 14 days from the tracker voltage) and "Idle cost today" (₹ of fuel burnt
 * idling) for one vehicle, from the BATTERY_HEALTH / IDLE_COST reports. Hidden without the Reports permission.
 */
export function VehicleHealthRows({ o }: { o: LiveObject }) {
  const { t } = useTranslation();
  const c = useColors();
  const { can } = useAuth();
  const enabled = can('reports') && o.type === 'VEHICLE' && !o.shared && !o.licenceLocked;
  const today = ymd(new Date());
  const scope = { branchIds: [], groupIds: [], objectIds: [o.objectId] };
  const battery = useQuery({
    queryKey: ['vehicle-health', 'battery', o.objectId, today],
    queryFn: () => api.post<ReportResponse<BatteryHealthReportRow>>('/reports/run', { type: 'BATTERY_HEALTH', scope, from: ymd(new Date(Date.now() - 13 * 86_400_000)), to: today }),
    enabled,
    staleTime: 30 * 60_000,
    retry: false,
  });
  const idle = useQuery({
    queryKey: ['vehicle-health', 'idle', o.objectId, today],
    queryFn: () => api.post<ReportResponse<IdleCostReportRow>>('/reports/run', { type: 'IDLE_COST', scope, from: today, to: today, period: 'DAY' }),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
  if (!enabled) return null;
  const b = battery.data?.rows[0];
  const i = idle.data?.rows[0];
  const meta = b ? BATTERY_STATUS_META[b.status] : null;
  const tone = meta?.tone === 'ok' ? c.success : meta?.tone === 'warn' ? c.warning : meta?.tone === 'bad' ? c.destructive : c.mutedForeground;
  return (
    <>
      {b && meta && b.status !== 'NO_DATA' && (
        <InfoRow
          label={t('Vehicle battery')}
          value={
            <View style={{ alignItems: 'flex-end', flexShrink: 1 }}>
              <Text size="sm" weight="700" style={{ color: tone }}>
                {t(meta.label)}
              </Text>
              <Text size="xs" tone="muted" style={{ textAlign: 'right' }}>
                {[b.restV !== null && t('resting {{v}} V', { v: b.restV.toFixed(1) }), b.chargeV !== null && t('charging {{v}} V', { v: b.chargeV.toFixed(1) })].filter(Boolean).join(' · ')}
              </Text>
              {b.status !== 'GOOD' && (
                <Text size="xs" tone="muted" style={{ textAlign: 'right' }}>
                  {t(meta.advice)}
                </Text>
              )}
            </View>
          }
        />
      )}
      {i && i.idleSec > 0 && (
        <InfoRow
          label={t('Idle cost today')}
          value={`₹${i.rupees.toLocaleString('en-IN')} · ${t('{{l}} L fuel at ₹{{p}} / L', { l: i.litres.toFixed(1), p: Math.round(i.pricePerL) })}`}
        />
      )}
    </>
  );
}
