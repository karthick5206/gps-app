import { CheckIcon, ChevronsUpDownIcon, SearchIcon, XIcon } from 'lucide-react';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Spinner } from './spinner';

export interface Option {
  value: string;
  label: string;
  description?: string;
}

interface OptionPickerProps {
  options: Option[];
  /** When set, search is delegated (server-side); otherwise options are filtered locally by label. */
  onSearch?: (q: string) => void;
  loading?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  id?: string;
  invalid?: boolean;
  className?: string;
}

/** Remembers labels of every option ever seen so selected chips keep their names after a remote search. */
function useLabelCache(options: Option[], known: Option[] = []) {
  const cache = useRef(new Map<string, string>());
  for (const o of known) cache.current.set(o.value, o.label);
  for (const o of options) cache.current.set(o.value, o.label);
  return (value: string) => cache.current.get(value) ?? value;
}

function SearchableList({
  options,
  onSearch,
  loading,
  searchPlaceholder,
  emptyText,
  isSelected,
  onPick,
}: Pick<OptionPickerProps, 'options' | 'onSearch' | 'loading' | 'searchPlaceholder' | 'emptyText'> & {
  isSelected: (value: string) => boolean;
  onPick: (option: Option) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();

  const visible = useMemo(() => {
    if (onSearch || !query.trim()) return options;
    const q = query.trim().toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.description?.toLowerCase().includes(q));
  }, [options, query, onSearch]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, visible.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = visible[active];
      if (o) onPick(o);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b px-3">
        <SearchIcon className="size-4 text-muted-foreground" />
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            onSearch?.(e.target.value);
          }}
          onKeyDown={onKeyDown}
          placeholder={searchPlaceholder ?? t('Search…')}
          aria-controls={listId}
          className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {loading && <Spinner className="text-muted-foreground" />}
      </div>
      <ul id={listId} role="listbox" className="max-h-64 overflow-y-auto p-1">
        {visible.length === 0 && <li className="px-2 py-6 text-center text-sm text-muted-foreground">{loading ? t('Loading…') : (emptyText ?? t('No results'))}</li>}
        {visible.map((o, i) => {
          const selected = isSelected(o.value);
          return (
            <li
              key={o.value}
              role="option"
              aria-selected={selected}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(o)}
              className={cn(
                'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                i === active && 'bg-accent text-accent-foreground',
              )}
            >
              <span className={cn('flex size-4 items-center justify-center rounded-[4px] border', selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input')}>
                {selected && <CheckIcon className="size-3" strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.description && <span className="truncate text-xs text-muted-foreground">{o.description}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const triggerClass =
  'flex min-h-9 w-full items-center gap-2 rounded-lg border border-input bg-card px-3 py-1.5 text-left text-sm shadow-xs outline-none transition-[box-shadow,border-color] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive';

export function MultiSelect({
  value,
  onChange,
  selectedOptions,
  placeholder,
  disabled,
  id,
  invalid,
  className,
  ...listProps
}: OptionPickerProps & { value: string[]; onChange: (value: string[]) => void; selectedOptions?: Option[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const labelOf = useLabelCache(listProps.options, selectedOptions);
  const set = useMemo(() => new Set(value), [value]);

  const toggle = (o: Option) => onChange(set.has(o.value) ? value.filter((v) => v !== o.value) : [...value, o.value]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button type="button" id={id} aria-invalid={invalid || undefined} className={cn(triggerClass, className)}>
          <span className="flex min-w-0 flex-1 flex-wrap gap-1">
            {value.length === 0 && <span className="text-muted-foreground">{placeholder ?? t('Select…')}</span>}
            {value.map((v) => (
              <span key={v} className="inline-flex max-w-full items-center gap-1 rounded-md bg-secondary py-0.5 pr-1 pl-2 text-xs font-medium text-secondary-foreground">
                <span className="truncate">{labelOf(v)}</span>
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={t('Remove {{name}}', { name: labelOf(v) })}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(value.filter((x) => x !== v));
                  }}
                  className="rounded p-0.5 hover:bg-background/60"
                >
                  <XIcon className="size-3" />
                </span>
              </span>
            ))}
          </span>
          <ChevronsUpDownIcon className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-64 p-0">
        <SearchableList {...listProps} isSelected={(v) => set.has(v)} onPick={toggle} />
        {value.length > 0 && (
          <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
            <span>{t('{{count}} selected', { count: value.length })}</span>
            <button type="button" className="font-medium text-primary hover:underline" onClick={() => onChange([])}>
              {t('Clear')}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function Combobox({
  value,
  onChange,
  selectedOption,
  placeholder,
  clearable = true,
  disabled,
  id,
  invalid,
  className,
  ...listProps
}: OptionPickerProps & {
  value: string | null;
  onChange: (value: string | null) => void;
  selectedOption?: Option | null;
  clearable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();
  const labelOf = useLabelCache(listProps.options, selectedOption ? [selectedOption] : []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button type="button" id={id} aria-invalid={invalid || undefined} className={cn(triggerClass, 'h-9', className)}>
          <span className={cn('min-w-0 flex-1 truncate', !value && 'text-muted-foreground')}>{value ? labelOf(value) : (placeholder ?? t('Select…'))}</span>
          {clearable && value && (
            <span
              role="button"
              tabIndex={-1}
              aria-label={t('Clear selection')}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
              }}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent"
            >
              <XIcon className="size-3.5" />
            </span>
          )}
          <ChevronsUpDownIcon className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-64 p-0">
        <SearchableList
          {...listProps}
          isSelected={(v) => v === value}
          onPick={(o) => {
            onChange(o.value);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
