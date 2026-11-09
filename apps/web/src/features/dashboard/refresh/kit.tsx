/**
 * Dashboard building blocks for the uiRefresh design (flag ON only). Presentation only: every value comes from
 * props that the existing dashboard queries already provide.
 */
import type { MovementStatus } from '@veetracer/shared';
import {
  CircleDashedIcon,
  CirclePauseIcon,
  GaugeIcon,
  InfoIcon,
  NavigationIcon,
  PowerOffIcon,
  WifiOffIcon,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { CountUp } from '../CountUp';

/** Shape cue per status so status is never told by colour alone. */
export const STATUS_ICON: Record<MovementStatus, LucideIcon> = {
  RUNNING: NavigationIcon,
  IDLE: CirclePauseIcon,
  OFF: PowerOffIcon,
  OVERSPEED: GaugeIcon,
  OFFLINE: WifiOffIcon,
  NO_DATA: CircleDashedIcon,
};

/** Tinted background from any colour token (works in every theme, light and dark). */
export const tint = (color: string, pct = 14) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

/** Small "i" button that explains a metric; opens on hover and on keyboard focus. */
export function InfoTip({ text, label, className }: { text: string; label: string; className?: string }) {
  return (
    <Tooltip content={<span className="block max-w-64 leading-relaxed">{text}</span>}>
      <button
        type="button"
        aria-label={label}
        className={cn('relative z-10 -m-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none', className)}
      >
        <InfoIcon className="size-4" aria-hidden />
      </button>
    </Tooltip>
  );
}

/** Card surface with an optional heading row; the base of every dashboard widget in the refreshed design. */
export function Panel({
  title,
  subtitle,
  action,
  children,
  className,
  id,
  as: As = 'section',
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  as?: 'section' | 'div';
}) {
  return (
    <As aria-labelledby={title && id ? id : undefined} className={cn('flex min-w-0 flex-col rounded-xl border bg-card text-card-foreground shadow-xs', className)}>
      {(title || action) && (
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-4 pt-4 sm:px-5">
          <div className="min-w-0">
            {title && (
              <h2 id={id} className="text-[15px] leading-6 font-semibold tracking-tight">
                {title}
              </h2>
            )}
            {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </div>
      )}
      <div className="min-w-0 flex-1 px-4 pt-3 pb-4 sm:px-5">{children}</div>
    </As>
  );
}

/** Empty state for a widget: icon + one sentence. */
export function EmptyHint({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-6 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" aria-hidden />
      </span>
      <p className="max-w-64 text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

/**
 * KPI card: icon chip, label, big tabular numeral (+ unit), sub-line and a definition tooltip. When `to` is set the
 * whole card is a link (stretched overlay), the info button stays separately focusable above it.
 */
export function KpiCard({
  label,
  value,
  unit,
  decimals = 0,
  sub,
  subTone,
  icon: Icon,
  definition,
  to,
  extra,
}: {
  label: string;
  value: number | undefined;
  unit?: string;
  decimals?: number;
  sub?: ReactNode;
  subTone?: 'destructive' | 'muted';
  icon: LucideIcon;
  definition: string;
  to?: string;
  extra?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'group relative flex h-full min-w-0 flex-col rounded-xl border bg-card p-3.5 text-card-foreground shadow-xs sm:p-4',
        'motion-safe:transition-[box-shadow,border-color,translate] motion-safe:duration-200',
        to && 'hover:border-primary/40 hover:shadow-md motion-safe:hover:-translate-y-px',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent text-primary sm:size-8" aria-hidden>
          <Icon className="size-4" />
        </span>
        <p className="min-w-0 flex-1 text-[13px] leading-tight font-medium text-muted-foreground">{label}</p>
        <InfoTip text={definition} label={t('About {{metric}}', { metric: label })} />
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        {value === undefined ? (
          <Skeleton className="mt-1 h-8 w-20" />
        ) : (
          <p className="text-2xl leading-tight font-semibold tracking-tight tabular-nums sm:text-[28px]">
            {decimals ? value.toLocaleString(undefined, { maximumFractionDigits: decimals }) : <CountUp value={value} />}
            {unit && <span className="ml-1 text-sm font-medium text-muted-foreground">{unit}</span>}
          </p>
        )}
        {extra}
      </div>
      {sub !== undefined && (
        <p className={cn('mt-0.5 min-h-4 text-xs leading-snug',subTone === 'destructive' ? 'font-medium text-[var(--destructive-fg)]' : 'text-muted-foreground')}>{sub}</p>
      )}
      {to && (
        <Link
          to={to}
          className="absolute inset-0 rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={`${label}: ${value === undefined ? t('loading') : value.toLocaleString()}`}
        />
      )}
    </div>
  );
}
