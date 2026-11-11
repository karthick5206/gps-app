import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ROLE_CLASS, stopRole } from './RouteMap';
import type { StopDraft, StopField, StopIssue } from './route-stops';

const numText = (n: number) => (Number.isFinite(n) ? String(n) : '');
const parseNum = (v: string) => (v.trim() === '' ? Number.NaN : Number(v));

function NumberBox({
  id,
  label,
  value,
  onChange,
  invalid,
  disabled,
  min,
  max,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (n: number) => void;
  invalid: boolean;
  disabled: boolean;
  min: number;
  max: number;
}) {
  return (
    <label htmlFor={id} className="grid min-w-0 gap-1">
      <span className="truncate text-[11px] font-medium text-muted-foreground">{label}</span>
      <Input id={id} type="number" inputMode="numeric" min={min} max={max} step={1} value={numText(value)} onChange={(e) => onChange(parseNum(e.target.value))} aria-invalid={invalid || undefined} disabled={disabled} className="h-8 px-2 tabular-nums" />
    </label>
  );
}

/**
 * Ordered stop list: number (same colour as the map marker), name, radius, arrival offset and wait, with move up /
 * down and delete. Rows are cards rather than table columns so the list fits a 375 px phone without scrolling sideways.
 */
export function StopList({
  stops,
  issues,
  selected,
  onSelect,
  onChange,
  onMove,
  onRemove,
  limits,
  readOnly = false,
}: {
  stops: StopDraft[];
  /** Issues to show (empty until the user tries to save, or always once shown). */
  issues: StopIssue[];
  selected: number | null;
  onSelect: (index: number) => void;
  onChange: (index: number, patch: Partial<StopDraft>) => void;
  onMove: (index: number, delta: number) => void;
  onRemove: (index: number) => void;
  limits: { radiusMinM: number; radiusMaxM: number; maxOffsetMin: number; maxWaitMin: number };
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLOListElement>(null);

  // A marker click selects its row: bring it into view.
  useEffect(() => {
    if (selected === null) return;
    listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selected]);

  const fieldIssue = (i: number, f: StopField) => issues.find((x) => x.index === i && x.field === f);

  return (
    <ol ref={listRef} className="space-y-2" aria-label={t('Stops')}>
      {stops.map((s, i) => {
        const rowIssues = issues.filter((x) => x.index === i);
        const role = stopRole(i, stops.length);
        return (
          <li
            key={s.key}
            data-index={i}
            className={cn('space-y-2 rounded-lg border bg-card p-2.5 transition-colors', selected === i && 'border-primary bg-primary/6', rowIssues.length > 0 && 'border-destructive/60')}
          >
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onSelect(i)}
                aria-label={t('Show stop {{n}} on the map', { n: i + 1 })}
                className={cn('flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold', ROLE_CLASS[role])}
              >
                {i + 1}
              </button>
              <Input
                value={s.name}
                onChange={(e) => onChange(i, { name: e.target.value })}
                onFocus={() => onSelect(i)}
                placeholder={role === 'start' ? t('Start') : role === 'end' ? t('End') : t('Stop name')}
                aria-label={t('Stop {{n}} name', { n: i + 1 })}
                aria-invalid={!!fieldIssue(i, 'name') || undefined}
                maxLength={100}
                disabled={readOnly}
                className="h-8 min-w-0 flex-1"
              />
              {!readOnly && (
                <>
                  <Button variant="ghost" size="icon-sm" aria-label={t('Move stop {{n}} up', { n: i + 1 })} disabled={i === 0} onClick={() => onMove(i, -1)}>
                    <ArrowUpIcon />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={t('Move stop {{n}} down', { n: i + 1 })} disabled={i === stops.length - 1} onClick={() => onMove(i, 1)}>
                    <ArrowDownIcon />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={t('Delete stop {{n}}', { n: i + 1 })} onClick={() => onRemove(i)} className="text-muted-foreground hover:text-destructive">
                    <Trash2Icon />
                  </Button>
                </>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <NumberBox
                id={`stop-${s.key}-radius`}
                label={t('Radius (m)')}
                value={s.radiusM}
                onChange={(n) => onChange(i, { radiusM: n })}
                invalid={!!fieldIssue(i, 'radiusM')}
                disabled={readOnly}
                min={limits.radiusMinM}
                max={limits.radiusMaxM}
              />
              <NumberBox
                id={`stop-${s.key}-offset`}
                label={t('Arrival (min)')}
                value={s.offsetMin}
                onChange={(n) => onChange(i, { offsetMin: n })}
                invalid={!!fieldIssue(i, 'offsetMin')}
                disabled={readOnly || i === 0}
                min={0}
                max={limits.maxOffsetMin}
              />
              <NumberBox
                id={`stop-${s.key}-wait`}
                label={t('Wait (min)')}
                value={s.waitMin}
                onChange={(n) => onChange(i, { waitMin: n })}
                invalid={!!fieldIssue(i, 'waitMin')}
                disabled={readOnly}
                min={0}
                max={limits.maxWaitMin}
              />
            </div>
            {Number.isFinite(s.offsetMin) && s.offsetMin >= 60 && rowIssues.length === 0 && (
              <p className="text-[11px] text-muted-foreground">{t('Arrives {{time}} after the start', { time: formatDuration(s.offsetMin * 60) })}</p>
            )}
            {rowIssues.map((x) => (
              <p key={`${x.field}-${x.message}`} role="alert" className="text-xs text-destructive">
                {t(x.message, x.vars)}
              </p>
            ))}
          </li>
        );
      })}
    </ol>
  );
}
