import { useMutation } from '@tanstack/react-query';
import {
  formatInr,
  LICENCE_TYPE_LABELS,
  LICENCE_TYPES,
  PAYMENT_MODE_LABELS,
  REFUND_MODE_LABELS,
  type CreditNoteDto,
  type InvoiceDto,
  type LicenceType,
  type SeatDto,
  type SeatStatus,
  type SeatSummaryDto,
} from '@veetracer/shared';
import { CarIcon, CctvIcon, CodeIcon, DownloadIcon, FileMinusIcon, FileTextIcon, FuelIcon, LockIcon, UserIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { downloadFile, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

export const rupees = (paise: number) => `₹${formatInr(paise)}`;

export const TYPE_ICONS: Record<LicenceType, typeof UserIcon> = { USER: UserIcon, GPS_DEVICE: CarIcon, DASHCAM: CctvIcon, FUEL_SENSOR: FuelIcon, API_ACCESS: CodeIcon };

export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

export function SeatStatusBadge({ status, assigned }: { status: SeatStatus; assigned: boolean }) {
  const { t } = useTranslation();
  if (status === 'EXPIRED') return <Badge variant="destructive"><LockIcon />{t('Expired')}</Badge>;
  if (status === 'GRACE') return <Badge variant="destructive">{t('In grace period')}</Badge>;
  if (status === 'EXPIRING') return <Badge variant="warning">{t('Expiring')}</Badge>;
  return assigned ? <Badge variant="success">{t('Active')}</Badge> : <Badge variant="muted">{t('Unassigned')}</Badge>;
}

export function SeatSummaryCards({ summary }: { summary: SeatSummaryDto[] }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {LICENCE_TYPES.map((type) => {
        const s = summary.find((x) => x.type === type) ?? { total: 0, used: 0, free: 0, expiring: 0, expired: 0 };
        const Icon = TYPE_ICONS[type];
        return (
          <Card key={type} className="space-y-2 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Icon className="size-4 text-primary" />
              {t(LICENCE_TYPE_LABELS[type])}
            </div>
            <div className="text-2xl font-semibold tabular-nums">
              {s.used}
              <span className="text-base font-normal text-muted-foreground"> / {s.total}</span>
            </div>
            <div className="flex flex-wrap gap-1.5 text-xs">
              <Badge variant="muted">{t('{{n}} free', { n: s.free })}</Badge>
              {s.expiring > 0 && <Badge variant="warning">{t('{{n}} expiring', { n: s.expiring })}</Badge>}
              {s.expired > 0 && <Badge variant="destructive">{t('{{n}} expired', { n: s.expired })}</Badge>}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/** Seat list; with `selected` / `onToggle` the rows can be picked for renewal. */
export function SeatsTable({
  seats,
  selected,
  onToggle,
  showOwner = false,
  empty,
}: {
  seats: SeatDto[];
  selected?: Set<string>;
  onToggle?: (id: string, on: boolean) => void;
  showOwner?: boolean;
  empty?: ReactNode;
}) {
  const { t } = useTranslation();
  if (!seats.length) return <>{empty ?? <EmptyState icon={FileTextIcon} title={t('No licences yet')} description={t('Buy licences to add users, devices and fuel sensors.')} />}</>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {onToggle && <TableHead className="w-8" />}
          <TableHead>{t('Licence')}</TableHead>
          {showOwner && <TableHead>{t('Pool')}</TableHead>}
          <TableHead>{t('Assigned to')}</TableHead>
          <TableHead>{t('Valid from')}</TableHead>
          <TableHead>{t('Expires on')}</TableHead>
          <TableHead>{t('Status')}</TableHead>
          <TableHead>{t('Source')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {seats.map((s) => {
          const Icon = TYPE_ICONS[s.type];
          return (
            <TableRow key={s.id}>
              {onToggle && (
                <TableCell>
                  <Checkbox aria-label={t('Select for renewal')} checked={selected?.has(s.id) ?? false} onCheckedChange={(v) => onToggle(s.id, v === true)} />
                </TableCell>
              )}
              <TableCell>
                <span className="inline-flex items-center gap-1.5">
                  <Icon className="size-4 text-muted-foreground" />
                  {t(LICENCE_TYPE_LABELS[s.type])}
                </span>
              </TableCell>
              {showOwner && <TableCell>{s.companyName ?? s.partnerName ?? '—'}</TableCell>}
              <TableCell>{s.subject ? s.subject.name : <span className="text-muted-foreground">{t('Free (unassigned)')}</span>}</TableCell>
              <TableCell>{formatDay(s.activatedAt)}</TableCell>
              <TableCell>{formatDay(s.expiresAt)}</TableCell>
              <TableCell>
                <SeatStatusBadge status={s.status} assigned={!!s.subject} />
              </TableCell>
              <TableCell className="text-xs text-muted-foreground" title={s.note ?? undefined}>
                {t(SOURCE_LABELS[s.source] ?? s.source)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

const SOURCE_LABELS: Record<string, string> = { PURCHASE: 'Purchased', MIGRATION: 'Complimentary (launch)', OVERRIDE: 'Complimentary', ALLOCATION: 'From partner' };

export function InvoicesTable({
  invoices,
  pdfPath,
  showBuyer = false,
  onCredit,
}: {
  invoices: InvoiceDto[];
  pdfPath: (id: string) => string;
  showBuyer?: boolean;
  /** Super Admin: open the credit note dialog for an invoice. */
  onCredit?: (inv: InvoiceDto) => void;
}) {
  const { t } = useTranslation();
  const download = useMutation({
    mutationFn: (inv: InvoiceDto) => downloadFile(pdfPath(inv.id), `Invoice-${inv.number.replace(/\//g, '-')}.pdf`),
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (!invoices.length) return <EmptyState icon={FileTextIcon} title={t('No invoices yet')} description={t('An invoice is issued and e-mailed for every payment.')} />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('Invoice no')}</TableHead>
          <TableHead>{t('Date')}</TableHead>
          {showBuyer && <TableHead>{t('Customer')}</TableHead>}
          <TableHead>{t('Payment')}</TableHead>
          <TableHead className="text-right">{t('Taxable value')}</TableHead>
          <TableHead className="text-right">{t('GST')}</TableHead>
          <TableHead className="text-right">{t('Total')}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoices.map((inv) => (
          <TableRow key={inv.id}>
            <TableCell className="font-medium">{inv.number}</TableCell>
            <TableCell title={formatDateTime(inv.issuedAt)}>{formatDay(inv.issuedAt)}</TableCell>
            {showBuyer && (
              <TableCell>
                {inv.buyerName}
                {inv.gstin && <div className="text-xs text-muted-foreground">{inv.gstin}</div>}
              </TableCell>
            )}
            <TableCell className="text-sm">
              {t(PAYMENT_MODE_LABELS[inv.paymentMode])}
              {inv.paymentReference && <div className="text-xs text-muted-foreground">{inv.paymentReference}</div>}
            </TableCell>
            <TableCell className="text-right tabular-nums">{rupees(inv.taxablePaise)}</TableCell>
            <TableCell className="text-right tabular-nums">{rupees(inv.cgstPaise + inv.sgstPaise + inv.utgstPaise + inv.igstPaise)}</TableCell>
            <TableCell className="text-right font-medium tabular-nums">
              {rupees(inv.totalPaise)}
              {inv.creditedPaise > 0 && <div className="text-xs font-normal text-destructive">{t('Credited {{amount}}', { amount: rupees(inv.creditedPaise) })}</div>}
            </TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-1">
                {onCredit && (
                  <Button size="sm" variant="ghost" onClick={() => onCredit(inv)}>
                    <FileMinusIcon />
                    {t('Credit note')}
                  </Button>
                )}
                <Button size="sm" variant="outline" disabled={download.isPending} onClick={() => download.mutate(inv)}>
                  {download.isPending && download.variables?.id === inv.id ? <Spinner /> : <DownloadIcon />}
                  {t('PDF')}
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Credit notes (against invoices) with PDF download. */
export function CreditNotesTable({ notes, pdfPath, showBuyer = false }: { notes: CreditNoteDto[]; pdfPath: (id: string) => string; showBuyer?: boolean }) {
  const { t } = useTranslation();
  const download = useMutation({
    mutationFn: (cn: CreditNoteDto) => downloadFile(pdfPath(cn.id), `CreditNote-${cn.number.replace(/\//g, '-')}.pdf`),
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (!notes.length) return null;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('Credit note no')}</TableHead>
          <TableHead>{t('Date')}</TableHead>
          <TableHead>{t('Against invoice')}</TableHead>
          {showBuyer && <TableHead>{t('Customer')}</TableHead>}
          <TableHead>{t('Reason')}</TableHead>
          <TableHead>{t('Refund')}</TableHead>
          <TableHead className="text-right">{t('Total')}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {notes.map((cn) => (
          <TableRow key={cn.id}>
            <TableCell className="font-medium">{cn.number}</TableCell>
            <TableCell title={formatDateTime(cn.issuedAt)}>{formatDay(cn.issuedAt)}</TableCell>
            <TableCell>{cn.invoiceNumber}</TableCell>
            {showBuyer && <TableCell>{cn.buyerName}</TableCell>}
            <TableCell className="max-w-64 truncate text-sm" title={cn.reason}>
              {cn.reason}
              {cn.revokedSeats > 0 && <div className="text-xs text-muted-foreground">{t('{{n}} licence(s) ended', { n: cn.revokedSeats })}</div>}
            </TableCell>
            <TableCell className="text-sm">
              {t(REFUND_MODE_LABELS[cn.refundMode])}
              {cn.refundReference && <div className="text-xs text-muted-foreground">{cn.refundReference}</div>}
            </TableCell>
            <TableCell className="text-right font-medium tabular-nums text-destructive">-{rupees(cn.totalPaise)}</TableCell>
            <TableCell className="text-right">
              <Button size="sm" variant="outline" disabled={download.isPending} onClick={() => download.mutate(cn)}>
                {download.isPending && download.variables?.id === cn.id ? <Spinner /> : <DownloadIcon />}
                {t('PDF')}
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
