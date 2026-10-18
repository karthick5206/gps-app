import { useEffect, useState, useSyncExternalStore } from 'react';
import { liveStore, type LiveEvent } from './live-store';
import { realtime } from './realtime';

/** Re-renders at most once per `intervalMs` while live data changes; returns the store version. */
export function useLiveVersion(intervalMs = 1000): number {
  const [version, setVersion] = useState(() => liveStore.getVersion());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    const flush = () => {
      timer = undefined;
      last = performance.now();
      setVersion(liveStore.getVersion());
    };
    const unsubscribe = liveStore.subscribe((e: LiveEvent) => {
      if (e.type !== 'batch') return flush();
      if (timer) return;
      timer = setTimeout(flush, Math.max(0, intervalMs - (performance.now() - last)));
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [intervalMs]);
  return version;
}

export function useRealtimeStatus() {
  return useSyncExternalStore(realtime.subscribe, realtime.getStatus);
}

/** Re-renders every `intervalMs` so relative times ("3 min ago") stay current. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
