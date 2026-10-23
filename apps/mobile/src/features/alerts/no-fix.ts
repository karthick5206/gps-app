import { alertNoFix, type AlertDto } from '@veetracer/shared';
import type { TFunction } from 'i18next';
import { formatDateTime } from '@/lib/format';

/** "No GPS fix: last known location (time)" for alerts raised without a fix; null for a normal alert. */
export function noFixText(t: TFunction, a: Pick<AlertDto, 'data' | 'lat'>): string | null {
  const noFix = alertNoFix(a.data);
  if (!noFix) return null;
  if (a.lat === null) return t('No GPS fix: location unknown');
  return noFix.lastFixAt ? t('No GPS fix: last known location ({{time}})', { time: formatDateTime(noFix.lastFixAt) }) : t('No GPS fix: last known location');
}
