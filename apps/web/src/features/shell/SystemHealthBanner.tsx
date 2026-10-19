import type { SystemHealthSummary } from '@veetracer/shared';
import { ActivityIcon, ArrowRightIcon } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '@/features/auth/auth-context';
import { realtime } from '@/features/live/realtime';
import { useSystemHealthStatus } from '@/features/platform/system-health/use-system-health';

const PAGE = '/platform/system-health';

/** Toasts for system status changes (Super Admin): new WARN/CRITICAL issues and recoveries. */
function useHealthToasts(enabled: boolean) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  useEffect(() => {
    if (!enabled) return;
    return realtime.on<[SystemHealthSummary]>('system:health', (s) => {
      const changes = s.transitions ?? [];
      if (!changes.length) return;
      const raised = changes.filter((c) => c.to !== 'OK');
      const action = { label: t('View'), onClick: () => navigate(PAGE) };
      if (raised.length) {
        const critical = raised.some((c) => c.to === 'CRITICAL');
        const title = raised.length === 1 ? raised[0].message : t('{{count}} system issue(s)', { count: raised.length });
        (critical ? toast.error : toast.warning)(t('System health'), { id: 'system-health', description: title, duration: 10_000, action });
      } else {
        toast.success(t('System health'), { id: 'system-health', description: t('{{count}} issue(s) resolved', { count: changes.length }), duration: 6000, action });
      }
    });
  }, [enabled, navigate, t]);
}

/** Red bar under the top bar while the system is CRITICAL (Super Admin only). */
export function SystemHealthBanner() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const { pathname } = useLocation();
  const summary = useSystemHealthStatus();
  useHealthToasts(!!me?.user.isSuperAdmin);
  if (!summary || summary.status !== 'CRITICAL') return null;
  const critical = summary.issues.filter((i) => i.severity === 'CRITICAL');
  return (
    <div role="alert" className="flex items-center gap-2 border-b border-destructive/30 bg-destructive px-3 py-1.5 text-sm text-destructive-foreground sm:px-4">
      <ActivityIcon className="size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 truncate">
        <span className="font-semibold">{t('System critical')}</span>
        <span className="mx-1.5 opacity-70">·</span>
        {critical.length === 1 ? critical[0].message : t('{{count}} critical issue(s)', { count: critical.length })}
      </p>
      {pathname !== PAGE && (
        <Link to={PAGE} className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none">
          {t('Details')} <ArrowRightIcon className="size-3.5" />
        </Link>
      )}
    </div>
  );
}
