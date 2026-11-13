import { MapPinIcon, SearchIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ADDRESS_SEARCH, addressQuery, nextActive } from './address-search';

export interface AddressHit {
  label: string;
  lat: number;
  lng: number;
}

/**
 * Address search that suggests as you type (v1.15.1 owner request): debounced ~350 ms, at least 3 characters, the
 * previous request is aborted when the text changes, results in a listbox with arrow keys / Enter / Escape. No Search
 * button. `search` goes through the VeeTrax server only (self-hosted Photon). Prop interface kept identical to the
 * desk's AddressSearchCombobox so the Lead can unify them at merge: `{ value, onPick, search }`.
 */
export function MyAddressSearch({
  value,
  onPick,
  search,
  id,
  label,
  placeholder,
}: {
  /** The text shown in the box (e.g. the picked address); the box keeps its own text while typing. */
  value: string;
  onPick: (hit: AddressHit) => void;
  search: (q: string, signal: AbortSignal) => Promise<AddressHit[]>;
  id?: string;
  /** Accessible name (already translated); defaults to "Search an address". */
  label?: string;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const autoId = useId();
  const inputId = id ?? `${autoId}-input`;
  const listId = `${autoId}-list`;
  const [text, setText] = useState(value);
  const [hits, setHits] = useState<AddressHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const typed = useRef(false);
  const searchRef = useRef(search);
  searchRef.current = search;

  useEffect(() => {
    typed.current = false;
    setText(value);
  }, [value]);

  useEffect(() => {
    const q = addressQuery(text);
    if (!typed.current || q === null) {
      setHits([]);
      setState('idle');
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      setState('loading');
      searchRef.current(q, ctrl.signal).then(
        (rows) => {
          if (ctrl.signal.aborted) return;
          setHits(rows.slice(0, ADDRESS_SEARCH.maxHits));
          setActive(rows.length ? 0 : -1);
          setState('done');
          setOpen(true);
        },
        (err: unknown) => {
          if (ctrl.signal.aborted) return;
          setHits([]);
          setError(errorMessage(err));
          setState('error');
          setOpen(true);
        },
      );
    }, ADDRESS_SEARCH.debounceMs);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [text]);

  const pick = (h: AddressHit) => {
    typed.current = false;
    setText(h.label);
    setOpen(false);
    setHits([]);
    onPick({ label: h.label, lat: Number(h.lat.toFixed(6)), lng: Number(h.lng.toFixed(6)) });
  };

  const showList = open && (state === 'done' || state === 'error');
  return (
    <div className="relative">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <input
        id={inputId}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
        aria-label={label ?? t('Search an address')}
        autoComplete="off"
        value={text}
        placeholder={placeholder ?? t('Type an address (at least 3 letters)…')}
        onChange={(e) => {
          typed.current = true;
          setText(e.target.value);
        }}
        onFocus={() => hits.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
            setActive((i) => nextActive(e.key as 'ArrowDown' | 'ArrowUp', i, hits.length));
          } else if (e.key === 'Enter') {
            // Enter never submits the request form from here.
            e.preventDefault();
            if (showList && active >= 0 && hits[active]) pick(hits[active]);
          } else if (e.key === 'Escape' && showList) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent py-1 pr-8 pl-8 text-base shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm"
      />
      {state === 'loading' && <Spinner className="absolute top-1/2 right-2.5 -translate-y-1/2" />}
      <div aria-live="polite" className="sr-only">
        {state === 'done' ? t('{{n}} address matches', { n: hits.length }) : ''}
      </div>
      {showList && (
        <ul id={listId} role="listbox" aria-label={t('Address matches')} className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border bg-popover text-popover-foreground shadow-md">
          {state === 'error' ? (
            <li className="px-3 py-2 text-sm text-destructive">{error}</li>
          ) : hits.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted-foreground">{t('No match found. Click the map to place the point instead.')}</li>
          ) : (
            hits.map((h, i) => (
              <li
                key={`${h.lat},${h.lng},${i}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(h)}
                onMouseEnter={() => setActive(i)}
                className={cn('flex min-h-11 cursor-pointer items-start gap-2 px-3 py-2 text-sm', i === active && 'bg-accent')}
              >
                <MapPinIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 break-words">{h.label}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
