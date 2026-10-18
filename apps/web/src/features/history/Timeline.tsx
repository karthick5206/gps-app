import type { AlertDto, TripDto } from '@veetracer/shared';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/features/theme/use-theme';
import { cn } from '@/lib/utils';
import { sampleAt, type TrackIndex } from './playback-core';
import type { PlaybackEngine } from './playback-engine';
import { formatClock, formatDay, severityColor, timeTicks } from './history-format';

const CHART_H = 56;

function token(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Max speed per pixel column so a 17k-point day draws in one pass. */
function drawSpeed(canvas: HTMLCanvasElement, idx: TrackIndex, width: number, height: number) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const span = idx.end - idx.start;
  if (idx.n < 2 || span <= 0 || width < 2) return 0;
  const cols = Math.floor(width);
  const max = new Float32Array(cols).fill(-1);
  let top = 0;
  for (let i = 0; i < idx.n; i++) {
    const c = Math.min(cols - 1, Math.floor(((idx.t[i] - idx.start) / span) * cols));
    const s = idx.speed[i];
    if (s > max[c]) max[c] = s;
    if (s > top) top = s;
  }
  const yMax = Math.max(40, Math.ceil(top / 20) * 20);
  const y = (s: number) => height - 2 - (s / yMax) * (height - 6);

  // recessive grid: one mid line
  ctx.strokeStyle = token('--border', '#e2e8f0');
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(0, Math.round(y(yMax / 2)) + 0.5);
  ctx.lineTo(width, Math.round(y(yMax / 2)) + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);

  const primary = token('--primary', '#0f766e');
  ctx.beginPath();
  let started = false;
  let lastX = 0;
  for (let c = 0; c < cols; c++) {
    if (max[c] < 0) continue; // no data in this column: the line bridges it
    const x = c + 0.5;
    if (!started) {
      ctx.moveTo(x, height);
      ctx.lineTo(x, y(max[c]));
      started = true;
    } else ctx.lineTo(x, y(max[c]));
    lastX = x;
  }
  if (!started) return yMax;
  ctx.lineTo(lastX, height);
  ctx.closePath();
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = primary;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  started = false;
  for (let c = 0; c < cols; c++) {
    if (max[c] < 0) continue;
    if (!started) {
      ctx.moveTo(c + 0.5, y(max[c]));
      started = true;
    } else ctx.lineTo(c + 0.5, y(max[c]));
  }
  ctx.strokeStyle = primary;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
  return yMax;
}

/**
 * Scrubber + speed chart on a shared time axis. Drawn once per dataset/size/theme; the cursor and played fill
 * are moved imperatively from the engine's frame listener (CSS transforms, no React renders per frame).
 */
export function Timeline({
  engine,
  trips,
  alerts,
  className,
}: {
  engine: PlaybackEngine;
  trips: TripDto[];
  alerts: AlertDto[];
  className?: string;
}) {
  const { t } = useTranslation();
  const idx = engine.index;
  const { preference } = useTheme();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const playedRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [yMax, setYMax] = useState(0);
  const span = Math.max(1, idx.end - idx.start);
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - idx.start) / span) * 100));

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (canvasRef.current && width) setYMax(drawSpeed(canvasRef.current, idx, width, CHART_H));
  }, [idx, width, preference]);

  // Imperative cursor updates; aria value only on discrete moves.
  useEffect(
    () =>
      engine.onFrame((s, { force }) => {
        const p = ((s.t - idx.start) / span) * 100;
        const x = Math.min(100, Math.max(0, p));
        if (cursorRef.current) cursorRef.current.style.left = `${x}%`;
        if (playedRef.current) playedRef.current.style.transform = `scaleX(${x / 100})`;
        if (force && wrapRef.current) {
          wrapRef.current.setAttribute('aria-valuenow', String(Math.round(s.t / 1000)));
          wrapRef.current.setAttribute('aria-valuetext', `${formatClock(s.t, true)}, ${Math.round(s.speed)} km/h`);
        }
      }),
    [engine, idx, span],
  );

  const timeAt = (clientX: number) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return idx.start + f * span;
  };

  const drag = useRef<{ wasPlaying: boolean } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const wasPlaying = engine.getState().playing;
    drag.current = { wasPlaying };
    if (wasPlaying) engine.pause();
    engine.seek(timeAt(e.clientX));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const t = timeAt(e.clientX);
    if (drag.current) engine.seek(t);
    const hover = hoverRef.current;
    if (hover) {
      const s = sampleAt(idx, t);
      hover.style.left = `${pct(t)}%`;
      hover.dataset.side = pct(t) > 70 ? 'left' : 'right';
      hover.hidden = false;
      const label = hover.querySelector('[data-label]');
      if (label) label.textContent = `${formatClock(t, idx.end - idx.start > 86_400_000)} · ${Math.round(s.speed)} km/h`;
    }
  };
  const endDrag = () => {
    if (drag.current?.wasPlaying) engine.play();
    drag.current = null;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = engine.getSample().t;
    const stepMs = e.shiftKey ? 10 * 60_000 : 60_000;
    let handled = true;
    if (e.key === 'ArrowRight') engine.seek(cur + stepMs, { play: engine.getState().playing });
    else if (e.key === 'ArrowLeft') engine.seek(cur - stepMs, { play: engine.getState().playing });
    else if (e.key === 'Home') engine.seek(idx.start);
    else if (e.key === 'End') engine.seek(idx.end);
    else handled = false;
    if (handled) e.preventDefault();
  };

  const ticks = Math.max(2, Math.floor(width / 90));

  return (
    <div className={cn('select-none', className)}>
      <div
        ref={wrapRef}
        role="slider"
        tabIndex={0}
        aria-label={t('Playback position')}
        aria-valuemin={Math.round(idx.start / 1000)}
        aria-valuemax={Math.round(idx.end / 1000)}
        className="relative cursor-pointer touch-none rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => hoverRef.current && (hoverRef.current.hidden = true)}
        onKeyDown={onKeyDown}
      >
        {/* Scrubber: trip segments + alert ticks */}
        <div className="relative h-5">
          <div className="absolute inset-x-0 top-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div ref={playedRef} className="absolute inset-0 origin-left bg-primary/25" style={{ transform: 'scaleX(0)' }} />
          </div>
          {trips.map((trip) => {
            const a = pct(Date.parse(trip.startTime));
            const b = pct(Date.parse(trip.endTime));
            return (
              <div
                key={trip.id}
                className="absolute top-2 h-1.5 rounded-full bg-primary"
                style={{ left: `${a}%`, width: `max(2px, calc(${b - a}% - 2px))` }}
                title={t('Trip {{from}} – {{to}}', { from: formatClock(Date.parse(trip.startTime)), to: formatClock(Date.parse(trip.endTime)) })}
              />
            );
          })}
          {alerts.map((a) => (
            <div
              key={a.id}
              className="absolute top-0 h-2 w-0.5 -translate-x-1/2 rounded-full"
              style={{ left: `${pct(Date.parse(a.occurredAt))}%`, backgroundColor: severityColor(a.severity) }}
              title={a.message}
            />
          ))}
        </div>
        {/* Speed chart */}
        <div className="relative" style={{ height: CHART_H }}>
          <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden />
          {yMax > 0 && <span className="pointer-events-none absolute top-0 left-1 text-[10px] text-muted-foreground tabular-nums">{yMax} km/h</span>}
        </div>
        {/* Cursor */}
        <div ref={cursorRef} className="pointer-events-none absolute top-0 bottom-0 left-0 w-0" aria-hidden>
          <div className="absolute top-0 bottom-0 -left-px w-0.5 bg-foreground/80" />
          <div className="absolute top-1 -left-[7px] size-3.5 rounded-full border-2 border-card bg-foreground shadow" />
        </div>
        {/* Hover readout */}
        <div ref={hoverRef} hidden className="group pointer-events-none absolute top-0 bottom-0 w-0" aria-hidden>
          <div className="absolute top-5 bottom-0 w-px bg-muted-foreground/50" />
          <span
            data-label
            className="absolute top-6 ml-1.5 rounded bg-popover px-1.5 py-0.5 text-[11px] whitespace-nowrap text-popover-foreground shadow ring-1 ring-border tabular-nums group-data-[side=left]:right-1.5 group-data-[side=left]:ml-0"
          />
        </div>
      </div>
      <div className="relative mt-1 h-4 overflow-hidden text-[10px] text-muted-foreground tabular-nums" aria-hidden>
        {timeTicks(idx.start, idx.end, ticks).map(({ t, step }) => {
          const p = pct(t);
          return (
            <span key={t} className={cn('absolute whitespace-nowrap', p < 4 ? '' : p > 96 ? '-translate-x-full' : '-translate-x-1/2')} style={{ left: `${p}%` }}>
              {step >= 86_400_000 ? formatDay(t) : formatClock(t, false, false)}
            </span>
          );
        })}
      </div>
    </div>
  );
}
