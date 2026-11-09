import type { ReportType } from '@veetracer/shared';
import { ChevronDownIcon, HistoryIcon, SearchIcon, StarIcon, XIcon } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { storage } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { cleanFavourites, cleanRecents, pushRecent, searchCatalog, toggleFavourite, type RecentReport } from './report-catalog';
import { REPORT_CATEGORIES, REPORT_DEF_MAP, REPORT_DEFS, type ReportTypeDef } from './report-columns';
import { periodLabel } from './report-format';

const FAV_KEY = 'vt.reports.favourites';
const RECENT_KEY = 'vt.reports.recents';
const KNOWN = REPORT_DEFS.map((d) => d.type as string);

/** Favourites and recent runs, per browser (localStorage). */
export function useCatalogPrefs() {
  const [favourites, setFavourites] = useState<string[]>(() => cleanFavourites(storage.getJson(FAV_KEY, []), KNOWN));
  const [recents, setRecents] = useState<RecentReport[]>(() => cleanRecents(storage.getJson(RECENT_KEY, []), KNOWN));
  const toggleFav = useCallback((type: string) => {
    setFavourites((list) => {
      const next = toggleFavourite(list, type);
      storage.setJson(FAV_KEY, next);
      return next;
    });
  }, []);
  const addRecent = useCallback((entry: RecentReport) => {
    setRecents((list) => {
      const next = pushRecent(list, entry);
      storage.setJson(RECENT_KEY, next);
      return next;
    });
  }, []);
  return { favourites, recents, toggleFav, addRecent };
}

interface CatalogProps {
  value: ReportType;
  onSelect: (type: ReportType, range?: [string, string]) => void;
  visible: (d: ReportTypeDef) => boolean;
  favourites: string[];
  recents: RecentReport[];
  onToggleFavourite: (type: string) => void;
}

function Item({ d, active, fav, showDescription, onSelect, onToggleFavourite, sub }: { d: ReportTypeDef; active: boolean; fav: boolean; showDescription: boolean; onSelect: () => void; onToggleFavourite: () => void; sub?: string }) {
  const { t } = useTranslation();
  const Icon = d.icon;
  return (
    <div className={cn('group relative flex items-start rounded-lg transition-colors hover:bg-muted', active && 'bg-accent text-accent-foreground hover:bg-accent')}>
      <button
        type="button"
        role="radio"
        aria-checked={active}
        onClick={onSelect}
        title={t(d.description)}
        className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg px-2 py-1.5 pr-8 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon className={cn('mt-0.5 size-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} />
        <span className="min-w-0">
          <span className={cn('block truncate', active && 'font-medium')}>{t(d.label)}</span>
          {sub && <span className="block truncate text-[11px] text-muted-foreground">{sub}</span>}
          {showDescription && <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug font-normal text-muted-foreground">{t(d.description)}</span>}
        </span>
      </button>
      <button
        type="button"
        onClick={onToggleFavourite}
        aria-pressed={fav}
        aria-label={fav ? t('Remove {{report}} from favourites', { report: t(d.label) }) : t('Add {{report}} to favourites', { report: t(d.label) })}
        className={cn(
          'absolute top-1 right-1 rounded-md p-1 text-muted-foreground transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
          fav ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-60',
        )}
      >
        <StarIcon className={cn('size-3.5', fav && 'fill-current text-[var(--warning)]')} />
      </button>
    </div>
  );
}

/** Searchable report list with favourites and recent runs (RP-1). Used in the desktop rail and the phone sheet. */
export function CatalogList({ value, onSelect, visible, favourites, recents, onToggleFavourite, autoFocus }: CatalogProps & { autoFocus?: boolean }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const defs = useMemo(() => REPORT_DEFS.filter(visible), [visible]);
  const results = useMemo(() => (query.trim() ? searchCatalog(defs, query, (s) => t(s)) : null), [defs, query, t]);
  const favDefs = favourites.map((f) => REPORT_DEF_MAP[f as ReportType]).filter((d) => d && visible(d));
  const recentDefs = recents.filter((r) => REPORT_DEF_MAP[r.type as ReportType] && visible(REPORT_DEF_MAP[r.type as ReportType]));
  const item = (d: ReportTypeDef, opts: { key?: string; sub?: string; range?: [string, string]; describe?: boolean } = {}) => (
    <Item
      key={opts.key ?? d.type}
      d={d}
      active={d.type === value}
      fav={favourites.includes(d.type)}
      showDescription={opts.describe ?? d.type === value}
      sub={opts.sub}
      onSelect={() => onSelect(d.type, opts.range)}
      onToggleFavourite={() => onToggleFavourite(d.type)}
    />
  );
  const heading = (text: string, icon?: ReactNode) => (
    <p className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
      {icon}
      {text}
    </p>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative border-b p-2">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-4.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('Search reports…')}
          aria-label={t('Search reports')}
          autoFocus={autoFocus}
          className="h-9 pr-8 pl-8"
        />
        {query && (
          <button type="button" onClick={() => setQuery('')} aria-label={t('Clear search')} className="absolute top-1/2 right-4 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground">
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>
      <nav role="radiogroup" aria-label={t('Report type')} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-2">
        {results ? (
          results.length ? (
            <div className="space-y-0.5">
              {heading(t('{{n}} matching reports', { n: results.length }))}
              {results.map((d) => item(d, { describe: true, sub: t(d.category) }))}
            </div>
          ) : (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">{t('No report matches “{{q}}”.', { q: query })}</p>
          )
        ) : (
          <>
            {favDefs.length > 0 && (
              <div className="space-y-0.5">
                {heading(t('Favourites'), <StarIcon className="size-3" />)}
                {favDefs.map((d) => item(d, { key: `fav-${d.type}` }))}
              </div>
            )}
            {recentDefs.length > 0 && (
              <div className="space-y-0.5">
                {heading(t('Recent'), <HistoryIcon className="size-3" />)}
                {recentDefs.map((r) =>
                  item(REPORT_DEF_MAP[r.type as ReportType], {
                    key: `recent-${r.type}`,
                    sub: r.from === r.to ? periodLabel(r.from) : `${periodLabel(r.from)} – ${periodLabel(r.to)}`,
                    range: [r.from, r.to],
                    describe: false,
                  }),
                )}
              </div>
            )}
            {REPORT_CATEGORIES.map((category) => {
              const list = defs.filter((d) => d.category === category);
              if (!list.length) return null;
              const closed = collapsed[category] && !list.some((d) => d.type === value);
              return (
                <div key={category} className="space-y-0.5">
                  <button
                    type="button"
                    onClick={() => setCollapsed((c) => ({ ...c, [category]: !c[category] }))}
                    aria-expanded={!closed}
                    className="flex w-full items-center justify-between rounded px-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
                  >
                    {t(category)}
                    <ChevronDownIcon className={cn('size-3.5 transition-transform', closed && '-rotate-90')} />
                  </button>
                  {!closed && list.map((d) => item(d))}
                </div>
              );
            })}
          </>
        )}
      </nav>
    </div>
  );
}

/** Phone / tablet picker: the current report as a button that opens the searchable list in a full-height sheet. */
export function CatalogSheetButton(props: CatalogProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const current = REPORT_DEF_MAP[props.value];
  const Icon = current.icon;
  return (
    <>
      <button
        type="button"
        data-testid="report-picker-open"
        onClick={() => setOpen(true)}
        className="flex h-10 w-full min-w-0 items-center gap-2 rounded-lg border bg-card px-3 text-left text-sm shadow-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:w-64"
        aria-haspopup="dialog"
      >
        <Icon className="size-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-muted-foreground">{t(current.category)} · </span>
          {t(current.label)}
        </span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="sm:max-w-sm">
          <SheetHeader>
            <SheetTitle>{t('Choose a report')}</SheetTitle>
            <SheetDescription>{t('Search by name or topic, e.g. “speed”, “fuel theft”, “insurance”.')}</SheetDescription>
          </SheetHeader>
          <CatalogList
            {...props}
            onSelect={(type, range) => {
              props.onSelect(type, range);
              setOpen(false);
            }}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
