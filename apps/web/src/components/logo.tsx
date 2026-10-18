import { cn } from '@/lib/utils';

/** Trip dots along the brand curve (scripts/brand/generate.mjs). */
const ROUTE_DOTS = [
  [20.06, 52.72],
  [27.5, 49.75],
  [34.19, 46.41],
  [42, 44],
];
const PIN = 'M32 5C20.4 5 11 14.2 11 25.6 11 40.5 32 59 32 59s21-18.5 21-33.4C53 14.2 43.6 5 32 5z M24 25.6a8 8 0 1 0 16 0a8 8 0 1 0-16 0z';

/** Veetrax mark (dotted trip line ending in a map pin) on a rounded tile in the theme's brand colours. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden className={cn('size-8', className)}>
      <rect width="64" height="64" rx="15" style={{ fill: 'var(--brand)' }} />
      <g transform="translate(5 6) scale(0.84)">
        <circle cx="10" cy="54" r="5" style={{ fill: 'var(--brand-accent)' }} />
        {ROUTE_DOTS.map(([cx, cy]) => (
          <circle key={cx} cx={cx} cy={cy} r="2.4" style={{ fill: 'var(--brand-accent)' }} />
        ))}
        <path transform="translate(24 0) scale(0.72)" d={PIN} fill="#ffffff" fillRule="evenodd" />
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
