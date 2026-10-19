import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { compactNumber, niceMax } from './health-format';

export interface LineSeries<P> {
  key: string;
  label: string;
  color: string;
  /** Dashed stroke: identity doesn't rely on colour alone. */
  dashed?: boolean;
  /** Light fill under the line (single-series charts). */
  area?: boolean;
  value: (p: P) => number | null;
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

const H = 190;
const PAD = { l: 44, r: 10, t: 10, b: 24 };

/** Time-series lines on one axis with a crosshair tooltip (System Health throughput / lag). */
export function LineChart<P extends { t: string }>({
  data,
  series,
  title,
  format,
  empty,
}: {
  data: P[];
  series: LineSeries<P>[];
  title: string;
  format: (v: number) => string;
  empty: string;
}) {
  const { t } = useTranslation();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const values = data.flatMap((d) => series.map((s) => s.value(d) ?? 0));
  const max = niceMax(Math.max(0, ...values));
  const plotW = Math.max(0, width - PAD.l - PAD.r);
  const plotH = H - PAD.t - PAD.b;
  const t0 = data.length ? Date.parse(data[0].t) : 0;
  const t1 = data.length ? Date.parse(data[data.length - 1].t) : 1;
  const span = Math.max(1, t1 - t0);
  const x = (d: P) => PAD.l + ((Date.parse(d.t) - t0) / span) * plotW;
  const y = (v: number) => PAD.t + plotH - (v / max) * plotH;
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const labelCount = Math.max(2, Math.min(6, Math.floor(plotW / 70)));
  const labelIdx = data.length > 1 ? Array.from({ length: labelCount }, (_, i) => Math.round((i * (data.length - 1)) / (labelCount - 1))) : [0];

  const path = (s: LineSeries<P>) => {
    let d = '';
    let open = false;
    for (const p of data) {
      const v = s.value(p);
      if (v === null) {
        open = false;
        continue;
      }
      d += `${open ? 'L' : 'M'}${x(p).toFixed(1)},${y(v).toFixed(1)}`;
      open = true;
    }
    return d;
  };

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    if (!data.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const tx = t0 + ((e.clientX - rect.left) / Math.max(1, rect.width)) * span;
    let best = 0;
    for (let i = 1; i < data.length; i++) if (Math.abs(Date.parse(data[i].t) - tx) < Math.abs(Date.parse(data[best].t) - tx)) best = i;
    setHover(best);
  };

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {series.length > 1 && (
          <ul className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            {series.map((s) => (
              <li key={s.key} className="flex items-center gap-1.5">
                <svg width="16" height="6" aria-hidden>
                  <line x1="0" x2="16" y1="3" y2="3" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? '4 3' : undefined} />
                </svg>
                {t(s.label)}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div ref={ref} className="relative mt-2" onMouseLeave={() => setHover(null)}>
        {!data.length ? (
          <p className="flex h-[190px] items-center justify-center text-sm text-muted-foreground">{empty}</p>
        ) : (
          width > 0 && (
            <svg width={width} height={H} role="img" aria-label={title} className="block overflow-visible">
              {ticks.map((v) => (
                <g key={v}>
                  <line x1={PAD.l} x2={width - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeDasharray={v === 0 ? undefined : '3 3'} />
                  <text x={PAD.l - 6} y={y(v)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">
                    {compactNumber(v)}
                  </text>
                </g>
              ))}
              {[...new Set(labelIdx)].map((i) => (
                <text key={i} x={x(data[i])} y={H - 6} textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'} className="fill-muted-foreground text-[10px] tabular-nums">
                  {timeLabel(data[i].t)}
                </text>
              ))}
              {series.map((s) => {
                const d = path(s);
                return (
                  <g key={s.key}>
                    {s.area && d && <path d={`${d}L${x(data[data.length - 1]).toFixed(1)},${y(0)}L${x(data[0]).toFixed(1)},${y(0)}Z`} fill={s.color} opacity={0.12} />}
                    <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dashed ? '5 4' : undefined} />
                  </g>
                );
              })}
              {hover !== null && data[hover] && (
                <g>
                  <line x1={x(data[hover])} x2={x(data[hover])} y1={PAD.t} y2={PAD.t + plotH} stroke="var(--muted-foreground)" strokeOpacity={0.5} />
                  {series.map((s) => {
                    const v = s.value(data[hover]);
                    return v === null ? null : <circle key={s.key} cx={x(data[hover])} cy={y(v)} r={4} fill={s.color} stroke="var(--card)" strokeWidth={2} />;
                  })}
                </g>
              )}
              <rect x={PAD.l} y={PAD.t} width={plotW} height={plotH} fill="transparent" onPointerMove={onMove} onPointerDown={onMove} />
            </svg>
          )
        )}
        {hover !== null && data[hover] && (
          <div
            className="pointer-events-none absolute top-0 z-10 min-w-36 rounded-md border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md"
            style={{ left: Math.min(Math.max(0, x(data[hover]) + 12), Math.max(0, width - 160)) }}
          >
            <p className="font-medium">{new Date(data[hover].t).toLocaleTimeString()}</p>
            {series.map((s) => {
              const v = s.value(data[hover]);
              return (
                <p key={s.key} className="mt-0.5 flex items-center justify-between gap-3 tabular-nums">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="size-2 rounded-full" style={{ backgroundColor: s.color }} />
                    {t(s.label)}
                  </span>
                  {v === null ? '—' : format(v)}
                </p>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
