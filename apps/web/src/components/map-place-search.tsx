import { useQuery } from '@tanstack/react-query';
import maplibregl, { type Map as MlMap } from 'maplibre-gl';
import { CrosshairIcon, MapPinIcon, SearchIcon, XIcon } from 'lucide-react';
import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api';
import { biasPoint, coordinateHit, placeSearchReady, withCoordinateHit, type PlaceHit } from '@/lib/place-search';
import { cn } from '@/lib/utils';

export type Place = PlaceHit;

/**
 * Address, place or coordinates box over a map: suggests places as you type (through the API's self-hosted geocoder,
 * `GET /geocode/search` with the map centre as bias point). Typed coordinates ("12.97, 77.59", "12.97N 77.59E", DMS)
 * show a "Coordinates" hit at once. Only reports the pick (null when cleared).
 */
export function PlaceSearch({ near, onPick, className }: { near: () => { lat: number; lng: number } | null; onPick: (place: Place | null) => void; className?: string }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const search = useDeferredValue(q.trim().replace(/\s+/g, ' '));
  const ready = placeSearchReady(search) && search !== picked;
  const places = useQuery({
    queryKey: ['geocode-search', 'map', search],
    queryFn: ({ signal }) => {
      const c = biasPoint(near());
      return api.get<Place[]>('/geocode/search', c ? { q: search, lat: c.lat, lng: c.lng } : { q: search }, signal);
    },
    enabled: ready,
    staleTime: 60_000,
    retry: false,
  });
  const results = ready ? withCoordinateHit(search, places.data) : [];

  const choose = (p: Place) => {
    setQ(p.label);
    setPicked(p.label);
    onPick(p);
  };
  const clear = () => {
    setQ('');
    setPicked(null);
    onPick(null);
  };

  return (
    <div className={cn('relative', className)}>
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        data-place-search
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          // Inside an editor's form: Enter picks the first suggestion instead of saving the form.
          if (e.key === 'Enter') {
            e.preventDefault();
            const first = results[0] ?? coordinateHit(q);
            if (first) choose(first);
          } else if (e.key === 'Escape') {
            clear();
          }
        }}
        placeholder={t('Search an address, place or coordinates')}
        aria-label={t('Search an address, place or coordinates')}
        autoComplete="off"
        spellCheck={false}
        className="bg-card pr-8 pl-8 shadow-sm"
      />
      {q && (
        <button type="button" onClick={clear} aria-label={t('Clear search')} className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted">
          <XIcon className="size-3.5" />
        </button>
      )}
      {focused && ready && (
        <div className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-popover text-sm shadow-lg">
          {results.length > 0 ? (
            <ul>
              {results.map((p) => (
                <li key={`${p.lat},${p.lng},${p.coordinates ? 'c' : ''}`}>
                  {/* Keeps the input focused, so the list is still there when the click lands. */}
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => choose(p)} className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left hover:bg-muted">
                    {p.coordinates ? <CrosshairIcon className="mt-0.5 size-3.5 shrink-0 text-primary" /> : <MapPinIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1 break-words">
                      {p.label}
                      {p.coordinates && <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground uppercase">{t('Coordinates')}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : places.isFetching ? (
            <div className="flex items-center gap-2 px-2.5 py-2 text-muted-foreground">
              <Spinner /> {t('Searching…')}
            </div>
          ) : (
            <p className="px-2.5 py-2 text-muted-foreground">{t('No places found')}</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * PlaceSearch bound to a MapLibre map: the pick flies the map there and drops a temporary pin (removed when the search
 * is cleared, on the next pick or when the box unmounts). The pin lets clicks through, so drawing and placing still work.
 */
export function MapPlaceSearch({ map, className, zoom = 15, onPick }: { map: MlMap | null; className?: string; zoom?: number; onPick?: (place: Place | null) => void }) {
  const pinRef = useRef<maplibregl.Marker | null>(null);
  useEffect(
    () => () => {
      pinRef.current?.remove();
      pinRef.current = null;
    },
    [map],
  );
  const show = (place: Place | null) => {
    pinRef.current?.remove();
    pinRef.current = null;
    onPick?.(place);
    if (!map || !place) return;
    const pin = new maplibregl.Marker({ color: '#dc2626' }).setLngLat([place.lng, place.lat]).addTo(map);
    pin.getElement().style.pointerEvents = 'none';
    pin.getElement().setAttribute('data-place-pin', '');
    pinRef.current = pin;
    map.flyTo({ center: [place.lng, place.lat], zoom: Math.max(map.getZoom(), zoom), duration: 600 });
  };
  return <PlaceSearch near={() => map?.getCenter() ?? null} onPick={show} className={className} />;
}
