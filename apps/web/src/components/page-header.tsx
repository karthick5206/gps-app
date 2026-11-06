import { MENUS } from '@veetracer/shared';
import { ChevronRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { GROUP_LABELS } from '@/features/shell/nav';
import { cn } from '@/lib/utils';

/** The menu a path belongs to: the longest menu path that is the path itself or a parent of it. */
function menuFor(pathname: string) {
  let best: (typeof MENUS)[number] | undefined;
  for (const m of MENUS) {
    if ((pathname === m.path || pathname.startsWith(`${m.path}/`)) && (!best || m.path.length > best.path.length)) best = m;
  }
  return best;
}

/**
 * Breadcrumb from the menu definitions: "Group / Menu", plus the page title when it is a page inside that menu
 * (e.g. Masters › Vehicles › TN 38 AB 1234). The menu crumb links back when we are deeper than it.
 */
export function Breadcrumb({ title, className }: { title?: string; className?: string }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const menu = menuFor(pathname);
  if (!menu) return null;
  const deeper = pathname !== menu.path;
  const menuLabel = t(menu.label);
  const crumbs: { label: string; to?: string }[] = [{ label: t(GROUP_LABELS[menu.group]) }, { label: menuLabel, to: deeper ? menu.path : undefined }];
  if (deeper && title && title !== menuLabel) crumbs.push({ label: title });
  return (
    <nav aria-label={t('Breadcrumb')} className={cn('flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground', className)}>
      {crumbs.map((c, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1">
          {i > 0 && <ChevronRightIcon aria-hidden className="size-3 shrink-0 opacity-70" />}
          {c.to ? (
            <Link to={c.to} className="truncate hover:text-foreground hover:underline">
              {c.label}
            </Link>
          ) : (
            <span className="truncate" aria-current={i === crumbs.length - 1 ? 'page' : undefined}>
              {c.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function PageHeader({ title, description, actions, className, breadcrumb = true }: { title: string; description?: ReactNode; actions?: ReactNode; className?: string; breadcrumb?: boolean }) {
  return (
    <div className={cn('flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="min-w-0 space-y-1">
        {breadcrumb && <Breadcrumb title={title} />}
        <h1 className="text-xl font-bold tracking-tight sm:text-[26px] sm:leading-8">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
