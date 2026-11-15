/**
 * Small building blocks shared by the Pricing screens: page shell, money, status badges, loading / error / empty
 * states, pager, native selects, a reason dialog and the price breakdown (lines, discounts, tax lines, total).
 */
import type { PriceLineDto, PricingIssue, TaxLineDto } from '@veetracer/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import { AlertTriangleIcon, ChevronLeftIcon, ChevronRightIcon, InboxIcon, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { currentLocale } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { pricingErrorMessage } from './errors';
import { formatMoney } from './money';

export function PricingShell({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-4 p-4 sm:p-6">
      <PageHeader title={title} description={description} actions={actions} />
      {children}
    </div>
  );
}

export function Money({ minor, currency, className }: { minor: string | null | undefined; currency: string; className?: string }) {
  return <span className={cn('tabular-nums', className)}>{formatMoney(minor, currency, currentLocale())}</span>;
}

/** Badge colour per status across contracts, versions, trip charges, periods, invoices, payments and adjustments. */
const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'info' | 'neutral' | 'muted' | 'secondary'> = {
  ACTIVE: 'success',
  APPROVED: 'success',
  PRICED: 'success',
  PAID: 'success',
  ISSUED: 'success',
  CLOSED: 'success',
  APPLIED: 'success',
  DONE: 'success',
  COVERED: 'info',
  INVOICED: 'info',
  ESTIMATE: 'info',
  OVERPAID: 'info',
  DRAFT: 'neutral',
  OPEN: 'neutral',
  PENDING_APPROVAL: 'warning',
  NEEDS_REVIEW: 'warning',
  PART: 'warning',
  SUSPENDED: 'warning',
  CLAIMED: 'warning',
  RUNNING: 'warning',
  UNPAID: 'destructive',
  REJECTED: 'destructive',
  ERROR: 'destructive',
  FAILED: 'destructive',
  NO_APPLICABLE_PRICING: 'destructive',
  EXPIRED: 'muted',
  SUPERSEDED: 'muted',
  VOID: 'muted',
  ENDED: 'muted',
};

/** Human label of an enum value: "PENDING_APPROVAL" → "Pending approval" (then translated). */
export const enumLabel = (v: string) => v.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export function StatusPill({ status, label }: { status: string; label?: string }) {
  const { t } = useTranslation();
  return <Badge variant={STATUS_VARIANT[status] ?? 'secondary'}>{t(label ?? enumLabel(status))}</Badge>;
}

export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

/** Loading → skeleton; error → mapped message with retry; else children(data). */
export function QueryView<T>({ query, children, rows }: { query: UseQueryResult<T>; children: (data: T) => ReactNode; rows?: number }) {
  const { t } = useTranslation();
  if (query.isPending) return <LoadingRows rows={rows} />;
  if (query.isError)
    return (
      <div className="space-y-2">
        <FormError message={pricingErrorMessage(query.error, t)} />
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          {t('Try again')}
        </Button>
      </div>
    );
  return <>{children(query.data as T)}</>;
}

export function Empty({ icon = InboxIcon, title, description, action }: { icon?: LucideIcon; title: string; description?: string; action?: ReactNode }) {
  const { t } = useTranslation();
  return <EmptyState icon={icon} title={t(title)} description={description ? t(description) : undefined} action={action} />;
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return total ? <p className="text-xs text-muted-foreground">{t('{{count}} row(s)', { count: total })}</p> : null;
  return (
    <nav aria-label={t('Pages')} className="flex flex-wrap items-center gap-2 text-sm">
      <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t('Previous page')}>
        <ChevronLeftIcon />
      </Button>
      <span className="tabular-nums">{t('Page {{page}} of {{pages}}', { page, pages })}</span>
      <Button variant="outline" size="icon-sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={t('Next page')}>
        <ChevronRightIcon />
      </Button>
      <span className="text-xs text-muted-foreground">{t('{{count}} row(s)', { count: total })}</span>
    </nav>
  );
}

export const selectClass =
  'h-9 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:outline-none disabled:opacity-50';

/** Labelled control for filter bars and small forms (label above, full width on phones). */
export function Labeled({ label, children, className, error, hint }: { label: string; children: (id: string) => ReactNode; className?: string; error?: string | null; hint?: string }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className={cn('grid min-w-0 content-start gap-1 text-xs', className)}>
      <label htmlFor={id} className="font-medium text-muted-foreground">
        {t(label)}
      </label>
      {children(id)}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t(error)}
        </p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{t(hint)}</p>
      )}
    </div>
  );
}

export function Sel({ id, value, onChange, options, allLabel, className, disabled, ariaLabel }: { id?: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; allLabel?: string; className?: string; disabled?: boolean; ariaLabel?: string }) {
  const { t } = useTranslation();
  return (
    <select id={id} className={cn(selectClass, className)} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-label={ariaLabel}>
      {allLabel !== undefined && <option value="">{t(allLabel)}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Filter row: wraps on phones, never wider than the page. */
export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2 md:flex md:flex-wrap md:items-end [&>*]:md:w-48">{children}</div>;
}

/** Card section with title. */
export function Section({ title, description, actions, children, className }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('min-w-0 rounded-xl border bg-card p-4 shadow-xs sm:p-5', className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold">{title}</h2>}
            {description && <p className="text-xs text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Label / value grid for detail headers. */
export function Facts({ items }: { items: [string, ReactNode][] }) {
  const { t } = useTranslation();
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm min-[480px]:grid-cols-2 lg:grid-cols-3">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{t(k)}</dt>
          <dd className="break-words">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Dialog asking for a mandatory reason (plus optional extra fields as children). `onSubmit` receives the trimmed
 * reason; the dialog closes when the returned promise resolves.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  reasonLabel = 'Reason',
  reasonRequired = true,
  confirmLabel = 'Confirm',
  destructive,
  pending,
  error,
  onSubmit,
  children,
  canSubmit = true,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  reasonLabel?: string;
  reasonRequired?: boolean;
  confirmLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  error?: unknown;
  onSubmit: (reason: string) => void;
  children?: ReactNode;
  canSubmit?: boolean;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const id = useId();
  useEffect(() => {
    if (open) {
      setReason('');
      setTouched(false);
    }
  }, [open]);
  const missing = reasonRequired && !reason.trim();
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(title)}</DialogTitle>
          {description ? <DialogDescription>{typeof description === 'string' ? t(description) : description}</DialogDescription> : <DialogDescription className="sr-only">{t(title)}</DialogDescription>}
        </DialogHeader>
        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (missing || !canSubmit) return;
            onSubmit(reason.trim());
          }}
        >
          <DialogBody className="space-y-4">
            {error ? <FormError message={pricingErrorMessage(error, t)} /> : null}
            {children}
            <div className="grid gap-1.5">
              <label htmlFor={id} className="text-sm font-medium">
                {t(reasonLabel)}
                {reasonRequired && (
                  <span className="text-destructive" aria-hidden>
                    *
                  </span>
                )}
              </label>
              <Textarea id={id} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} aria-invalid={touched && missing} />
              {touched && missing && (
                <p role="alert" className="text-xs text-destructive">
                  {t('A reason is required.')}
                </p>
              )}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              {t('Cancel')}
            </Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={pending}>
              {pending && <Spinner />}
              {t(confirmLabel)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Generic small form dialog (fields as children, plain state in the caller). */
export function SimpleDialog({ open, onOpenChange, title, description, pending, error, onSubmit, submitLabel = 'Save', children, wide }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: ReactNode; pending?: boolean; error?: unknown; onSubmit: () => void; submitLabel?: string; children: ReactNode; wide?: boolean }) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className={wide ? 'max-w-3xl' : 'max-w-lg'}>
        <DialogHeader>
          <DialogTitle>{t(title)}</DialogTitle>
          {description ? <DialogDescription>{typeof description === 'string' ? t(description) : description}</DialogDescription> : <DialogDescription className="sr-only">{t(title)}</DialogDescription>}
        </DialogHeader>
        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <DialogBody className="space-y-4">
            {error ? <FormError message={pricingErrorMessage(error, t)} /> : null}
            {children}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner />}
              {t(submitLabel)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function Issues({ issues }: { issues: PricingIssue[] }) {
  const { t } = useTranslation();
  if (!issues.length) return null;
  return (
    <ul className="space-y-1 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-sm" aria-label={t('Issues')}>
      {issues.map((i, k) => (
        <li key={k} className="flex items-start gap-2">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning-fg" aria-hidden />
          <span>
            <span className="font-medium">{t(enumLabel(i.code))}</span>: {i.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Lines → discounts → tax lines → total, in the row currency. */
export function PriceBreakdown({ currency, lines, subtotalMinor, discountMinor, taxLines, taxMinor, totalMinor, totalsOnly }: { totalsOnly?: boolean; currency: string; lines: PriceLineDto[]; subtotalMinor: string; discountMinor: string; taxLines: TaxLineDto[]; taxMinor: string; totalMinor: string }) {
  const { t } = useTranslation();
  return (
    <div className="min-w-0 space-y-3">
      {!totalsOnly && (
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[560px] text-sm">
          <caption className="sr-only">{t('Price lines')}</caption>
          <thead className="bg-muted/50 text-xs text-muted-foreground uppercase">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                {t('Component')}
              </th>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                {t('Basis')}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                {t('Amount')}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                {t('Discount')}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                {t('Tax')}
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-3 text-center text-muted-foreground">
                  {t('No price lines')}
                </td>
              </tr>
            )}
            {lines.map((l, i) => (
              <tr key={i} className="border-t align-top">
                <td className="px-3 py-2">
                  <span className="font-medium">{l.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {l.quantity} {l.unit}
                    {l.taxCode ? ` · ${l.taxCode}` : ''}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{l.basis}</td>
                <td className="px-3 py-2 text-right">
                  <Money minor={l.amountMinor} currency={currency} />
                </td>
                <td className="px-3 py-2 text-right">{l.discountMinor !== '0' ? <Money minor={`-${l.discountMinor}`} currency={currency} /> : '—'}</td>
                <td className="px-3 py-2 text-right">
                  <Money minor={l.taxMinor} currency={currency} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
      <dl className="ml-auto grid w-full max-w-sm grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t('Subtotal')}</dt>
        <dd className="text-right">
          <Money minor={subtotalMinor} currency={currency} />
        </dd>
        {discountMinor !== '0' && (
          <>
            <dt className="text-muted-foreground">{t('Discounts')}</dt>
            <dd className="text-right">
              <Money minor={`-${discountMinor}`} currency={currency} />
            </dd>
          </>
        )}
        {taxLines.map((x) => (
          <TaxRows key={x.taxCode} line={x} currency={currency} />
        ))}
        {taxLines.length === 0 && (
          <>
            <dt className="text-muted-foreground">{t('Tax')}</dt>
            <dd className="text-right">
              <Money minor={taxMinor} currency={currency} />
            </dd>
          </>
        )}
        <dt className="border-t pt-1 font-semibold">{t('Total')}</dt>
        <dd className="border-t pt-1 text-right font-semibold">
          <Money minor={totalMinor} currency={currency} />
        </dd>
      </dl>
    </div>
  );
}

function TaxRows({ line, currency }: { line: TaxLineDto; currency: string }) {
  const { t } = useTranslation();
  const pct = `${(line.ratePpm / 10_000).toLocaleString(undefined, { maximumFractionDigits: 4 })}%`;
  const split = (
    [
      ['CGST', line.cgstMinor],
      ['SGST', line.sgstMinor],
      ['UTGST', line.utgstMinor],
      ['IGST', line.igstMinor],
    ] as const
  ).filter(([, v]) => v !== undefined && v !== null && v !== '0');
  return (
    <>
      <dt className="text-muted-foreground">
        {line.label} {pct}
        <span className="block text-xs">
          {t('on')} <Money minor={line.taxableMinor} currency={currency} />
        </span>
      </dt>
      <dd className="text-right">
        <Money minor={line.taxMinor} currency={currency} />
        {split.map(([k, v]) => (
          <span key={k} className="block text-xs text-muted-foreground">
            {k} <Money minor={v!} currency={currency} />
          </span>
        ))}
      </dd>
    </>
  );
}

/** Table wrapper: scrolls horizontally inside its own box so the page never does. */
export function ScrollTable({ children, minWidth = 720, label }: { children: ReactNode; minWidth?: number; label?: string }) {
  return (
    <div className="w-full overflow-x-auto rounded-lg border" role="region" aria-label={label} tabIndex={0}>
      <table className="w-full text-sm" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export function Th({ children, right, className }: { children?: ReactNode; right?: boolean; className?: string }) {
  return (
    <th scope="col" className={cn('bg-muted/50 px-3 py-2 text-xs font-medium tracking-wide whitespace-nowrap text-muted-foreground uppercase', right ? 'text-right' : 'text-left', className)}>
      {children}
    </th>
  );
}

export function Td({ children, right, className, colSpan }: { children?: ReactNode; right?: boolean; className?: string; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className={cn('border-t px-3 py-2 align-top', right && 'text-right', className)}>
      {children}
    </td>
  );
}

/** Today's date (YYYY-MM-DD) in the browser's zone; the server re-checks every date. */
export function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function monthStart(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}
export function monthEnd(ymd: string): string {
  const [y, m] = ymd.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ymd.slice(0, 7)}-${String(last).padStart(2, '0')}`;
}
