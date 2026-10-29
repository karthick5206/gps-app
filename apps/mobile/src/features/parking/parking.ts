import { useQuery } from '@tanstack/react-query';
import { WEEKDAY_SHORT, WEEKDAYS, type ParkingRowDto } from '@veetracer/shared';
import { api } from '@/lib/api';

export const PARKING_QUERY = ['parking-mode'];

/** Parking mode rows (vehicles in scope, schedule, armed now / next), refreshed every minute. */
export function useParkingRows() {
  return useQuery({ queryKey: PARKING_QUERY, queryFn: ({ signal }) => api.get<ParkingRowDto[]>('/parking-mode', undefined, signal), refetchInterval: 60_000 });
}

/** "Every day", "Mon–Fri" or "Sat, Sun". */
export function daysLabel(days: number[], t: (k: string) => string): string {
  const set = new Set(days);
  if (set.size === 7) return t('Every day');
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return t('Mon–Fri');
  return WEEKDAYS.filter((d) => set.has(d)).map((d) => t(WEEKDAY_SHORT[d])).join(', ');
}
