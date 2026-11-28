import { useQuery } from '@tanstack/react-query';
import { BATTERY_STATUS_META, batteryReasons, type BatteryHealthReportRow, type IdleCostReportRow, type LiveObject, type ReportResponse } from '@veetracer/shared';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/features/auth/auth-context';
import { api } from '@/lib/api';

const VARIANT = { ok: 'success', warn: 'warning', bad: 'destructive', muted: 'muted' } as const;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Battery verdict over the last 14 days and today's idle cost for one vehicle (the same API as the reports). */
export function useVehicleHealth(o: LiveObject) {
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
  const q = new URLSearchParams({ type: 'BATTERY_HEALTH', from: ymd(new Date(Date.now() - 13 * 86_400_000)), to: today, vehicle: o.objectId, vehicleName: o.name, run: '1' });
  return { enabled, battery: battery.data?.rows[0], idle: idle.data?.rows[0], batteryLink: `/reports?${q}` };
}

/** "Vehicle battery" and "Idle cost today" rows for the live map vehicle panel. */
export function VehicleHealthRows({ o, Row }: { o: LiveObject; Row: (p: { label: string; children: React.ReactNode }) => React.ReactNode }) {
  const { t } = useTranslation();
  const { enabled, battery, idle, batteryLink } = useVehicleHealth(o);
  if (!enabled) return null;
  const meta = battery ? BATTERY_STATUS_META[battery.status] : null;
  return (
    <>
      {battery && meta && battery.status !== 'NO_DATA' && (
        <Row label={t('Vehicle battery')}>
          <span className="flex flex-col items-end gap-1" title={batteryReasons(battery, (k, v) => t(k, v)).join('\n')}>
            <Link to={batteryLink}>
              <Badge variant={VARIANT[meta.tone]}>{t(meta.label)}</Badge>
            </Link>
            <span className="text-xs font-normal text-muted-foreground">
              {[battery.restV !== null && t('resting {{v}} V', { v: battery.restV.toFixed(1) }), battery.chargeV !== null && t('charging {{v}} V', { v: battery.chargeV.toFixed(1) })].filter(Boolean).join(' · ')}
            </span>
          </span>
        </Row>
      )}
      {idle && idle.idleSec > 0 && (
        <Row label={t('Idle cost today')}>
          <span className="flex flex-col items-end">
            {`₹${idle.rupees.toLocaleString('en-IN')}`}
            <span className="text-xs font-normal text-muted-foreground">{t('{{l}} L fuel at ₹{{p}} / L', { l: idle.litres.toFixed(1), p: Math.round(idle.pricePerL) })}</span>
          </span>
        </Row>
      )}
    </>
  );
}
