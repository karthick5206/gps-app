import type { VideoRecordingDto } from '@veetracer/shared';
import { ZoomInIcon, ZoomOutIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { timelineSpans } from './video-utils';

/** Timeline width at each zoom step, as a multiple of the visible width (1 = the whole search fits). */
const ZOOMS = [1, 2, 4, 8, 16, 32];

/**
 * Scrolling timeline of the searched window: one lane per camera with the recorded parts coloured (event clips amber),
 * hour ticks, the playing position and a cursor. Single tap / click moves the cursor (shows its time); double tap /
 * double click plays from there (the recording covering it, else the next one). Zoom changes the hour width.
 */
export function RecordingTimeline({
  from,
  to,
  recordings,
  channels,
  playhead,
  onPlay,
}: {
  from: Date;
  to: Date;
  recordings: VideoRecordingDto[];
  /** Lanes to draw (1 = road, 2 = driver). */
  channels: number[];
  /** Wall-clock time being played, or null. */
  playhead: string | null;
  onPlay: (at: number, channel: number) => void;
}) {
  const { t } = useTranslation();
  const [zoom, setZoom] = useState(0);
  const [viewW, setViewW] = useState(600);
  const [cursor, setCursor] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const lastTap = useRef<{ at: number; time: number } | null>(null);
  const t0 = from.getTime();
  const total = Math.max(1, to.getTime() - t0);
  const hours = total / 3600_000;
  const width = Math.max(240, Math.round(viewW * ZOOMS[zoom]));
  const pxPerHour = width / Math.max(hours, 1 / 60);
  // Follow the visible width (window resize, phone rotation).
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth || 600));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const spans = useMemo(() => timelineSpans(recordings, from, to), [recordings, from, to]);
  const lanes = channels.length ? channels : [1];

  // Ticks on local clock times, about 70 px apart: 1, 2, 5, 10, 15, 30 min, 1, 2, 3, 6 h.
  const stepMin = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360].find((m) => (m / 60) * pxPerHour >= 70) ?? 720;
  const ticks = useMemo(() => {
    const out: number[] = [];
    const step = stepMin * 60_000;
    const offset = -new Date(t0).getTimezoneOffset() * 60_000;
    for (let x = Math.ceil((t0 + offset) / step) * step - offset; x <= t0 + total; x += step) out.push(x);
    return out;
  }, [t0, total, stepMin]);

  // Keep the playing position in view; first time, scroll to the first recording.
  const pos = (ms: number) => ((ms - t0) / total) * width;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const target = playhead ? pos(Date.parse(playhead)) : spans[0] ? spans[0].left * width : null;
    if (target === null) return;
    if (target < el.scrollLeft + 40 || target > el.scrollLeft + el.clientWidth - 40)
      el.scrollTo({ left: Math.max(0, target - el.clientWidth / 3), behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follow the playhead / zoom, not every render
  }, [playhead ? Math.floor(Date.parse(playhead) / 10_000) : null, zoom, spans.length]);

  const timeAt = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return t0 + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * total;
  };
  const laneOf = (clientY: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const i = Math.floor(((clientY - r.top) / r.height) * lanes.length);
    return lanes[Math.min(lanes.length - 1, Math.max(0, i))];
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const time = timeAt(e.clientX, e.currentTarget);
    setCursor(time);
    // Touch: two taps within 350 ms = double tap (mouse uses onDoubleClick).
    if (e.pointerType !== 'mouse') {
      const now = performance.now();
      if (lastTap.current && now - lastTap.current.at < 350) {
        lastTap.current = null;
        onPlay(time, laneOf(e.clientY, e.currentTarget));
      } else lastTap.current = { at: now, time };
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="flex-1">{t('Double-tap (or double-click) the timeline to play from that time.')}</span>
        {cursor !== null && <span className="tabular-nums">{formatTime(new Date(cursor).toISOString())}</span>}
        <Button size="icon-sm" variant="ghost" onClick={() => setZoom((z) => Math.max(0, z - 1))} disabled={zoom === 0} aria-label={t('Zoom out')}>
          <ZoomOutIcon />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}
          disabled={zoom === ZOOMS.length - 1}
          aria-label={t('Zoom in')}
        >
          <ZoomInIcon />
        </Button>
      </div>
      <div className="flex rounded-lg border bg-muted/40">
        <div className="flex w-16 shrink-0 flex-col border-e text-[11px] text-muted-foreground sm:w-20">
          <div className="h-6 border-b" />
          {lanes.map((ch) => (
            <div key={ch} className="flex h-8 items-center px-2">
              {ch === 2 ? t('Driver') : ch === 1 ? t('Road') : t('CH{{n}}', { n: ch })}
            </div>
          ))}
        </div>
        <div ref={scroller} className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain">
          <div className="relative select-none" style={{ width }}>
            {/* ruler */}
            <div className="relative h-6 border-b text-[10px] text-muted-foreground">
              {ticks.map((x) => (
                <span key={x} className="absolute top-0 h-full border-s ps-1 leading-6 tabular-nums" style={{ left: pos(x) }}>
                  {formatTime(new Date(x).toISOString())}
                </span>
              ))}
            </div>
            {/* lanes */}
            <div
              className="relative cursor-pointer touch-pan-x"
              style={{ height: lanes.length * 32 }}
              onPointerUp={onPointerUp}
              onDoubleClick={(e) => onPlay(timeAt(e.clientX, e.currentTarget), laneOf(e.clientY, e.currentTarget))}
              role="slider"
              aria-label={t('Recording timeline')}
              aria-valuemin={t0}
              aria-valuemax={t0 + total}
              aria-valuenow={cursor ?? (playhead ? Date.parse(playhead) : t0)}
              aria-valuetext={cursor !== null ? formatTime(new Date(cursor).toISOString()) : undefined}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && cursor !== null) onPlay(cursor, lanes[0]);
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft')
                  setCursor((c) => Math.min(t0 + total, Math.max(t0, (c ?? t0) + (e.key === 'ArrowRight' ? 60_000 : -60_000))));
              }}
            >
              {ticks.map((x) => (
                <span key={x} className="pointer-events-none absolute inset-y-0 border-s border-border/60" style={{ left: pos(x) }} aria-hidden />
              ))}
              {spans.map((s, i) => {
                const lane = Math.max(0, lanes.indexOf(s.channel));
                return (
                  <span
                    key={i}
                    className={cn(
                      'pointer-events-none absolute h-5 rounded-sm',
                      s.event ? 'bg-amber-500' : s.channel === 2 ? 'bg-violet-500/80' : 'bg-sky-600/80',
                    )}
                    style={{ left: s.left * width, width: Math.max(s.event ? 4 : 2, s.width * width), top: lane * 32 + 6, zIndex: s.event ? 1 : 0 }}
                    aria-hidden
                  />
                );
              })}
              {cursor !== null && <span className="pointer-events-none absolute inset-y-0 w-px bg-foreground/60" style={{ left: pos(cursor) }} aria-hidden />}
              {playhead && (
                <span className="pointer-events-none absolute inset-y-0 w-0.5 bg-destructive" style={{ left: pos(Date.parse(playhead)) }} aria-hidden />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
