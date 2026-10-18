import { BRAND_PIN_PATH, BRAND_PIN_TRANSFORM, BRAND_ROUTE_DOTS } from '@veetracer/shared';
import { cn } from '@/lib/utils';

/**
 * Veetrax mark (dotted trip line ending in a map pin) on a rounded tile. Colours come from the theme tokens
 * --brand / --brand-accent, so the logo follows the selected theme.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden className={cn('size-8', className)}>
      <rect width="64" height="64" rx="15" style={{ fill: 'var(--brand)' }} />
      <g transform="translate(5 6) scale(0.84)">
        <circle cx="10" cy="54" r="5" style={{ fill: 'var(--brand-accent)' }} />
        {BRAND_ROUTE_DOTS.map(([cx, cy]) => (
          <circle key={cx} cx={cx} cy={cy} r="2.4" style={{ fill: 'var(--brand-accent)' }} />
        ))}
        <path transform={BRAND_PIN_TRANSFORM} d={BRAND_PIN_PATH} fill="#ffffff" fillRule="evenodd" />
      </g>
    </svg>
  );
}

/** Lower-case wordmark, as in the logo files (brand/logo). */
export function Wordmark({ className }: { className?: string }) {
  return <span className={cn('font-extrabold tracking-tight', className)}>veetrax</span>;
}

export function Logo({ className, textClassName }: { className?: string; textClassName?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      <Wordmark className={cn('text-lg', textClassName)} />
    </span>
  );
}
