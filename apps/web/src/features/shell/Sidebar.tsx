import { PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router';
import { LogoMark, Wordmark } from '@/components/logo';
import { Tooltip } from '@/components/ui/tooltip';
import { useMe } from '@/features/auth/auth-context';
import { cn } from '@/lib/utils';
import { buildNav, MENU_ICONS } from './nav';

/**
 * Left menu (Enterprise layout): a light panel under the app header. Every menu the user may view, in the shared
 * MENUS groups and order; the current page gets the accent tint and the brand-accent (saffron) marker.
 * `showBrand` repeats the logo at the top — used in the phone drawer, which covers the header.
 */
export function Sidebar({
  collapsed = false,
  onToggleCollapsed,
  onNavigate,
  showBrand = false,
  className,
}: {
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onNavigate?: () => void;
  showBrand?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const me = useMe();
  const personal = me.company.accountType !== 'BUSINESS';
  const reseller = !!me.partner;
  const groups = useMemo(() => buildNav(me.permissions, personal, reseller), [me.permissions, personal, reseller]);

  return (
    <nav aria-label={t('Main navigation')} className={cn('flex h-full flex-col border-e bg-card text-foreground', className)}>
      {showBrand && (
        <div className="app-header flex h-14 shrink-0 items-center gap-2.5 px-4">
          <LogoMark className="size-8" />
          <Wordmark className="text-[18px] text-sidebar-accent-foreground" />
        </div>
      )}

      <div className={cn('flex-1 space-y-4 overflow-y-auto py-4', collapsed ? 'px-2' : 'px-3')}>
        {groups.map((g) => (
          <div key={g.group} className="space-y-0.5">
            {collapsed ? (
              <div className="mx-auto my-2 h-px w-6 bg-border first:hidden" />
            ) : (
              <p className="px-3 pb-1 text-[11px] font-bold tracking-wider text-muted-foreground uppercase">{t(g.label)}</p>
            )}
            {g.items.map((item) => {
              const Icon = MENU_ICONS[item.key];
              const link = (
                <NavLink
                  key={item.key}
                  to={item.path}
                  end
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    cn(
                      'group relative flex h-9 items-center gap-3 rounded-md px-3 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                      collapsed && 'justify-center px-0',
                      isActive
                        ? 'bg-accent font-semibold text-accent-foreground shadow-[inset_3px_0_0_var(--brand-accent)]'
                        : 'font-medium text-muted-foreground hover:bg-muted hover:text-foreground',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <Icon className={cn('size-[18px] shrink-0', isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')} />
                      {!collapsed && <span className="truncate">{t(item.label)}</span>}
                      {collapsed && <span className="sr-only">{t(item.label)}</span>}
                    </>
                  )}
                </NavLink>
              );
              return collapsed ? (
                <Tooltip key={item.key} content={t(item.label)} side="right">
                  {link}
                </Tooltip>
              ) : (
                link
              );
            })}
          </div>
        ))}
      </div>

      {onToggleCollapsed && (
        <div className="border-t p-3">
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? t('Expand sidebar') : t('Collapse sidebar')}
            className={cn(
              'flex h-9 w-full items-center gap-3 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none',
              collapsed && 'justify-center px-0',
            )}
          >
            {collapsed ? <PanelLeftOpenIcon className="size-[18px]" /> : <PanelLeftCloseIcon className="size-[18px]" />}
            {!collapsed && t('Collapse')}
          </button>
        </div>
      )}
    </nav>
  );
}
