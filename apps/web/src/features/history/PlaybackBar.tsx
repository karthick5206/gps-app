import type { AlertDto, TripDto } from '@veetracer/shared';
import { ChevronDownIcon, ChevronUpIcon, FastForwardIcon, GaugeIcon, LocateFixedIcon, LocateIcon, PauseIcon, PlayIcon, RotateCcwIcon, SkipForwardIcon } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { PLAYBACK_RATES } from './playback-core';
import type { PlaybackEngine } from './playback-engine';
import { Timeline } from './Timeline';

const OPEN_KEY = 'vt.history.timeline';
const readOpen = () => {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
};

function Toggle({ pressed, onClick, children, label }: { pressed: boolean; onClick: () => void; children: React.ReactNode; label: string }) {
  return (
    <Tooltip content={label}>
      <Button size="sm" variant="ghost" aria-pressed={pressed} onClick={onClick} className={cn(pressed ? 'bg-primary/12 text-primary hover:bg-primary/18 hover:text-primary' : 'text-muted-foreground')}>
        {children}
      </Button>
    </Tooltip>
  );
}

export function PlaybackBar({
  engine,
  trips,
  alerts,
  fuel,
  follow,
  onFollowChange,
  skipStops,
  onSkipStopsChange,
  className,
}: {
  engine: PlaybackEngine;
  trips: TripDto[];
  alerts: AlertDto[];
  fuel?: [number, number][];
  follow: boolean;
  onFollowChange: (v: boolean) => void;
  skipStops: boolean;
  onSkipStopsChange: (v: boolean) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(engine.subscribe, engine.getState);
  const playable = engine.index.n > 1;
  // Minimised: only the controls row; the timeline and speed chart fold away so the map gets the room.
  const [open, setOpenState] = useState(readOpen);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    try {
      localStorage.setItem(OPEN_KEY, v ? '1' : '0');
    } catch {
      /* private window: lasts for this page only */
    }
  };
  return (
    <div className={cn('space-y-2 bg-card px-3 pt-2 pb-2', className)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <Button
          size="icon"
          className="rounded-full"
          onClick={() => engine.toggle()}
          disabled={!playable}
          aria-label={state.playing ? t('Pause') : state.ended ? t('Replay') : t('Play')}
          aria-keyshortcuts="Space"
        >
          {state.playing ? <PauseIcon className="fill-current" /> : state.ended ? <RotateCcwIcon /> : <PlayIcon className="fill-current" />}
        </Button>
        <div className="flex items-center rounded-lg bg-muted p-0.5" role="group" aria-label={t('Playback speed')}>
          {PLAYBACK_RATES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => engine.setRate(r)}
              aria-pressed={state.rate === r}
              className={cn(
                'h-7 min-w-9 rounded-md px-1.5 text-xs font-medium tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                state.rate === r ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {r}×
            </button>
          ))}
        </div>
        <span className="hidden text-xs text-muted-foreground xl:inline">
          <GaugeIcon className="mr-1 inline size-3.5 align-[-2px]" />
          {t('1× = 1 min per second')}
        </span>
        <span className="flex-1" />
        <Toggle pressed={skipStops} onClick={() => onSkipStopsChange(!skipStops)} label={t('Skip through stops and gaps quickly')}>
          {skipStops ? <FastForwardIcon /> : <SkipForwardIcon />}
          <span className="hidden sm:inline">{t('Skip stops')}</span>
        </Toggle>
        <Toggle pressed={follow} onClick={() => onFollowChange(!follow)} label={t('Keep the vehicle centred')}>
          {follow ? <LocateFixedIcon /> : <LocateIcon />}
          <span className="hidden sm:inline">{t('Follow')}</span>
        </Toggle>
        <Tooltip content={open ? t('Minimise') : t('Show timeline')}>
          <Button size="icon-sm" variant="ghost" aria-expanded={open} aria-label={open ? t('Minimise') : t('Show timeline')} onClick={() => setOpen(!open)} className="text-muted-foreground">
            {open ? <ChevronDownIcon /> : <ChevronUpIcon />}
          </Button>
        </Tooltip>
      </div>
      <div className={cn(!open && 'hidden')}>
        {playable ? <Timeline engine={engine} trips={trips} alerts={alerts} fuel={fuel} /> : <p className="py-3 text-center text-xs text-muted-foreground">{t('Not enough points to play back.')}</p>}
      </div>
    </div>
  );
}
