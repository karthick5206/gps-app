import 'maplibre-gl/dist/maplibre-gl.css';
import { BRAND_FOOTER, LIVE_SHARE_POLL_SEC, OPENFREEMAP, STATUS_META, type PublicLiveShareDto } from '@veetracer/shared';
import maplibregl from 'maplibre-gl';
import { BatteryIcon, ZapIcon, ClockIcon, GaugeIcon, KeyRoundIcon, LocateFixedIcon, MapPinIcon, NavigationIcon, RouteIcon, SatelliteIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { Logo } from '@/components/logo';
import { formatDuration } from '@/lib/format';
import { statusColor } from '@/lib/status-tokens';

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dayClock = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

type Load = { kind: 'loading' } | { kind: 'ok'; data: PublicLiveShareDto } | { kind: 'error'; message: string; gone: boolean };

async function fetchShare(token: string, signal: AbortSignal): Promise<PublicLiveShareDto> {
  const res = await fetch(`/api/public/live-share/${encodeURIComponent(token)}`, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw Object.assign(new Error(body?.message ?? 'This link is not available.'), { status: res.status });
  }
  return res.json() as Promise<PublicLiveShareDto>;
}

function Stat({ icon: Icon, label, children }: { icon: ComponentType<{ className?: string }>; label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border bg-background/70 p-2">
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Icon className="size-3" /> {label}
      </div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums">{children}</div>
    </div>
  );
}

/** Marker: a coloured disc with a heading arrow (rotated by the course while moving). */
function markerElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = 'width:34px;height:34px;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;transition:background-color .3s';
  el.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M12 2l7 19-7-4-7 4z"/></svg>';
  return el;
}

/**
 * Public live location page behind a share link (/share/:token): no sign-in. Polls every few seconds and moves the
 * marker along the recent path; stops when the link expires or the sender stops sharing.
 */
export function PublicSharePage() {
  const { token = '' } = useParams();
  const { t } = useTranslation();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [now, setNow] = useState(Date.now());
  const [follow, setFollow] = useState(true);
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const marker = useRef<maplibregl.Marker | null>(null);
  const centred = useRef(false);

  // Poll the share.
  useEffect(() => {
    let stop = false;
    let ctrl = new AbortController();
    const tick = async () => {
      ctrl = new AbortController();
      try {
        const data = await fetchShare(token, ctrl.signal);
        if (!stop) setLoad({ kind: 'ok', data });
      } catch (e) {
        if (stop || (e as Error).name === 'AbortError') return;
        const status = (e as { status?: number }).status ?? 0;
        // Network hiccup: keep the last good view; a 404 / 410 ends the page.
        if (status === 404 || status === 410) {
          stop = true;
          setLoad({ kind: 'error', message: (e as Error).message, gone: true });
        } else setLoad((l) => (l.kind === 'ok' ? l : { kind: 'error', message: (e as Error).message, gone: false }));
      }
    };
    void tick();
    const timer = setInterval(() => !stop && void tick(), LIVE_SHARE_POLL_SEC * 1000);
    const clockTimer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stop = true;
      ctrl.abort();
      clearInterval(timer);
      clearInterval(clockTimer);
    };
  }, [token]);

  // Map.
  useEffect(() => {
    if (!mapEl.current || map.current) return;
    const m = new maplibregl.Map({ container: mapEl.current, style: OPENFREEMAP.standard, center: [78.9, 20.6], zoom: 4, attributionControl: { compact: true } });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    m.on('load', () => {
      m.addSource('trail', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'trail-casing', type: 'line', source: 'trail', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.9 } });
      m.addLayer({ id: 'trail', type: 'line', source: 'trail', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#2563eb', 'line-width': 4 } });
    });
    m.on('dragstart', () => setFollow(false));
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      marker.current = null;
    };
  }, []);

  // Marker, trail and camera on every update.
  const data = load.kind === 'ok' ? load.data : null;
  useEffect(() => {
    const m = map.current;
    if (!m || !data) return;
    const { lat, lng, course, status, speedKph } = data.live;
    const apply = () => {
      const src = m.getSource('trail') as maplibregl.GeoJSONSource | undefined;
      src?.setData({ type: 'FeatureCollection', features: data.trail.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: data.trail.map(([, la, ln]) => [ln, la]) } }] : [] });
      if (lat === null || lng === null) return;
      if (!marker.current) marker.current = new maplibregl.Marker({ element: markerElement(), rotationAlignment: 'map' }).setLngLat([lng, lat]).addTo(m);
      else marker.current.setLngLat([lng, lat]);
      const el = marker.current.getElement();
      el.style.backgroundColor = statusColor(status);
      marker.current.setRotation(speedKph > 2 ? course : 0);
      if (!centred.current) {
        m.jumpTo({ center: [lng, lat], zoom: 15 });
        centred.current = true;
      } else if (follow) m.easeTo({ center: [lng, lat], duration: 800 });
    };
    if (m.isStyleLoaded()) apply();
    else m.once('load', apply);
  }, [data, follow]);

  const expiresIn = data ? Math.max(0, (Date.parse(data.expiresAt) - now) / 1000) : 0;
  const lastSeen = data?.live.serverTime ? (now - Date.parse(data.live.serverTime)) / 1000 : null;

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-background">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <Logo className="h-7" />
        <span className="ms-auto flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
          <KeyRoundIcon className="size-3.5" />
          {data ? t('Link valid for {{time}}', { time: formatDuration(expiresIn) }) : t('Live location')}
        </span>
      </header>
      <div className="relative min-h-0 flex-1">
        {/* maplibre styles its container as position: relative, so it fills a positioned wrapper instead. */}
        <div className="absolute inset-0">
          <div ref={mapEl} className="h-full w-full" />
        </div>
        {data && !follow && (
          <button type="button" onClick={() => setFollow(true)} className="absolute right-3 bottom-3 flex items-center gap-1.5 rounded-full border bg-card px-3 py-2 text-sm font-medium shadow-lg">
            <LocateFixedIcon className="size-4" /> {t('Follow')}
          </button>
        )}
        {load.kind !== 'ok' && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80 p-6 text-center">
            {load.kind === 'loading' ? (
              <p className="text-sm text-muted-foreground">{t('Loading live location…')}</p>
            ) : (
              <div className="max-w-sm space-y-2">
                <p className="text-base font-semibold">{load.gone ? t('Live location not available') : t('Could not connect')}</p>
                <p className="text-sm text-muted-foreground">{load.message}</p>
              </div>
            )}
          </div>
        )}
      </div>
      {data && (
        <section className="space-y-2 border-t bg-card p-3 sm:p-4" aria-label={t('Details')}>
          <div className="flex items-start gap-3">
            <span className="mt-1 size-3 shrink-0 rounded-full" style={{ backgroundColor: statusColor(data.live.status) }} aria-hidden />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold">
                {data.name}
                {data.plateNumber && data.plateNumber !== data.name && <span className="ms-2 text-sm font-normal text-muted-foreground">{data.plateNumber}</span>}
              </h1>
              <p className="text-xs text-muted-foreground">
                {t(STATUS_META[data.live.status].label)}
                {data.live.statusSince && ` · ${t('for {{duration}}', { duration: formatDuration((now - Date.parse(data.live.statusSince)) / 1000) })}`}
                {lastSeen !== null && ` · ${t('updated {{time}}', { time: clock.format(Date.parse(data.live.serverTime!)) })}`}
              </p>
              {data.live.address && (
                <p className="mt-1 flex items-start gap-1 text-xs">
                  <MapPinIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground" /> {data.live.address}
                </p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6 [&>*]:min-w-0">
            <Stat icon={GaugeIcon} label={t('Speed')}>{`${data.live.speedKph} km/h`}</Stat>
            <Stat icon={NavigationIcon} label={t('Ignition')}>{data.live.ignition === null ? '—' : data.live.ignition ? t('On') : t('Off')}</Stat>
            <Stat icon={RouteIcon} label={t('Today')}>{data.todayKm === null ? '—' : `${data.todayKm.toFixed(1)} km`}</Stat>
            <Stat icon={ClockIcon} label={t('Last fix')}>{data.live.fixTime ? dayClock.format(Date.parse(data.live.fixTime)) : '—'}</Stat>
            <Stat icon={BatteryIcon} label={t('Battery')}>{data.live.batteryLevel === null ? '—' : `${Math.round(data.live.batteryLevel)}%`}
              {data.live.charging && <ZapIcon className="ms-1 inline size-3.5 text-emerald-600" aria-label={t('Charging')} />}</Stat>
            <Stat icon={SatelliteIcon} label={t('Satellites')}>{data.live.satellites ?? '—'}</Stat>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {[data.sharedByName && t('Shared by {{name}}', { name: data.sharedByName }), data.companyName, data.note].filter(Boolean).join(' · ')}
          </p>
          <p className="text-center text-[10px] text-muted-foreground">
            {t('VeeTrax is a product of and powered by {{owner}}', { owner: BRAND_FOOTER.owner })} · © {BRAND_FOOTER.year} {BRAND_FOOTER.owner}
          </p>
        </section>
      )}
    </div>
  );
}
