import 'maplibre-gl/dist/maplibre-gl.css';
import { MOVEMENT_STATUSES, type BranchDto, type LiveObject, type MovementStatus, type VehicleGroupDto } from '@veetracer/shared';
import { ListIcon, MapIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/auth/auth-context';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { themeStore } from '@/features/theme/theme-store';
import { prefersReducedMotion, useReducedMotion } from '@/hooks/use-reduced-motion';
import { errorMessage } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { EMPTY_FILTERS, baseMatcher, fullMatcher, parseStatusParam, type LiveFilters } from './filters';
import { liveStore } from './live-store';
import { LivePanel } from './LivePanel';
import { MapController } from './map/map-controller';
import { LiveMapOverlays } from './map/layers/LiveMapOverlays';
import { ObjectDrawer } from './ObjectDrawer';
import { useLiveVersion, useNow } from './use-live';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function useMapController(containerRef: RefObject<HTMLDivElement | null>, onSelect: (id: string) => void, onFollowInterrupted: () => void) {
  const [controller, setController] = useState<MapController | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const callbacks = useRef({ onSelect, onFollowInterrupted });
  callbacks.current = { onSelect, onFollowInterrupted };
  const reducedMotion = useReducedMotion();

  // Created exactly once per mount; React state changes are pushed in through methods below.
  useEffect(() => {
    if (!containerRef.current) return;
    let c: MapController;
    try {
      c = new MapController({
        container: containerRef.current,
        theme: themeStore.getResolved(),
        reducedMotion: prefersReducedMotion(),
        onSelect: (id) => callbacks.current.onSelect(id),
        onFollowInterrupted: () => callbacks.current.onFollowInterrupted(),
      });
    } catch {
      // MapLibre throws when WebGL is unavailable (disabled GPU, old browser); keep the list usable.
      setUnsupported(true);
      return;
    }
    const unsubscribeTheme = themeStore.subscribe(() => c.setTheme(themeStore.getResolved()));
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(containerRef.current);
    setController(c);
    return () => {
      ro.disconnect();
      unsubscribeTheme();
      c.destroy();
      setController(null);
    };
  }, [containerRef]);

  useEffect(() => controller?.setReducedMotion(reducedMotion), [controller, reducedMotion]);
  return { controller, unsupported };
}

export function LiveMapPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [params] = useSearchParams();
  const containerRef = useRef<HTMLDivElement>(null);
  const [filters, setFilters] = useState<LiveFilters>(() => ({ ...EMPTY_FILTERS, statuses: parseStatusParam(params.get('status')) }));
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [following, setFollowing] = useState(false);
  const [mobileView, setMobileView] = useState<'map' | 'list'>('map');
  const [loading, setLoading] = useState(!liveStore.snapshotLoaded);

  const version = useLiveVersion(1000);
  useNow(15_000); // periodic re-render so relative times advance without live updates
  const now = Date.now();

  const pick = useCallback((id: string) => {
    setActiveId(id);
    setFollowing(false);
    setMobileView('map');
  }, []);
  const { controller, unsupported } = useMapController(containerRef, pick, () => setFollowing(false));

  useEffect(() => {
    liveStore
      .loadSnapshot()
      .catch((err) => toast.error(i18n.t('Could not load live data: {{error}}', { error: errorMessage(err) })))
      .finally(() => setLoading(false));
  }, []);

  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: can('branches') });
  const groups = useEntityOptions<VehicleGroupDto>('/vehicle-groups', named, { enabled: can('vehicle_groups') });
  const groupMembers = useMemo(() => new Map(groups.rows.map((g) => [g.id, new Set(g.objects.map((o) => o.id))])), [groups.rows]);

  // Map filter updates immediately (not throttled with the list).
  useEffect(() => {
    controller?.setPredicate(fullMatcher(filters, { groupMembers, selected }));
  }, [controller, filters, groupMembers, selected]);
  useEffect(() => controller?.setSelected(activeId), [controller, activeId]);
  useEffect(() => controller?.follow(following ? activeId : null), [controller, following, activeId]);

  const { items, counts } = useMemo(() => {
    void version; // recompute when the (throttled) live version changes
    const base = baseMatcher(filters, { groupMembers, selected });
    const statusSet = filters.statuses.length ? new Set<MovementStatus>(filters.statuses) : null;
    const c = Object.fromEntries(MOVEMENT_STATUSES.map((s) => [s, 0])) as Record<MovementStatus, number>;
    let total = 0;
    const list: LiveObject[] = [];
    for (const o of liveStore.all()) {
      if (!base(o)) continue;
      c[o.status]++;
      total++;
      if (!statusSet || statusSet.has(o.status)) list.push(o);
    }
    list.sort((a, b) => collator.compare(a.name, b.name));
    return { items: list, counts: { ...c, total } };
  }, [version, filters, groupMembers, selected]);

  const active = activeId ? liveStore.get(activeId) : undefined;

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const patchFilters = useCallback((patch: Partial<LiveFilters>) => setFilters((f) => ({ ...f, ...patch })), []);

  return (
    <div className="relative h-full min-h-[420px] overflow-hidden">
      {/* MapLibre forces `position: relative` on its container, so size it with h-full rather than inset. */}
      <div ref={containerRef} className="h-full w-full" role="region" aria-label={t('Live map')} />
      {unsupported && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted p-6 text-center md:pl-[23rem]">
          <p className="max-w-sm text-sm text-muted-foreground">
            {t(
              "The map can't be shown because WebGL is turned off or not supported in this browser. Enable hardware acceleration or use a recent version of Chrome, Edge, Firefox or Safari. The vehicle list still works.",
            )}
          </p>
        </div>
      )}

      <LivePanel
        className={cn(
          'absolute inset-x-2 top-14 bottom-2 z-10 md:inset-auto md:top-3 md:bottom-3 md:left-3 md:flex md:w-[22rem]',
          mobileView === 'list' ? 'flex' : 'hidden',
        )}
        loading={loading}
        items={items}
        counts={counts}
        filters={filters}
        onFiltersChange={patchFilters}
        selected={selected}
        onToggleSelected={toggleSelected}
        onClearSelected={() => {
          setSelected(new Set());
          patchFilters({ selectedOnly: false });
        }}
        activeId={activeId}
        onPick={pick}
        branchOptions={can('branches') ? branches.options : null}
        groupOptions={can('vehicle_groups') ? groups.options : null}
        now={now}
      />

      {active && (
        <ObjectDrawer
          key={active.objectId}
          className="absolute inset-x-2 bottom-2 z-20 max-h-[60%] md:inset-x-auto md:top-3 md:right-3 md:bottom-3 md:max-h-none md:w-[22rem]"
          object={active}
          now={now}
          following={following}
          onFollowChange={setFollowing}
          onZoomTo={() => controller?.zoomTo(active.objectId)}
          onClose={() => {
            setActiveId(null);
            setFollowing(false);
          }}
        />
      )}

      {!unsupported && <LiveMapOverlays controller={controller} onFocusObject={pick} className="absolute top-3 right-3 z-10" />}

      <Button
        variant="outline"
        className="absolute top-3 left-1/2 z-30 -translate-x-1/2 shadow-md md:hidden"
        onClick={() => setMobileView((v) => (v === 'map' ? 'list' : 'map'))}
      >
        {mobileView === 'map' ? <ListIcon /> : <MapIcon />}
        {mobileView === 'map' ? t('List ({{count}})', { count: items.length }) : t('Map')}
      </Button>
    </div>
  );
}
