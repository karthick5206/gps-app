import { ChevronDownIcon, ChevronUpIcon, GaugeIcon, PauseIcon, WifiOffIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDuration, formatNumber } from '@/lib/format';
import { statusColor } from '@/lib/status-tokens';
import { cn } from '@/lib/utils';
import type { AttentionItem, AttentionKind } from './attention';

const OPEN_KEY = 'vt.live.attention';
const SHOWN = 8;
const ICON: Record<AttentionKind, typeof GaugeIcon> = { OVERSPEED: GaugeIcon, IDLE: PauseIcon, OFFLINE: WifiOffIcon };

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

/**
 * "Needs attention" card on the live map: overspeeding, long idle and recently lost vehicles (see attentionItems),
 * most urgent first. A row opens that vehicle. Collapsible; the choice is remembered in this browser.
 */
export function NeedsAttention({ items, onPick, className }: { items: AttentionItem[]; onPick: (id: string) => void; className?: string }) {
  const { t } = useTranslation();
  const [open, setOpenState] = useState(readOpen);
  const setOpen = (on: boolean) => {
    setOpenState(on);
    try {
      localStorage.setItem(OPEN_KEY, on ? '1' : '0');
    } catch {
      /* private window: lasts for this page only */
    }
  };
  const reason = (i: AttentionItem) =>
    i.kind === 'OVERSPEED'
      ? t('Overspeeding at {{speed}} km/h', { speed: formatNumber(Math.round(i.object.speedKph)) })
      : i.kind === 'IDLE'
        ? t('Idling for {{time}}', { time: formatDuration(i.forMs / 1000) })
        : t('No signal for {{time}}', { time: formatDuration(i.forMs / 1000) });

  return (
    <section aria-label={t('Needs attention')} className={cn('flex max-h-[45vh] w-[20rem] flex-col overflow-hidden rounded-xl border bg-card/95 shadow-lg backdrop-blur', className)}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-muted/60">
        <span className="text-sm font-bold">{t('Needs attention')}</span>
        <span className="flex items-center gap-2">
          <span className={cn('rounded-full px-2 py-0.5 text-xs font-bold tabular-nums', items.length ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground')}>{formatNumber(items.length)}</span>
          {open ? <ChevronDownIcon className="size-4 text-muted-foreground" /> : <ChevronUpIcon className="size-4 text-muted-foreground" />}
        </span>
      </button>
      {open && (
        <div className="min-h-0 overflow-y-auto border-t">
          {items.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">{t('All clear: nothing needs attention right now.')}</p>
          ) : (
            <ul>
              {items.slice(0, SHOWN).map((i) => {
                const Icon = ICON[i.kind];
                const color = statusColor(i.kind);
                return (
                  <li key={i.object.objectId} className="border-b last:border-b-0">
                    <button type="button" onClick={() => onPick(i.object.objectId)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-muted/60">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md" style={{ color, backgroundColor: `color-mix(in oklab, ${color} 14%, transparent)` }}>
                        <Icon className="size-4" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">{i.object.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{reason(i)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
              {items.length > SHOWN && <li className="px-3 py-2 text-xs text-muted-foreground">{t('+{{n}} more', { n: formatNumber(items.length - SHOWN) })}</li>}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
