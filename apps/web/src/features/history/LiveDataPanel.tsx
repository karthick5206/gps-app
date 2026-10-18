import { STATUS_META } from '@veetracer/shared';
import { MapPinIcon } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { statusColor } from '@/lib/status-tokens';
import { cn } from '@/lib/utils';
import { formatClock, formatKm, trackStatus } from './history-format';
import type { PlaybackEngine } from './playback-engine';
import { reverseGeocode } from './use-history';

const TEXT_FRAME_MS = 100; // text readouts refresh at ~10 fps while playing

/** Floating readout of the cursor: written imperatively from frame callbacks; address fetched on pause. */
export function LiveDataPanel({ engine, className }: { engine: PlaybackEngine; className?: string }) {
  const { t } = useTranslation();
  const refs = {
    time: useRef<HTMLSpanElement>(null),
    speed: useRef<HTMLSpanElement>(null),
    ignition: useRef<HTMLSpanElement>(null),
    status: useRef<HTMLSpanElement>(null),
    dot: useRef<HTMLSpanElement>(null),
    dist: useRef<HTMLSpanElement>(null),
    coords: useRef<HTMLSpanElement>(null),
  };
  const state = useSyncExternalStore(engine.subscribe, engine.getState);
  const [address, setAddress] = useState<{ key: string; text: string | null } | null>(null);
  const multiDay = engine.index.end - engine.index.start > 86_400_000;

  useEffect(() => {
    let last = 0;
    return engine.onFrame((s, { force }) => {
      const now = performance.now();
      if (!force && now - last < TEXT_FRAME_MS) return;
      last = now;
      const status = trackStatus(s.status);
      const set = (r: { current: HTMLElement | null }, v: string) => {
        if (r.current && r.current.textContent !== v) r.current.textContent = v;
      };
      set(refs.time, formatClock(s.t, multiDay));
      set(refs.speed, `${Math.round(s.speed)}`);
      set(refs.ignition, s.ignition === 1 ? t('On') : s.ignition === 0 ? t('Off') : '—');
      set(refs.status, t(STATUS_META[status].label));
      set(refs.dist, formatKm(s.distKm));
      set(refs.coords, `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}`);
      if (refs.status.current) refs.status.current.style.color = statusColor(status);
      if (refs.dot.current) refs.dot.current.style.backgroundColor = statusColor(status);
    });
    // refs are stable
  }, [engine, multiDay, t]);

  // Address only when paused (debounced), via the reverse-geocode endpoint if the API exposes it.
  useEffect(() => {
    if (state.playing) return;
    const s = engine.getSample();
    const key = `${s.lat.toFixed(5)},${s.lng.toFixed(5)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      reverseGeocode(s.lat, s.lng, ctrl.signal).then((text) => !ctrl.signal.aborted && setAddress({ key, text }));
    }, 350);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [engine, state.playing, state.seekVersion]);

  const s = engine.getSample();
  const currentKey = `${s.lat.toFixed(5)},${s.lng.toFixed(5)}`;
  const addr = !state.playing && address?.key === currentKey ? address.text : null;

  return (
    <div className={cn('pointer-events-auto rounded-xl border bg-card/95 p-2.5 text-sm shadow-lg backdrop-blur-sm sm:p-3', className)} aria-live="off">
      <div className="flex items-baseline justify-between gap-3">
        <span ref={refs.time} className="font-medium tabular-nums" />
        <span className="flex items-center gap-1.5 text-xs font-medium">
          <span ref={refs.dot} className="size-2 rounded-full" aria-hidden />
          <span ref={refs.status} />
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-2 sm:mt-2">
        <div>
          <p className="text-[11px] text-muted-foreground">{t('Speed')}</p>
          <p className="font-semibold tabular-nums">
            <span ref={refs.speed} className="text-lg leading-none" /> <span className="text-xs font-normal text-muted-foreground">km/h</span>
          </p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground">{t('Ignition')}</p>
          <p className="font-semibold">
            <span ref={refs.ignition} />
          </p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground">{t('Distance')}</p>
          <p className="font-semibold tabular-nums">
            <span ref={refs.dist} />
          </p>
        </div>
      </div>
      <p className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground sm:mt-2">
        <MapPinIcon className="mt-px size-3.5 shrink-0" aria-hidden />
        {addr ? <span className="line-clamp-2 text-foreground">{addr}</span> : <span ref={refs.coords} className="font-mono" />}
      </p>
    </div>
  );
}
