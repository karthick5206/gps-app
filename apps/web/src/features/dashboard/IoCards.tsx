import type { DashboardIoSummary } from '@veetracer/shared';
import { DoorOpenIcon, SnowflakeIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/features/auth/auth-context';
import { formatDuration } from '@/lib/format';
import { BarList } from './charts';

const hours = (sec: number) => `${(sec / 3600).toLocaleString(undefined, { maximumFractionDigits: 1 })} h`;

function Tile({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: string; icon: ReactNode }) {
  return (
    <Card className="h-full p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        {icon}
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

/** Columns: AC running hours per day for the last 7 days. */
function DayColumns({ days }: { days: DashboardIoSummary['acByDay'] }) {
  const { t, i18n } = useTranslation();
  const max = Math.max(1, ...days.map((d) => d.onSec));
  return (
    <ol className="flex h-44 items-end gap-2" aria-label={t('AC hours per day')}>
      {days.map((d, i) => {
        const date = new Date(`${d.day}T00:00:00Z`);
        const label = date.toLocaleDateString(i18n.language, { weekday: 'short', timeZone: 'UTC' });
        return (
          <li key={d.day} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${d.day}: ${formatDuration(d.onSec)}`}>
            <span className="text-[11px] text-muted-foreground tabular-nums">{d.onSec ? hours(d.onSec) : ''}</span>
            <span
              className="w-full max-w-10 rounded-t-md bg-primary transition-[height]"
              style={{ height: `${Math.max(d.onSec ? 4 : 1, (d.onSec / max) * 100)}%`, opacity: i === days.length - 1 ? 1 : 0.7 }}
            />
            <span className="text-xs text-muted-foreground">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Dashboard: AC / door sensors (only when a vehicle has one set up in Devices → Advanced settings). */
export function IoCards({ io }: { io: DashboardIoSummary }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const icon = (I: typeof SnowflakeIcon) => <I className="size-4 text-muted-foreground" />;
  return (
    <section aria-labelledby="io-sensors" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="io-sensors" className="text-sm font-semibold text-muted-foreground">
          {t('AC / Door')}
        </h2>
        {can('reports') && (
          <Link to="/reports" className="text-xs font-medium text-primary hover:underline">
            {t('AC / Door reports')}
          </Link>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {io.acVehicles > 0 && (
          <>
            <Tile label={t('AC on now')} value={`${io.acOnNow} / ${io.acVehicles}`} hint={t('Vehicles with an AC sensor')} icon={icon(SnowflakeIcon)} />
            <Tile label={t('AC hours today')} value={hours(io.acOnTodaySec)} hint={t('Since midnight')} icon={icon(SnowflakeIcon)} />
          </>
        )}
        {io.doorVehicles > 0 && (
          <>
            <Tile label={t('Door open now')} value={`${io.doorOpenNow} / ${io.doorVehicles}`} hint={t('Vehicles with a door sensor')} icon={icon(DoorOpenIcon)} />
            <Tile label={t('Door openings today')} value={io.doorOpeningsToday.toLocaleString()} hint={t('Since midnight')} icon={icon(DoorOpenIcon)} />
          </>
        )}
      </div>
      {io.acVehicles > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="space-y-3 p-4">
            <h3 className="text-sm font-semibold">{t('AC usage, last 7 days')}</h3>
            <DayColumns days={io.acByDay} />
          </Card>
          <Card className="space-y-3 p-4">
            <h3 className="text-sm font-semibold">{t('AC hours today by vehicle')}</h3>
            <BarList
              items={io.acByVehicle.map((v) => ({ key: v.objectId, label: v.name, sub: v.plateNumber, value: v.onSec }))}
              format={(v) => formatDuration(v)}
              empty={t('No AC use today.')}
              color="var(--primary)"
            />
          </Card>
        </div>
      )}
    </section>
  );
}
