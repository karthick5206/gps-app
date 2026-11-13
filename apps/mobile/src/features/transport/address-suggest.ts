/**
 * Address suggestions as you type (R1151, owner request): pure controller, `node --test`. Waits `debounceMs` after the
 * last keystroke, asks only from `minChars` characters, aborts the previous request when a new one starts (and drops a
 * late answer to an old query), and reports LOADING / DONE / EMPTY / RATE_LIMITED / ERROR. The server allows 60
 * searches a minute per user; a 429 shows "too many requests" until the next keystroke.
 */

export const ADDRESS_SUGGEST = { debounceMs: 350, minChars: 3, maxItems: 6 } as const;

export type SuggestStatus = 'IDLE' | 'SHORT' | 'WAITING' | 'LOADING' | 'DONE' | 'EMPTY' | 'RATE_LIMITED' | 'ERROR';

export interface SuggestState<T> {
  status: SuggestStatus;
  /** The trimmed query the state belongs to. */
  query: string;
  items: T[];
  error: unknown;
}

export interface SuggestTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

export interface SuggestOptions<T> {
  search: (q: string, signal: AbortSignal) => Promise<T[]>;
  onChange: (s: SuggestState<T>) => void;
  debounceMs?: number;
  minChars?: number;
  maxItems?: number;
  timers?: SuggestTimers;
}

export const IDLE_SUGGEST: SuggestState<never> = { status: 'IDLE', query: '', items: [], error: null };

/** HTTP status of an error thrown by the fetcher (ApiError has `status`), else null. */
function statusOf(err: unknown): number | null {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : null;
}

function isAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}

export function createAddressSuggest<T>(o: SuggestOptions<T>) {
  const debounceMs = o.debounceMs ?? ADDRESS_SUGGEST.debounceMs;
  const minChars = o.minChars ?? ADDRESS_SUGGEST.minChars;
  const maxItems = o.maxItems ?? ADDRESS_SUGGEST.maxItems;
  const timers: SuggestTimers = o.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) };
  let timer: unknown = null;
  let inflight: AbortController | null = null;
  let seq = 0;
  let disposed = false;

  const emit = (s: SuggestState<T>) => {
    if (!disposed) o.onChange(s);
  };
  const stop = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    inflight?.abort();
    inflight = null;
    seq += 1;
  };

  const run = async (query: string, mine: number) => {
    const ctl = new AbortController();
    inflight = ctl;
    emit({ status: 'LOADING', query, items: [], error: null });
    try {
      const found = await o.search(query, ctl.signal);
      if (mine !== seq || ctl.signal.aborted) return;
      const items = (found ?? []).slice(0, maxItems);
      emit({ status: items.length ? 'DONE' : 'EMPTY', query, items, error: null });
    } catch (err) {
      if (mine !== seq || ctl.signal.aborted || isAbort(err)) return;
      emit({ status: statusOf(err) === 429 ? 'RATE_LIMITED' : 'ERROR', query, items: [], error: err });
    } finally {
      if (inflight === ctl) inflight = null;
    }
  };

  return {
    /** The field's text changed (typing). */
    input(text: string) {
      stop();
      const query = text.trim();
      if (!query) return emit({ ...IDLE_SUGGEST });
      if (query.length < minChars) return emit({ status: 'SHORT', query, items: [], error: null });
      const mine = seq;
      emit({ status: 'WAITING', query, items: [], error: null });
      timer = timers.setTimeout(() => {
        timer = null;
        void run(query, mine);
      }, debounceMs);
    },
    /** A suggestion was picked, or the field was cleared: no request, list hidden. */
    reset() {
      stop();
      emit({ ...IDLE_SUGGEST });
    },
    dispose() {
      stop();
      disposed = true;
    },
  };
}
