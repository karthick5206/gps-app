import { useQuery } from '@tanstack/react-query';
import { MapPinIcon, SearchIcon, XIcon } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface Place {
  label: string;
  lat: number;
  lng: number;
}

/** Address box over the geofence map: suggests places as you type. Only reports the pick; it never changes the shape. */
export function PlaceSearch({ near, onPick, className }: { near: () => { lat: number; lng: number } | null; onPick: (place: Place | null) => void; className?: string }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const search = useDeferredValue(q.trim());
  const ready = search.length >= 3 && search !== picked;
  const places = useQuery({
    queryKey: ['geocode-search', 'geofence', search],
    queryFn: ({ signal }) => {
      const c = near();
      return api.get<Place[]>('/geocode/search', c ? { q: search, lat: c.lat, lng: c.lng } : { q: search }, signal);
    },
    enabled: ready,
    staleTime: 60_000,
  });
  const results = ready ? (places.data ?? []) : [];

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
          // Inside the editor's form: Enter picks the first suggestion instead of saving the geofence.
          if (e.key === 'Enter') {
            e.preventDefault();
            if (results[0]) choose(results[0]);
          } else if (e.key === 'Escape') {
            clear();
          }
        }}
        placeholder={t('Search an address or place')}
        aria-label={t('Search an address or place')}
        autoComplete="off"
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
                <li key={`${p.lat},${p.lng}`}>
                  {/* Keeps the input focused, so the list is still there when the click lands. */}
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => choose(p)} className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left hover:bg-muted">
                    <MapPinIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <span>{p.label}</span>
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
