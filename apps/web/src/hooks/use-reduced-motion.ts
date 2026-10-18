import { useSyncExternalStore } from 'react';

const query = window.matchMedia('(prefers-reduced-motion: reduce)');

export function prefersReducedMotion(): boolean {
  return query.matches;
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      query.addEventListener('change', cb);
      return () => query.removeEventListener('change', cb);
    },
    () => query.matches,
  );
}
