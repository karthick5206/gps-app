import './popup.css';
import { useQuery } from '@tanstack/react-query';
import type { AlertDto, Paginated } from '@veetracer/shared';
import { BellIcon, HexagonIcon, LayersIcon, MapPinIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { alertCenter } from '@/features/alerts/alert-center';
import { useAuth } from '@/features/auth/auth-context';
import { useAllGeofences } from '@/features/geofences/api';
import { useAllPois, usePoiCategoryOptions } from '@/features/pois/api';
import { api } from '@/lib/api';
import { storage } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { liveStore } from '../../live-store';
import type { MapController } from '../map-controller';
import { AlertLayer } from './alert-layer';
import { GeofenceLayer } from './geofence-layer';
import { PoiLayer } from './poi-layer';

const PREF_KEY = 'vt.live.layers';
const ALERT_WINDOW_MS = 24 * 3600_000;

interface LayerPrefs {
  geofences: boolean;
  alerts: boolean;
  /** Off by default: a company can have thousands of POIs. */
  pois: boolean;
}

function readPrefs(): LayerPrefs {
  return { geofences: true, alerts: true, pois: false, ...storage.getJson<Partial<LayerPrefs>>(PREF_KEY, {}) };
}

function ToggleRow({ icon: Icon, label, hint, checked, onChange }: { icon: typeof HexagonIcon; label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent/60">
      <Icon className="size-4 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}

/**
 * Live-map add-ons: geofence and alert-marker layers with a "Layers" toggle, plus deep links
 * (`?focus=<objectId>` selects and zooms to a vehicle, `?geofence=<id>` frames a geofence, `?poi=<id>` centres on a POI).
 */
export function LiveMapOverlays({ controller, onFocusObject, className }: { controller: MapController | null; onFocusObject: (objectId: string) => void; className?: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [prefs, setPrefs] = useState<LayerPrefs>(readPrefs);
  const showGeofences = can('geofences') && prefs.geofences;
  const showAlerts = can('alerts') && prefs.alerts;
  const showPois = can('pois') && prefs.pois;
  const geofenceLayer = useRef<GeofenceLayer | null>(null);
  const alertLayer = useRef<AlertLayer | null>(null);
  const poiLayer = useRef<PoiLayer | null>(null);
  const [ready, setReady] = useState(0);
  const focusParam = params.get('focus');
  const geofenceParam = params.get('geofence');
  const poiParam = params.get('poi');
  const poiCategories = usePoiCategoryOptions();

  const update = (patch: Partial<LayerPrefs>) =>
    setPrefs((p) => {
      const next = { ...p, ...patch };
      storage.setJson(PREF_KEY, next);
      return next;
    });

  // Layers live as long as the map controller.
  useEffect(() => {
    if (!controller) return;
    const map = controller.mapInstance;
    const g = can('geofences') ? new GeofenceLayer(map) : null;
    const p = can('pois') ? new PoiLayer(map) : null;
    const a = can('alerts') ? new AlertLayer(map, { onOpen: (x) => navigate(`/alerts?alertId=${encodeURIComponent(x.id)}`) }) : null;
    geofenceLayer.current = g;
    alertLayer.current = a;
    poiLayer.current = p;
    setReady((n) => n + 1);
    const offAlert = alertCenter.onAlert((x) => alertLayer.current?.upsert(x));
    const offChange = alertCenter.onChange((x) => alertLayer.current?.upsert(x));
    return () => {
      offAlert();
      offChange();
      g?.destroy();
      a?.destroy();
      p?.destroy();
      geofenceLayer.current = alertLayer.current = null;
      poiLayer.current = null;
    };
  }, [controller, can, navigate]);

  const geofences = useAllGeofences(can('geofences') && (showGeofences || !!geofenceParam));
  const pois = useAllPois(can('pois') && (showPois || !!poiParam));
  const recentAlerts = useQuery({
    queryKey: ['alerts', 'map-recent'],
    queryFn: ({ signal }) =>
      api.get<Paginated<AlertDto>>('/alerts', { from: new Date(Date.now() - ALERT_WINDOW_MS).toISOString(), page: 1, pageSize: 200, sort: 'occurredAt', order: 'desc' }, signal),
    enabled: showAlerts,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (geofences.data) geofenceLayer.current?.setGeofences(geofences.data);
  }, [geofences.data, ready]);
  useEffect(() => {
    if (pois.data) poiLayer.current?.setPois(pois.data);
  }, [pois.data, ready]);
  useEffect(() => poiLayer.current?.setCategoryLabel(poiCategories.labelOf), [poiCategories, ready]);
  useEffect(() => poiLayer.current?.setVisible(showPois || !!poiParam), [showPois, poiParam, ready]);
  useEffect(() => {
    if (recentAlerts.data) alertLayer.current?.setAlerts(recentAlerts.data.items);
  }, [recentAlerts.data, ready]);
  useEffect(() => geofenceLayer.current?.setVisible(showGeofences || !!geofenceParam), [showGeofences, geofenceParam, ready]);
  useEffect(() => alertLayer.current?.setVisible(showAlerts), [showAlerts, ready]);

  // ?geofence=<id> → frame it once the data is in.
  useEffect(() => {
    if (!geofenceParam || !geofences.data || !geofenceLayer.current) return;
    if (geofenceLayer.current.focus(geofenceParam) && !prefs.geofences) update({ geofences: true });
  }, [geofenceParam, geofences.data, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // ?poi=<id> → centre on it once the data is in (and keep the layer on).
  useEffect(() => {
    if (!poiParam || !pois.data || !poiLayer.current) return;
    if (poiLayer.current.focus(poiParam) && !prefs.pois) update({ pois: true });
  }, [poiParam, pois.data, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // ?focus=<objectId> → select + zoom once the live snapshot has the object, then drop the param.
  const focusRef = useRef(onFocusObject);
  focusRef.current = onFocusObject;
  useEffect(() => {
    if (!focusParam || !controller) return;
    const apply = () => {
      if (!liveStore.get(focusParam)) return false;
      focusRef.current(focusParam);
      controller.zoomTo(focusParam);
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          next.delete('focus');
          next.delete('alert');
          return next;
        },
        { replace: true },
      );
      return true;
    };
    if (apply()) return;
    return liveStore.subscribe(() => {
      apply();
    });
  }, [focusParam, controller, setParams]);

  if (!can('geofences') && !can('alerts') && !can('pois')) return null;
  const activeCount = Number(showGeofences) + Number(showAlerts) + Number(showPois);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn('gap-1.5 bg-card shadow-md', className)} aria-label={t('Map layers')}>
          <LayersIcon /> <span className="hidden sm:inline">{t('Layers')}</span>
          {activeCount > 0 && <span className="rounded bg-primary/12 px-1 text-[11px] font-semibold text-primary tabular-nums">{activeCount}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1.5">
        {can('geofences') && <ToggleRow icon={HexagonIcon} label={t('Geofences')} hint={t('Zones with name labels')} checked={prefs.geofences} onChange={(v) => update({ geofences: v })} />}
        {can('pois') && <ToggleRow icon={MapPinIcon} label={t('Points of interest')} hint={t('Pins with names when zoomed in')} checked={prefs.pois} onChange={(v) => update({ pois: v })} />}
        {can('alerts') && <ToggleRow icon={BellIcon} label={t('Alert markers')} hint={t('Alerts of the last 24 hours')} checked={prefs.alerts} onChange={(v) => update({ alerts: v })} />}
      </PopoverContent>
    </Popover>
  );
}
