import { PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react';
import { useMemo } from 'react';
import { NavLink } from 'react-router';
import { LogoMark } from '@/components/logo';
import { Tooltip } from '@/components/ui/tooltip';
import { useMe } from '@/features/auth/auth-context';
import { cn } from '@/lib/utils';
import { buildNav, MENU_ICONS } from './nav';

export function Sidebar({
  collapsed = false,
  onToggleCollapsed,
  onNavigate,
  className,
}: {
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onNavigate?: () => void;
  className?: string;
}) {
  const me = useMe();
  const groups = useMemo(() => buildNav(me.permissions), [me.permissions]);

  return (
    <nav aria-label="Main navigation" className={cn('flex h-full flex-col bg-sidebar text-sidebar-foreground', className)}>
      <div className={cn('flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border px-4', collapsed && 'justify-center px-0')}>
        <LogoMark className="size-7" />
        {!collapsed && (
          <span className="text-[15px] font-semibold tracking-tight text-sidebar-accent-foreground">
            Vee<span className="text-sidebar-primary">Tracer</span>
          </span>
        )}
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
        {groups.map((g) => (
          <div key={g.group} className="space-y-1">
            {collapsed ? (
              <div className="mx-auto my-2 h-px w-6 bg-sidebar-border first:hidden" />
            ) : (
              <p className="px-2 pb-1 text-[11px] font-semibold tracking-wider text-sidebar-muted uppercase">{g.label}</p>
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
                      'group relative flex h-9 items-center gap-3 rounded-lg px-2.5 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sidebar-primary/60',
                      collapsed && 'justify-center px-0',
                      isActive
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive && <span className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-sidebar-primary" />}
                      <Icon className={cn('size-[18px] shrink-0', isActive ? 'text-sidebar-primary' : 'text-sidebar-muted group-hover:text-sidebar-accent-foreground')} />
                      {!collapsed && <span className="truncate">{item.label}</span>}
                      {collapsed && <span className="sr-only">{item.label}</span>}
                    </>
                  )}
                </NavLink>
              );
              return collapsed ? (
                <Tooltip key={item.key} content={item.label} side="right">
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
        <div className="border-t border-sidebar-border p-3">
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={cn(
              'flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-sm text-sidebar-muted transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-primary/60 focus-visible:outline-none',
              collapsed && 'justify-center px-0',
            )}
          >
            {collapsed ? <PanelLeftOpenIcon className="size-[18px]" /> : <PanelLeftCloseIcon className="size-[18px]" />}
            {!collapsed && 'Collapse'}
          </button>
        </div>
      )}
    </nav>
  );
}
