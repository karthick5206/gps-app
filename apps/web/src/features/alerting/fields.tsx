import type { AlertLevel } from '@veetracer/shared';
import { RotateCcwIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { isOverriddenHere, sourceText, type SourceRef } from './inheritance';

/** "Set here" / "Inherited from Branch: Chennai" / "Default" badge plus a Reset button when overridden at this level. */
export function SourceBadge({ source, level, onReset, disabled, className }: { source: SourceRef | undefined; level: AlertLevel; onReset?: () => void; disabled?: boolean; className?: string }) {
  const { t } = useTranslation();
  const here = isOverriddenHere(source, level);
  const text = sourceText(source, level, (k, v) => t(k, v));
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      <Badge variant={here ? 'default' : 'muted'} className="max-w-[14rem] truncate font-normal" title={text}>
        {text}
      </Badge>
      {here && onReset && (
        <Tooltip content={t('Reset to inherited')}>
          <Button variant="ghost" size="icon-sm" className="size-6" aria-label={t('Reset to inherited')} onClick={onReset} disabled={disabled}>
            <RotateCcwIcon className="size-3.5" />
          </Button>
        </Tooltip>
      )}
    </span>
  );
}

/**
 * Number input that commits on blur/Enter. Empty means "inherit": the inherited value shows as the placeholder,
 * and clearing an overridden value resets it.
 */
export function CommitNumber({
  id,
  value,
  placeholder,
  min,
  max,
  unit,
  onCommit,
  disabled,
  className,
}: {
  id?: string;
  value: number | null;
  placeholder?: string;
  min?: number;
  max?: number;
  unit?: string;
  onCommit: (v: number | null) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { t: tr } = useTranslation();
  const [text, setText] = useState(value === null ? '' : String(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(value === null ? '' : String(value));
    setError(null);
  }, [value]);

  const commit = () => {
    const t = text.trim();
    if (t === '') {
      setError(null);
      if (value !== null) onCommit(null);
      return;
    }
    const n = Number(t);
    if (!Number.isFinite(n)) return setError(tr('Enter a number'));
    if ((min !== undefined && n < min) || (max !== undefined && n > max)) return setError(`${min ?? '−∞'}–${max ?? '∞'}`);
    setError(null);
    if (n !== value) onCommit(n);
  };

  return (
    <div className={cn('grid gap-1', className)}>
      <div className="relative">
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          value={text}
          min={min}
          max={max}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={!!error}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
            if (e.key === 'Escape') setText(value === null ? '' : String(value));
          }}
          className={cn('h-8', unit && 'pr-12', value === null && 'placeholder:text-muted-foreground/90')}
        />
        {unit && <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">{unit}</span>}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** Label + control + source badge row used inside alert type cards. */
export function SettingRow({ label, hint, htmlFor, source, children, className }: { label: string; hint?: ReactNode; htmlFor?: string; source?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid content-start gap-1.5', className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <label htmlFor={htmlFor} className="text-[13px] font-medium">
          {label}
        </label>
        {source}
      </div>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
