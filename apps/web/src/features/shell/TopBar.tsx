import { MENUS } from '@veetracer/shared';
import { MenuIcon } from 'lucide-react';
import { useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { AlertBell } from '@/features/alerts/AlertBell';
import { useAuth, useMe } from '@/features/auth/auth-context';
import { useRealtimeStatus } from '@/features/live/use-live';
import type { RealtimeStatus } from '@/features/live/realtime';
import { cn } from '@/lib/utils';
import { CompanySwitcher } from './CompanySwitcher';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

const REALTIME_LABEL: Record<RealtimeStatus, string> = {
  idle: 'Realtime off',
  connecting: 'Connecting to live updates…',
  connected: 'Live updates connected',
  disconnected: 'Live updates disconnected — retrying',
};

function RealtimeIndicator() {
  const status = useRealtimeStatus();
  const { can } = useAuth();
  if (!can('live_map') && !can('dashboard')) return null;
  return (
    <Tooltip content={REALTIME_LABEL[status]}>
      <span className="flex size-9 items-center justify-center" role="status" aria-label={REALTIME_LABEL[status]}>
        <span
          className={cn(
            'size-2.5 rounded-full',
            status === 'connected' && 'bg-success shadow-[0_0_0_3px] shadow-success/20',
            status === 'connecting' && 'animate-pulse bg-warning',
            status === 'disconnected' && 'bg-destructive',
            status === 'idle' && 'bg-muted-foreground/40',
          )}
        />
      </span>
    </Tooltip>
  );
}

export function TopBar({ onOpenMobileNav }: { onOpenMobileNav: () => void }) {
  const me = useMe();
  const { can } = useAuth();
  const { pathname } = useLocation();
  // Most specific match wins (e.g. /reports/schedules over /reports).
  const current = MENUS.filter((m) => pathname === m.path || pathname.startsWith(`${m.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-card/80 px-3 backdrop-blur supports-[backdrop-filter]:bg-card/70 sm:px-4">
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onOpenMobileNav} aria-label="Open navigation">
        <MenuIcon />
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {me.user.isSuperAdmin ? (
          <CompanySwitcher />
        ) : (
          <span className="hidden truncate text-sm font-medium text-muted-foreground sm:block">{me.company.name}</span>
        )}
        {current && (
          <>
            <span className="hidden text-muted-foreground/50 md:block">/</span>
            <span className="hidden truncate text-sm font-medium md:block">{current.label}</span>
          </>
        )}
      </div>
      <RealtimeIndicator />
      {can('alerts') && <AlertBell />}
      <ThemeToggle />
      <UserMenu />
    </header>
  );
}
