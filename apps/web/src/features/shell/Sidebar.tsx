import type { MenuGroup } from '@veetracer/shared';
import { ChevronDownIcon, ChevronsDownUpIcon, ChevronsUpDownIcon, PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, useLocation } from 'react-router';
import { LogoMark, Wordmark } from '@/components/logo';
import { Tooltip } from '@/components/ui/tooltip';
import { useMe } from '@/features/auth/auth-context';
import { cn } from '@/lib/utils';
import { buildNav, MENU_ICONS } from './nav';
import { usePlannerMenuHidden } from '@/features/transport/planning/planner-client';

/** Which menu groups are open; per browser (only a convenience). */
const OPEN_GROUPS_KEY = 'vt.nav.openGroups';

function readOpenGroups(): Partial<Record<MenuGroup, boolean>> | null {
  try {
    const raw = localStorage.getItem(OPEN_GROUPS_KEY);
    return raw ? (JSON.parse(raw) as Partial<Record<MenuGroup, boolean>>) : null;
  } catch {
    return null;
  }
}

function saveOpenGroups(v: Partial<Record<MenuGroup, boolean>>): void {
  try {
    localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify(v));
  } catch {
    // private window / storage blocked: the menu still works, it just forgets
  }
}

/**
 * Left menu (Enterprise layout): a light panel under the app header. Every menu the user may view, in the shared
 * MENUS groups and order; the current page gets the accent tint and the brand-accent (saffron) marker.
 * Each group heading opens / closes its menus (remembered per browser; first time only Tracking and the current page's
 * group are open, so the list fits without scrolling); the group of the current page always opens.
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
  // E4 route planner: hidden unless the web flag is on and the API reports routing enabled.
  const plannerHidden = usePlannerMenuHidden();
  // Daily transport (Dispatch) holds Routing / Allocate vehicles, so the separate Route planning menu stays hidden (the page still opens by its address).
  void plannerHidden;
  const groups = useMemo(() => buildNav(me.permissions, personal, reseller, new Set(['etms_planning'] as const)), [me.permissions, personal, reseller]);
  const { pathname } = useLocation();
  const activeGroup = groups.find((g) => g.items.some((m) => pathname === m.path || pathname.startsWith(`${m.path}/`)))?.group;
  const [open, setOpen] = useState<Partial<Record<MenuGroup, boolean>>>(() => readOpenGroups() ?? { main: true });
  // Opening a page (from a link, alert or search) opens its group.
  useEffect(() => {
    if (activeGroup && !open[activeGroup]) {
      const next = { ...open, [activeGroup]: true };
      setOpen(next);
      saveOpenGroups(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the page's group changes
  }, [activeGroup]);
  const setGroups = (next: Partial<Record<MenuGroup, boolean>>) => {
    setOpen(next);
    saveOpenGroups(next);
  };
  const toggle = (g: MenuGroup) => setGroups({ ...open, [g]: !open[g] });
  const allOpen = groups.every((g) => open[g.group]);

  return (
    <nav aria-label={t('Main navigation')} className={cn('flex h-full flex-col border-e bg-card text-foreground', className)}>
      {showBrand && (
        <div className="app-header flex h-14 shrink-0 items-center gap-2.5 px-4">
          <LogoMark className="size-8" />
          <Wordmark className="text-[18px] text-sidebar-accent-foreground" />
        </div>
      )}

      <div className={cn('flex-1 overflow-y-auto py-3', collapsed ? 'space-y-4 px-2' : 'space-y-1 px-3')}>
        {!collapsed && groups.length > 1 && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setGroups(Object.fromEntries(groups.map((g) => [g.group, !allOpen])))}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {allOpen ? <ChevronsDownUpIcon className="size-3.5" /> : <ChevronsUpDownIcon className="size-3.5" />}
              {allOpen ? t('Collapse all') : t('Expand all')}
            </button>
          </div>
        )}
        {groups.map((g) => {
          const isOpen = collapsed || !!open[g.group];
          const groupHasActive = g.group === activeGroup;
          return (
            <div key={g.group} className="space-y-0.5">
              {collapsed ? (
                <div className="mx-auto my-2 h-px w-6 bg-border first:hidden" />
              ) : (
                <button
                  type="button"
                  onClick={() => toggle(g.group)}
                  aria-expanded={isOpen}
                  aria-controls={`nav-group-${g.group}`}
                  className={cn(
                    'flex h-8 w-full items-center gap-2 rounded-md px-3 text-[11px] font-bold tracking-wider uppercase transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                    groupHasActive && !isOpen ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-start">{t(g.label)}</span>
                  {!isOpen && <span className="rounded bg-muted px-1.5 text-[10px] font-semibold tracking-normal">{g.items.length}</span>}
                  <ChevronDownIcon className={cn('size-3.5 shrink-0 transition-transform', !isOpen && '-rotate-90')} aria-hidden />
                </button>
              )}
              {isOpen && (
                <div id={`nav-group-${g.group}`} className="space-y-0.5 pb-1">
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
                            'group relative flex h-9 items-center gap-3 rounded-md px-3 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
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
              )}
            </div>
          );
        })}
      </div>

      {onToggleCollapsed && (
        <div className="border-t p-3">
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? t('Expand sidebar') : t('Collapse sidebar')}
            className={cn(
              'flex h-9 w-full items-center gap-3 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
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
