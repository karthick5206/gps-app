import type { AttendanceRowDto } from '@veetracer/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/features/theme/use-theme';
import { minutesOfDayLocal } from './employee-stats';

/*
 * Employee insights charts: hours worked each day (stacked: within the shift / overtime, against the shift length) and
 * the day span (first in → last out over the shift window). Series colours are fixed, validated slots (blue, aqua)
 * independent of the colour theme; late / absent use the status colours and always carry a letter or label.
 */
const SERIES = {
  light: { within: '#2a78d6', overtime: '#1baf7a' },
  dark: { within: '#3987e5', overtime: '#199e70' },
} as const;

export interface ChartFormat {
  /** "8 h 40 min" */
  duration: (min: number) => string;
  /** "09:12" */
  time: (iso: string | null) => string;
  /** "09:30" from minutes after midnight */
  clock: (min: number) => string;
  /** Status label of a day ("Present", "Late", "Absent"…) */
  status: (r: AttendanceRowDto) => string;
}

const dayNum = (day: string) => Number(day.slice(8, 10));
const weekdayShort = (day: string) => new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
const longDate = (day: string) => new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));

/** Width of an element, kept current as it resizes. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** The hover card both charts share: date, status, in / out, worked, overtime, late, unexplained time. */
function DayTooltip({ r, f, x, y, width }: { r: AttendanceRowDto; f: ChartFormat; x: number; y: number; width: number }) {
  const { t } = useTranslation();
  const lines: [string, string][] = [
    [t('In / out'), r.firstIn ? `${f.time(r.firstIn)} – ${r.lastOut ? f.time(r.lastOut) : t('still in')}` : '—'],
    [t('Worked'), r.workedMin ? f.duration(r.workedMin) : '—'],
  ];
  if (r.overtimeMin) lines.push([t('Overtime'), f.duration(r.overtimeMin)]);
  if (r.lateMin) lines.push([t('Late'), f.duration(r.lateMin)]);
  if (r.earlyMin) lines.push([t('Left early'), f.duration(r.earlyMin)]);
  if (r.unexplainedMin) lines.push([t('Not explained'), f.duration(r.unexplainedMin)]);
  const left = Math.min(Math.max(8, x + 12), Math.max(8, width - 220));
  return (
    <div className="pointer-events-none absolute z-10 w-[208px] rounded-md border bg-popover p-2.5 text-xs shadow-md" style={{ left, top: Math.max(0, y) }} role="tooltip">
      <div className="font-semibold">{longDate(r.day)}</div>
      <div className="mb-1 text-muted-foreground">
        {f.status(r)}
        {r.corrected ? ` · ${t('Corrected')}` : ''}
      </div>
      {lines.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3 tabular-nums">
          <span className="text-muted-foreground">{k}</span>
          <span className="font-medium">{v}</span>
        </div>
      ))}
    </div>
  );
}

function Legend({ items }: { items: { key: string; swatch: ReactNode; label: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((i) => (
        <span key={i.key} className="inline-flex items-center gap-1.5">
          {i.swatch}
          {i.label}
        </span>
      ))}
    </div>
  );
}
const Swatch = ({ color }: { color: string }) => <span className="inline-block size-2.5 rounded-[2px]" style={{ background: color }} />;

/**
 * Hours worked each day: within the shift + overtime stacked, a dashed line at the shift length, an hours scale,
 * every date (thinned when narrow), day-off columns shaded, a strip under the bars marking late (amber dot) and absent
 * (red "A") days, overtime of 30 min or more labelled. Hover for the day's details; click to open the day.
 */
export function HoursChart({ rows, shiftMin, f, onPick }: { rows: AttendanceRowDto[]; shiftMin: number | null; f: ChartFormat; onPick: (r: AttendanceRowDto) => void }) {
  const { t } = useTranslation();
  const { resolved } = useTheme();
  const c = SERIES[resolved === 'dark' ? 'dark' : 'light'];
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 230;
  const m = { top: 18, right: 8, bottom: 40, left: 34 };
  const plotW = Math.max(0, width - m.left - m.right);
  const plotH = H - m.top - m.bottom;
  const maxWorked = Math.max(...rows.map((r) => r.workedMin), shiftMin ?? 0, 9 * 60);
  const yMax = Math.ceil((maxWorked + 30) / 180) * 180; // whole 3-hour steps with headroom
  const y = (min: number) => m.top + plotH - (min / yMax) * plotH;
  const slot = rows.length ? plotW / rows.length : 0;
  const barW = Math.max(3, Math.min(26, slot * 0.62));
  const labelEvery = Math.max(1, Math.ceil((rows.length * 20) / Math.max(1, plotW)));
  const ticks = Array.from({ length: yMax / 180 + 1 }, (_, i) => i * 180);
  const markY = H - m.bottom + 8;
  const hovered = hover !== null ? rows[hover] : null;

  return (
    <div className="space-y-2">
      <Legend
        items={[
          { key: 'in', swatch: <Swatch color={c.within} />, label: t('Within shift') },
          { key: 'ot', swatch: <Swatch color={c.overtime} />, label: t('Overtime') },
          ...(shiftMin ? [{ key: 'sh', swatch: <span className="inline-block w-4 border-t-2 border-dashed border-foreground/60" />, label: t('Shift length ({{h}})', { h: f.duration(shiftMin) }) }] : []),
          { key: 'late', swatch: <span className="inline-block size-2 rounded-full bg-warning" />, label: t('Late') },
          { key: 'abs', swatch: <span className="text-[11px] font-bold text-destructive">A</span>, label: t('Absent') },
        ]}
      />
      <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={H} role="img" aria-label={t('Hours worked each day')}>
            {/* Hours scale and grid (recessive) */}
            {ticks.map((v) => (
              <g key={v}>
                <line x1={m.left} x2={width - m.right} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth={1} />
                <text x={m.left - 6} y={y(v) + 3.5} textAnchor="end" fontSize={10.5} fill="var(--muted-foreground)">
                  {v / 60} h
                </text>
              </g>
            ))}
            {rows.map((r, i) => {
              const cx = m.left + slot * i + slot / 2;
              const within = Math.max(0, r.workedMin - r.overtimeMin);
              const off = r.status === 'DAY_OFF';
              const yWithin = y(within);
              const yTop = y(r.workedMin);
              const topIsOt = r.overtimeMin > 0;
              const rad = Math.min(4, barW / 2);
              // A bar with only its top corners rounded, from yTopPx down to yBottomPx.
              const bar = (yTopPx: number, yBottomPx: number, round: boolean) =>
                round
                  ? `M${cx - barW / 2},${yBottomPx} V${yTopPx + rad} Q${cx - barW / 2},${yTopPx} ${cx - barW / 2 + rad},${yTopPx} H${cx + barW / 2 - rad} Q${cx + barW / 2},${yTopPx} ${cx + barW / 2},${yTopPx + rad} V${yBottomPx} Z`
                  : `M${cx - barW / 2},${yBottomPx} V${yTopPx} H${cx + barW / 2} V${yBottomPx} Z`;
              return (
                <g key={r.day}>
                  {(off || hover === i) && <rect x={m.left + slot * i} y={m.top} width={slot} height={plotH} fill={hover === i ? 'var(--accent)' : 'var(--muted)'} opacity={hover === i ? 0.7 : 1} />}
                  {within > 0 && <path d={bar(yWithin, y(0), !topIsOt)} fill={c.within} />}
                  {topIsOt && <path d={bar(yTop, yWithin - (within > 0 ? 2 : 0), true)} fill={c.overtime} />}
                  {r.overtimeMin >= 30 && slot >= 18 && (
                    <text x={cx} y={yTop - 4} textAnchor="middle" fontSize={9.5} fill="var(--foreground)" opacity={0.8}>
                      +{Math.floor(r.overtimeMin / 60) ? `${Math.floor(r.overtimeMin / 60)}h` : ''}
                      {r.overtimeMin % 60 ? `${r.overtimeMin % 60}m` : ''}
                    </text>
                  )}
                  {/* Status strip: late dot / absent "A" */}
                  {r.lateMin > 0 && <circle cx={cx} cy={markY} r={3.5} fill="var(--warning)" />}
                  {r.status === 'ABSENT' && (
                    <text x={cx} y={markY + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--destructive)">
                      A
                    </text>
                  )}
                  {i % labelEvery === 0 && (
                    <text x={cx} y={H - 10} textAnchor="middle" fontSize={10.5} fill="var(--muted-foreground)">
                      {dayNum(r.day)}
                    </text>
                  )}
                  {/* Hit area wider than the bar: hover / focus shows the day, click / Enter opens it. */}
                  <rect
                    x={m.left + slot * i}
                    y={m.top}
                    width={slot}
                    height={plotH + m.bottom - 14}
                    fill="transparent"
                    tabIndex={0}
                    aria-label={`${longDate(r.day)}: ${f.status(r)}, ${r.workedMin ? f.duration(r.workedMin) : '—'}`}
                    style={{ cursor: 'pointer', outline: 'none' }}
                    onMouseEnter={() => setHover(i)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                    onClick={() => onPick(r)}
                    onKeyDown={(e) => e.key === 'Enter' && onPick(r)}
                  />
                </g>
              );
            })}
            {shiftMin ? (
              <g pointerEvents="none">
                <line x1={m.left} x2={width - m.right} y1={y(shiftMin)} y2={y(shiftMin)} stroke="var(--foreground)" strokeOpacity={0.55} strokeWidth={1.5} strokeDasharray="5 4" />
              </g>
            ) : null}
            <line x1={m.left} x2={width - m.right} y1={y(0)} y2={y(0)} stroke="var(--muted-foreground)" strokeOpacity={0.5} />
          </svg>
        )}
        {hovered && hover !== null && <DayTooltip r={hovered} f={f} x={m.left + slot * hover + slot / 2} y={8} width={width} />}
      </div>
    </div>
  );
}

/**
 * Day span: one row per day, a bar from first in to last out over the shift window (shaded), the part after the shift
 * end in the overtime colour, a dashed line where "late" starts (shift start + grace), amber marks for a late start /
 * early leave, and "Absent" / "Day off" written out. Hover for details; click to open the day.
 */
export function DaySpanChart({ rows, shift, f, onPick }: { rows: AttendanceRowDto[]; shift: { startMin: number; endMin: number; graceMin: number } | null; f: ChartFormat; onPick: (r: AttendanceRowDto) => void }) {
  const { t } = useTranslation();
  const { resolved } = useTheme();
  const c = SERIES[resolved === 'dark' ? 'dark' : 'light'];
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const ins = rows.filter((r) => r.firstIn).map((r) => minutesOfDayLocal(r.firstIn!));
  const outs = rows.filter((r) => r.lastOut).map((r) => minutesOfDayLocal(r.lastOut!));
  const lo = Math.max(0, Math.floor(Math.min(shift ? shift.startMin - 60 : 8 * 60, ...ins) / 60) * 60);
  const hi = Math.min(24 * 60, Math.ceil(Math.max(shift ? shift.endMin + 60 : 19 * 60, ...outs) / 60) * 60);
  const ROW = 20;
  const m = { top: 22, right: 10, bottom: 6, left: 64 };
  const H = m.top + rows.length * ROW + m.bottom;
  const plotW = Math.max(0, width - m.left - m.right);
  const x = (min: number) => m.left + ((Math.min(Math.max(min, lo), hi) - lo) / Math.max(1, hi - lo)) * plotW;
  const step = hi - lo > 12 * 60 ? 180 : 120;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
  const lateAfter = shift ? shift.startMin + shift.graceMin : null;
  const hovered = hover !== null ? rows[hover] : null;

  return (
    <div className="space-y-2">
      <Legend
        items={[
          { key: 'sp', swatch: <Swatch color={c.within} />, label: t('First in → last out') },
          { key: 'ot', swatch: <Swatch color={c.overtime} />, label: t('After the shift') },
          ...(shift ? [{ key: 'win', swatch: <span className="inline-block h-2.5 w-4 rounded-[2px] bg-muted ring-1 ring-border" />, label: t('Shift {{from}} – {{to}}', { from: f.clock(shift.startMin), to: f.clock(shift.endMin) }) }] : []),
          ...(lateAfter !== null ? [{ key: 'la', swatch: <span className="inline-block h-3 border-l-2 border-dashed border-warning" />, label: t('Late after {{time}}', { time: f.clock(lateAfter) }) }] : []),
          { key: 'mk', swatch: <span className="inline-block size-2 rounded-full bg-warning" />, label: t('Late start / early leave') },
        ]}
      />
      <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={H} role="img" aria-label={t('When they worked each day')}>
            {shift && <rect x={x(shift.startMin)} y={m.top - 4} width={Math.max(0, x(shift.endMin) - x(shift.startMin))} height={rows.length * ROW + 4} rx={4} fill="var(--muted)" stroke="var(--border)" />}
            {ticks.map((v) => (
              <g key={v}>
                <line x1={x(v)} x2={x(v)} y1={m.top - 6} y2={H - m.bottom} stroke="var(--border)" strokeWidth={1} strokeOpacity={0.7} />
                {/* Edge labels anchor inwards so they are not cut off. */}
                <text x={x(v)} y={12} textAnchor={x(v) > width - m.right - 18 ? 'end' : x(v) < m.left + 18 ? 'start' : 'middle'} fontSize={10.5} fill="var(--muted-foreground)">
                  {f.clock(v)}
                </text>
              </g>
            ))}
            {lateAfter !== null && <line x1={x(lateAfter)} x2={x(lateAfter)} y1={m.top - 6} y2={H - m.bottom} stroke="var(--warning)" strokeWidth={1.5} strokeDasharray="4 3" />}
            {rows.map((r, i) => {
              const cy = m.top + i * ROW + ROW / 2;
              const inMin = r.firstIn ? minutesOfDayLocal(r.firstIn) : null;
              const outMin = r.lastOut ? minutesOfDayLocal(r.lastOut) : null;
              const endMin = outMin ?? inMin;
              const otStart = shift && outMin !== null && r.overtimeMin > 0 && outMin > shift.endMin ? Math.max(shift.endMin, inMin ?? shift.endMin) : null;
              return (
                <g key={r.day}>
                  {hover === i && <rect x={0} y={cy - ROW / 2} width={width} height={ROW} fill="var(--accent)" opacity={0.7} />}
                  <text x={6} y={cy + 3.5} fontSize={10.5} fill={r.status === 'DAY_OFF' ? 'var(--muted-foreground)' : 'var(--foreground)'}>
                    {weekdayShort(r.day)} {dayNum(r.day)}
                  </text>
                  {inMin !== null && endMin !== null ? (
                    <>
                      <rect x={x(inMin)} y={cy - 4} width={Math.max(3, x(otStart ?? endMin) - x(inMin))} height={8} rx={4} fill={c.within} />
                      {otStart !== null && outMin !== null && <rect x={x(otStart) + 2} y={cy - 4} width={Math.max(3, x(outMin) - x(otStart) - 2)} height={8} rx={4} fill={c.overtime} />}
                      {r.lateMin > 0 && <circle cx={x(inMin)} cy={cy} r={3.5} fill="var(--warning)" stroke="var(--card)" strokeWidth={1.5} />}
                      {r.earlyMin > 0 && outMin !== null && <circle cx={x(outMin)} cy={cy} r={3.5} fill="var(--warning)" stroke="var(--card)" strokeWidth={1.5} />}
                    </>
                  ) : (
                    <text x={m.left + plotW / 2} y={cy + 3.5} textAnchor="middle" fontSize={10.5} fontWeight={r.status === 'ABSENT' ? 700 : 400} fill={r.status === 'ABSENT' ? 'var(--destructive)' : 'var(--muted-foreground)'}>
                      {r.status === 'ABSENT' ? t('Absent') : r.status === 'DAY_OFF' ? t('Day off') : '—'}
                    </text>
                  )}
                  <rect
                    x={0}
                    y={cy - ROW / 2}
                    width={width}
                    height={ROW}
                    fill="transparent"
                    tabIndex={0}
                    aria-label={`${longDate(r.day)}: ${f.status(r)}${r.firstIn ? `, ${f.time(r.firstIn)} – ${r.lastOut ? f.time(r.lastOut) : ''}` : ''}`}
                    style={{ cursor: 'pointer', outline: 'none' }}
                    onMouseEnter={() => setHover(i)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                    onClick={() => onPick(r)}
                    onKeyDown={(e) => e.key === 'Enter' && onPick(r)}
                  />
                </g>
              );
            })}
          </svg>
        )}
        {hovered && hover !== null && <DayTooltip r={hovered} f={f} x={Math.min(width - 230, (hovered.lastOut ? x(minutesOfDayLocal(hovered.lastOut)) : m.left + 80))} y={m.top + hover * ROW + ROW} width={width} />}
      </div>
    </div>
  );
}
