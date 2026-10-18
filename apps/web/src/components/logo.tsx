import { cn } from '@/lib/utils';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn('size-8', className)}>
      <rect width="32" height="32" rx="8" className="fill-navy" />
      <path d="M9 9l7 15 7-15" fill="none" className="stroke-sidebar-primary" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ className, textClassName }: { className?: string; textClassName?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      <span className={cn('text-lg font-semibold tracking-tight', textClassName)}>
        Vee<span className="text-primary">Tracer</span>
      </span>
    </span>
  );
}
