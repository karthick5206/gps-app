import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPinIcon, SearchIcon, XIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ADDRESS_SEARCH_DEFAULTS, addressSearchView, moveActive, roundHit, searchTerm, type AddressHit } from './address-search';

export { BOOKING_GEOCODE_ENDPOINT, ME_GEOCODE_ENDPOINT, type AddressHit } from './address-search';

export interface AddressSearchComboboxProps {
  /** Geocode route behind the API: BOOKING_GEOCODE_ENDPOINT (desk) or ME_GEOCODE_ENDPOINT (passenger). GET ?q= → AddressHit[]. */
  endpoint: string;
  /** A suggestion was chosen (click, Enter); lat / lng rounded to 6 decimals. */
  onPick: (hit: AddressHit) => void;
  /** Input id (for a Field htmlFor). */
  id?: string;
  placeholder?: string;
  /** Accessible name when there is no visible label. */
  ariaLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** Text under the list when nothing matches. */
  emptyText?: string;
  /** After a pick: 'label' (default) keeps the chosen address in the box, 'clear' empties it. */
  afterPick?: 'label' | 'clear';
  minChars?: number;
  debounceMs?: number;
  maxResults?: number;
  className?: string;
}

/**
 * Address type-ahead (r1151): suggestions appear ~350 ms after typing stops (3+ characters); a newer term cancels the
 * request still in flight; answers are cached per term for 5 minutes. ARIA 1.2 combobox: ArrowUp / ArrowDown move,
 * Enter picks the highlighted (or first) suggestion, Escape closes the list. The search runs through the API against
 * the self-hosted Photon only.
 */
export function AddressSearchCombobox({
  endpoint,
  onPick,
  id,
  placeholder,
  ariaLabel,
  disabled,
  invalid,
  emptyText,
  afterPick = 'label',
  minChars = ADDRESS_SEARCH_DEFAULTS.minChars,
  debounceMs = ADDRESS_SEARCH_DEFAULTS.debounceMs,
  maxResults = ADDRESS_SEARCH_DEFAULTS.maxResults,
  className,
}: AddressSearchComboboxProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const autoId = useId();
  const inputId = id ?? `addr-${autoId}`;
  const listId = `${inputId}-list`;
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const typed = searchTerm(text, minChars);
  const [settled, setSettled] = useState<string | null>(null);

  // Debounce: the term settles once typing pauses.
  useEffect(() => {
    if (typed === settled) return;
    const h = setTimeout(() => setSettled(typed), typed ? debounceMs : 0);
    return () => clearTimeout(h);
  }, [typed, settled, debounceMs]);

  // A new term cancels the previous request if it is still running (its AbortSignal reaches fetch).
  const prev = useRef<readonly unknown[] | null>(null);
  const key = ['address-search', endpoint, settled] as const;
  useEffect(() => {
    if (prev.current && prev.current[2] !== settled) void qc.cancelQueries({ queryKey: prev.current, exact: true });
    prev.current = key;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, settled]);

  const search = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.get<AddressHit[]>(endpoint, { q: settled ?? '' }, signal),
    enabled: !!settled && open && !disabled,
    staleTime: ADDRESS_SEARCH_DEFAULTS.staleMs,
    gcTime: 2 * ADDRESS_SEARCH_DEFAULTS.staleMs,
    retry: false,
  });
  const hits = (settled === typed ? (search.data ?? []) : []).slice(0, maxResults);
  const view = addressSearchView({ typed, settled, fetching: search.isFetching, error: search.error, hits: hits.length });
  const expanded = open && view !== 'idle';

  useEffect(() => setActive(-1), [settled]);

  const pick = (h: AddressHit) => {
    const r = roundHit(h);
    setText(afterPick === 'clear' ? '' : r.label);
    setOpen(false);
    setActive(-1);
    onPick(r);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => moveActive(i, hits.length, e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      // Never submits the surrounding form.
      e.preventDefault();
      if (hits.length) pick(hits[active >= 0 && active < hits.length ? active : 0]);
      else if (typed) {
        setOpen(true);
        setSettled(typed);
      }
    } else if (e.key === 'Escape' && expanded) {
      // Close the list only; the dialog around stays open.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setActive(-1);
    }
  };

  const optionId = (i: number) => `${listId}-${i}`;
  return (
    <div className={cn('relative z-20', className)}>
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        id={inputId}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={expanded && active >= 0 && active < hits.length ? optionId(active) : undefined}
        aria-invalid={invalid || undefined}
        value={text}
        disabled={disabled}
        placeholder={placeholder ?? t('Search an address…')}
        autoComplete="off"
        spellCheck={false}
        className="pr-9 pl-8"
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => text && setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {text && !disabled && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute top-1/2 right-1 -translate-y-1/2"
          aria-label={t('Clear search')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setText('');
            setOpen(false);
            document.getElementById(inputId)?.focus();
          }}
        >
          <XIcon />
        </Button>
      )}
      <div
        hidden={!expanded}
        className="absolute inset-x-0 top-full mt-1 max-h-72 overflow-y-auto rounded-lg border bg-popover text-popover-foreground shadow-lg"
        // Keep focus in the input while the list is clicked.
        onMouseDown={(e) => e.preventDefault()}
      >
        <div id={listId} role="listbox" aria-label={t('Address matches')}>
          {view === 'results' &&
            hits.map((h, i) => (
              <div
                key={`${h.lat},${h.lng},${i}`}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                className={cn('flex min-h-11 cursor-pointer items-start gap-2 px-3 py-2 text-left text-sm', i === active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60')}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(h)}
              >
                <MapPinIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 break-words">{h.label}</span>
              </div>
            ))}
        </div>
        {view === 'loading' && (
          <p className="flex items-center gap-2 px-3 py-2.5 text-sm text-muted-foreground">
            <Spinner /> {t('Searching…')}
          </p>
        )}
        {view === 'empty' && <p className="px-3 py-2.5 text-sm text-muted-foreground">{emptyText ?? t('No match found. Click the map to place the point instead.')}</p>}
        {view === 'rate-limited' && <p className="px-3 py-2.5 text-sm text-warning-fg">{t('Too many address searches. Wait a moment and try again.')}</p>}
        {view === 'error' && <p className="px-3 py-2.5 text-sm text-destructive">{errorMessage(search.error)}</p>}
      </div>
      <p className="sr-only" aria-live="polite">
        {!expanded ? '' : view === 'results' ? t('{{n}} address suggestions', { n: hits.length }) : view === 'empty' ? (emptyText ?? t('No match found. Click the map to place the point instead.')) : view === 'rate-limited' ? t('Too many address searches. Wait a moment and try again.') : ''}
      </p>
    </div>
  );
}
