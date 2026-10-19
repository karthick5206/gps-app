import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useLocation } from 'react-router';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useAuth } from '@/features/auth/auth-context';
import { realtime } from '@/features/live/realtime';
import { storage, STORAGE_KEYS } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { Sidebar } from './Sidebar';
import { SystemHealthBanner } from './SystemHealthBanner';
import { TopBar } from './TopBar';

/** Keeps one Socket.IO connection per selected company while the user is in the app. */
function useRealtimeConnection() {
  const { companyId, can } = useAuth();
  const enabled = can('live_map') || can('dashboard') || can('alerts');
  useEffect(() => {
    if (!enabled) return;
    realtime.start(companyId);
    return () => realtime.release();
  }, [enabled, companyId]);
}

export function AppShell() {
  const [collapsed, setCollapsed] = useState(() => storage.get(STORAGE_KEYS.sidebarCollapsed) === '1');
  const [mobileOpen, setMobileOpen] = useState(false);
  const { pathname } = useLocation();
  const { t } = useTranslation();
  useRealtimeConnection();

  useEffect(() => setMobileOpen(false), [pathname]);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      storage.set(STORAGE_KEYS.sidebarCollapsed, c ? '0' : '1');
      return !c;
    });
  };

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className={cn('hidden shrink-0 transition-[width] duration-200 lg:block', collapsed ? 'w-16' : 'w-60')}>
        <Sidebar collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
      </aside>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 border-sidebar-border bg-sidebar p-0" aria-describedby={undefined}>
          <SheetTitle className="sr-only">{t('Navigation')}</SheetTitle>
          <Sidebar onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenMobileNav={() => setMobileOpen(true)} />
        <SystemHealthBanner />
        <main id="main" className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
