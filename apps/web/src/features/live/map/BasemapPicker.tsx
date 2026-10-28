import type { BasemapType } from '@veetracer/shared';
import { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { basemapStore } from './basemap-store';

const subscribe = (fn: () => void) => basemapStore.subscribe(fn);

/** Map type switcher (Standard / Light / Satellite); Satellite only when the server has imagery configured. */
export function BasemapPicker({ className }: { className?: string }) {
  const { t } = useTranslation();
  const type = useSyncExternalStore(subscribe, () => basemapStore.type);
  const satellite = useSyncExternalStore(subscribe, () => basemapStore.satelliteAvailable);
  useEffect(() => basemapStore.ensureConfig(), []);
  const effective: BasemapType = type === 'satellite' && !satellite ? 'standard' : type;
  const options: { value: BasemapType; label: string }[] = [
    { value: 'standard', label: t('Standard') },
    { value: 'light', label: t('Light') },
    ...(satellite ? [{ value: 'satellite' as const, label: t('Satellite') }] : []),
  ];
  return (
    <div className={cn('flex rounded-md bg-muted p-0.5', className)} role="group" aria-label={t('Map type')}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={effective === o.value}
          onClick={() => basemapStore.set(o.value)}
          className={cn(
            'h-6 flex-1 rounded px-2 text-xs font-medium transition-colors',
            effective === o.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
