import type { SummaryReportRow } from '@veetracer/shared';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Card } from '@/components/ui/card';
import { statusColor } from '@/lib/status-tokens';
import { formatHm, periodLabel, periodShortLabel } from './report-format';

interface PeriodAgg {
  period: string;
  distanceKm: number;
  runningSec: number;
  idleSec: number;
  stopSec: number;
}

function aggregate(rows: SummaryReportRow[]): PeriodAgg[] {
  const map = new Map<string, PeriodAgg>();
  for (const r of rows) {
    const a = map.get(r.period) ?? { period: r.period, distanceKm: 0, runningSec: 0, idleSec: 0, stopSec: 0 };
    a.distanceKm += r.distanceKm;
    a.runningSec += r.runningSec;
    a.idleSec += r.idleSec;
    a.stopSec += r.stopSec;
    map.set(r.period, a);
  }
  return [...map.values()].sort((a, b) => a.period.localeCompare(b.period));
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Bar with 4 px rounded top, square at the baseline. */
function barPath(x: number, y: number, w: number, h: number, round: boolean): string {
  if (h <= 0) return '';
  const r = round ? Math.min(4, w / 2, h) : 0;
  return `M${x},${y + h}V${y + r}${r ? `Q${x},${y} ${x + r},${y}` : ''}H${x + w - r}${r ? `Q${x + w},${y} ${x + w},${y + r}` : ''}V${y + h}Z`;
}

interface Segment {
  key: string;
  label: string;
  color: string;
  value: (a: PeriodAgg) => number;
}

const H = 200;
const PAD = { l: 44, r: 8, t: 10, b: 24 };

function BarChart({ data, segments, format, axisFormat, title }: { data: PeriodAgg[]; segments: Segment[]; format: (v: number) => string; axisFormat: (v: number) => string; title: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const totals = data.map((d) => segments.reduce((s, seg) => s + seg.value(d), 0));
  const max = niceMax(Math.max(0, ...totals));
  const plotW = Math.max(0, width - PAD.l - PAD.r);
  const plotH = H - PAD.t - PAD.b;
  const band = data.length ? plotW / data.length : 0;
  const barW = Math.max(2, Math.min(36, band * 0.7));
  const y = (v: number) => PAD.t + plotH - (v / max) * plotH;
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 56))));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {segments.length > 1 && (
          <ul className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            {segments.map((s) => (
              <li key={s.key} className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm" style={{ backgroundColor: s.color }} aria-hidden />
                {s.label}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div ref={ref} className="relative mt-2" onMouseLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={H} role="img" aria-label={title} className="block overflow-visible">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray={t === 0 ? undefined : '3 3'} />
                <text x={PAD.l - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">
                  {axisFormat(t)}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const x = PAD.l + i * band + (band - barW) / 2;
              let acc = 0;
              const visible = segments.filter((s) => s.value(d) > 0);
              return (
                <g key={d.period} opacity={hover === null || hover === i ? 1 : 0.55}>
                  {visible.map((s, k) => {
                    const v = s.value(d);
                    const top = y(acc + v);
                    const h = y(acc) - top - (k > 0 ? 2 : 0); // 2 px surface gap between stacked segments
                    acc += v;
                    return <path key={s.key} d={barPath(x, top, barW, Math.max(0, h), k === visible.length - 1)} fill={s.color} />;
                  })}
                  {i % labelEvery === 0 && (
                    <text x={x + barW / 2} y={H - 8} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                      {periodShortLabel(d.period)}
                    </text>
                  )}
                  <rect x={PAD.l + i * band} y={PAD.t} width={band} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} />
                </g>
              );
            })}
          </svg>
        )}
        {hover !== null && data[hover] && (
          <div
            className="pointer-events-none absolute top-0 z-10 min-w-36 rounded-md border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md"
            style={{ left: Math.min(Math.max(0, PAD.l + hover * band + band / 2 - 72), Math.max(0, width - 150)) }}
          >
            <p className="font-medium">{periodLabel(data[hover].period)}</p>
            {segments.map((s) => (
              <p key={s.key} className="mt-0.5 flex items-center justify-between gap-3 tabular-nums">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="size-2 rounded-sm" style={{ backgroundColor: s.color }} />
                  {s.label}
                </span>
                {format(s.value(data[hover]))}
              </p>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

const DISTANCE: Segment[] = [{ key: 'distance', label: 'Distance', color: 'var(--primary)', value: (a) => a.distanceKm }];
/** Values in hours so the axis gets round hour ticks. */
const TIME: Segment[] = [
  { key: 'running', label: 'Running', color: statusColor('RUNNING'), value: (a) => a.runningSec / 3600 },
  { key: 'idle', label: 'Idle', color: statusColor('IDLE'), value: (a) => a.idleSec / 3600 },
  { key: 'stop', label: 'Stopped', color: statusColor('OFF'), value: (a) => a.stopSec / 3600 },
];

/** Summary report charts: distance per period, and running/idle/stopped time stacked per period (all vehicles). */
export function SummaryCharts({ rows }: { rows: SummaryReportRow[] }) {
  const data = useMemo(() => aggregate(rows), [rows]);
  if (!data.length) return null;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <BarChart title="Distance (km)" data={data} segments={DISTANCE} format={(v) => `${v.toFixed(1)} km`} axisFormat={(v) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : String(Math.round(v)))} />
      <BarChart title="Running / idle / stopped (hh:mm)" data={data} segments={TIME} format={(h) => formatHm(h * 3600)} axisFormat={(h) => `${Number.isInteger(h) ? h : h.toFixed(1)}h`} />
    </div>
  );
}
