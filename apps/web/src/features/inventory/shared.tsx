import { useQueryClient } from '@tanstack/react-query';
import {
  INVENTORY_STATUS_LABELS,
  type DeviceStockDto,
  type InventoryStatus,
  type StockLocationDto,
  type StockMovementKind,
  type SupplierDto,
} from '@veetracer/shared';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Field } from '@/components/ui/field';
import type { Option } from '@/components/ui/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export type BadgeVariant = 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'muted' | 'outline' | 'info' | 'neutral';

export const STOCK_STATUS_VARIANT: Record<InventoryStatus, BadgeVariant> = {
  IN_STOCK: 'info',
  RESERVED: 'default',
  ASSIGNED: 'neutral',
  ACTIVE: 'success',
  FAULTY: 'destructive',
  UNDER_REPAIR: 'warning',
  RETURNED: 'outline',
  RETIRED: 'muted',
};

/** Chart colours per status (design tokens; readable in light and dark). */
export const STOCK_STATUS_COLOR: Record<InventoryStatus, string> = {
  IN_STOCK: 'var(--info)',
  RESERVED: 'var(--primary)',
  ASSIGNED: 'color-mix(in oklab, var(--success) 55%, var(--muted-foreground))',
  ACTIVE: 'var(--success)',
  FAULTY: 'var(--destructive)',
  UNDER_REPAIR: 'var(--warning)',
  RETURNED: 'color-mix(in oklab, var(--warning) 45%, var(--muted-foreground))',
  RETIRED: 'var(--muted-foreground)',
};

export const MOVEMENT_KIND_LABELS: Record<StockMovementKind, string> = {
  RECEIVE: 'Received',
  STATUS: 'Status change',
  TRANSFER: 'Transfer',
  ADJUST: 'Adjustment',
  SYNC: 'Synced with assignment',
  REPLACE: 'Replacement',
};

export const MOVEMENT_KIND_COLOR: Record<StockMovementKind, string> = {
  RECEIVE: 'var(--info)',
  STATUS: 'var(--warning)',
  TRANSFER: 'var(--primary)',
  ADJUST: 'var(--destructive)',
  SYNC: 'var(--success)',
  REPLACE: 'color-mix(in oklab, var(--primary) 50%, var(--destructive))',
};

export function StockStatusBadge({ status }: { status: InventoryStatus }) {
  const { t } = useTranslation();
  return <Badge variant={STOCK_STATUS_VARIANT[status]}>{t(INVENTORY_STATUS_LABELS[status])}</Badge>;
}

export function LicenceBadge({ licence }: { licence: DeviceStockDto['licence'] }) {
  const { t } = useTranslation();
  if (licence.status === 'NOT_IN_ACCOUNT') return <span className="text-muted-foreground">—</span>;
  const variant = licence.status === 'ACTIVE' ? 'success' : licence.status === 'EXPIRED' ? 'destructive' : 'warning';
  const label = licence.status === 'ACTIVE' ? 'Licensed' : licence.status === 'EXPIRED' ? 'Expired' : 'No seat';
  return <Badge variant={variant}>{t(label)}</Badge>;
}

export const locationOption = (l: StockLocationDto): Option => ({ value: l.id, label: `${l.code} · ${l.name}` });
export const supplierOption = (s: SupplierDto): Option => ({ value: s.id, label: s.name });

/** Cache keys of every inventory list / view, refreshed after any stock change. */
export const INVENTORY_ENDPOINTS = ['/inventory/stock', '/inventory/movements', '/inventory/receipts', '/inventory/locations', '/inventory/suppliers'];

export function useInvalidateInventory() {
  const qc = useQueryClient();
  return () => {
    for (const e of INVENTORY_ENDPOINTS) {
      void qc.invalidateQueries({ queryKey: ['master', e] });
      void qc.invalidateQueries({ queryKey: ['options', e] });
    }
    void qc.invalidateQueries({ queryKey: ['inventory'] });
  };
}

/** Labelled select for plain-state dialogs. */
export function PlainSelect({
  id,
  label,
  value,
  onChange,
  options,
  placeholder = 'Select…',
  required,
  hint,
  allowEmpty,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
  required?: boolean;
  hint?: string;
  allowEmpty?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const EMPTY = '__none';
  return (
    <Field label={t(label)} htmlFor={id} required={required} hint={hint && t(hint)} className={className}>
      <Select value={value || (allowEmpty ? EMPTY : '')} onValueChange={(v) => onChange(v === EMPTY ? '' : v)}>
        <SelectTrigger id={id}>
          <SelectValue placeholder={t(placeholder)} />
        </SelectTrigger>
        <SelectContent>
          {allowEmpty && <SelectItem value={EMPTY}>{t(allowEmpty)}</SelectItem>}
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {t(o.label)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** Row of status filter chips with counts; `null` = all. */
export function StatusChips<S extends string>({
  statuses,
  labels,
  counts,
  value,
  onChange,
  variant,
}: {
  statuses: readonly S[];
  labels: Record<S, string>;
  counts?: Partial<Record<S, number>>;
  value: S | null;
  onChange: (v: S | null) => void;
  variant?: Record<S, BadgeVariant>;
}) {
  const { t } = useTranslation();
  const total = counts ? Object.values(counts).reduce<number>((a, b) => a + ((b as number | undefined) ?? 0), 0) : undefined;
  const chip = (key: S | null, label: string, count: number | undefined) => {
    const active = value === key;
    return (
      <button
        key={key ?? '__all'}
        type="button"
        aria-pressed={active}
        onClick={() => onChange(key)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
          active ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        {key && variant && !active && <span className={cn('size-2 rounded-full', dotClass(variant[key]))} aria-hidden />}
        {t(label)}
        {count !== undefined && <span className={cn('tabular-nums', active ? 'opacity-90' : 'opacity-70')}>{count}</span>}
      </button>
    );
  };
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('Filter by status')}>
      {chip(null, 'All', total)}
      {statuses.map((s) => chip(s, labels[s], counts?.[s] ?? (counts ? 0 : undefined)))}
    </div>
  );
}

function dotClass(v: BadgeVariant): string {
  switch (v) {
    case 'success':
      return 'bg-success';
    case 'warning':
      return 'bg-warning';
    case 'destructive':
      return 'bg-destructive';
    case 'info':
      return 'bg-info';
    case 'default':
      return 'bg-primary';
    case 'muted':
    case 'outline':
      return 'bg-muted-foreground/60';
    default:
      return 'bg-muted-foreground';
  }
}

/** Definition list row used in detail drawers. */
export function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{t(label)}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** Summary tile (stat). */
export function StatTile({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'default' | 'warning' | 'destructive' | 'success' }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs font-medium text-muted-foreground">{t(label)}</p>
      <p
        className={cn(
          'mt-1 text-2xl font-semibold tabular-nums',
          tone === 'warning' && 'text-warning-fg',
          tone === 'destructive' && 'text-destructive-fg',
          tone === 'success' && 'text-success-fg',
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
