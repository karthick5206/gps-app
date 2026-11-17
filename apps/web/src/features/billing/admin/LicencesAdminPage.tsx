import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreditNoteDto, InvoiceDto, ProformaDto, ProformaStatus } from '@veetracer/shared';
import { DownloadIcon, EyeIcon, FileSpreadsheetIcon, FileTextIcon, QrCodeIcon, HandshakeIcon, ShieldCheckIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/multi-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/features/auth/auth-context';
import { api, downloadFile, errorMessage } from '@/lib/api';
import { CreditNotesTable, formatDay, InvoicesTable, rupees } from '../shared';
import { PdfPreviewDialog } from '../PdfPreviewDialog';
import { CreditNoteDialog } from './CreditNoteDialog';
import { AdminPartnersTab } from './AdminPartnersTab';
import { AdminPoolsTab, POOLS_QUERY, type PoolRow } from './AdminPoolsTab';
import { UpiClaimsTab } from './UpiClaimsTab';

const thisMonth = () => new Date().toISOString().slice(0, 7);

const PROFORMA_STATUS: Record<ProformaStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  OPEN: { label: 'Payment due', variant: 'default' },
  EXPIRED: { label: 'Expired', variant: 'outline' },
  PAID: { label: 'Paid', variant: 'secondary' },
  CANCELLED: { label: 'Cancelled', variant: 'outline' },
};

/** Saved pro-forma invoices (before payment): view on screen, download, cancel. Paid ones link to their tax invoice. */
function ProformasSection({ companyId, partnerId }: { companyId?: string; partnerId?: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [shown, setShown] = useState<ProformaDto | null>(null);
  const q = useQuery({
    queryKey: ['licences', 'admin', 'proformas', { companyId, partnerId }],
    queryFn: ({ signal }) => api.get<ProformaDto[]>('/licences/admin/proformas', { companyId, partnerId }, signal),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.post<ProformaDto>(`/licences/admin/proformas/${id}/cancel`, {}),
    onSuccess: (pf) => {
      toast.success(t('Pro-forma {{number}} cancelled.', { number: pf.number }));
      void queryClient.invalidateQueries({ queryKey: ['licences', 'admin', 'proformas'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const fileName = (pf: ProformaDto) => `Proforma-${pf.number.replace(/[^A-Za-z0-9-]+/g, '-')}.pdf`;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{t('Pro-forma invoices')}</h3>
      {q.isError && <FormError message={errorMessage(q.error)} />}
      <Card className="overflow-x-auto p-0">
        {q.isPending ? (
          <Skeleton className="m-4 h-20" />
        ) : !q.data?.length ? (
          <p className="p-4 text-sm text-muted-foreground">{t('No pro-forma invoices yet. Make one from Pools → a customer → Record payment → Pro-forma PDF.')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">{t('Pro-forma no')}</th>
                <th className="px-3 py-2">{t('Date')}</th>
                <th className="px-3 py-2">{t('Customer')}</th>
                <th className="px-3 py-2">{t('Licences')}</th>
                <th className="px-3 py-2 text-right">{t('Amount')}</th>
                <th className="px-3 py-2">{t('Valid until')}</th>
                <th className="px-3 py-2">{t('Status')}</th>
                <th className="px-3 py-2 text-right">{t('Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((pf) => (
                <tr key={pf.id} className="border-b last:border-0">
                  <td className="px-3 py-2 font-medium">{pf.number}</td>
                  <td className="px-3 py-2">{formatDay(pf.issuedAt)}</td>
                  <td className="px-3 py-2">{pf.buyerName}</td>
                  <td className="px-3 py-2 text-xs">{pf.summary}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {rupees(pf.totalPaise)}
                    {pf.discountPaise > 0 && <div className="text-xs text-muted-foreground">{t('{{amount}} off', { amount: rupees(pf.discountPaise) })}</div>}
                  </td>
                  <td className="px-3 py-2">{formatDay(pf.validUntil)}</td>
                  <td className="px-3 py-2">
                    <Badge variant={PROFORMA_STATUS[pf.status].variant}>{t(PROFORMA_STATUS[pf.status].label)}</Badge>
                    {pf.invoiceNumber && <div className="text-xs text-muted-foreground">{t('Invoice {{number}}', { number: pf.invoiceNumber })}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="outline" onClick={() => setShown(pf)}>
                        <EyeIcon />
                        {t('View')}
                      </Button>
                      <Button size="sm" variant="ghost" title={t('Download PDF')} onClick={() => downloadFile(`/licences/admin/proformas/${pf.id}/pdf`, fileName(pf)).catch((e) => toast.error(errorMessage(e)))}>
                        <DownloadIcon />
                      </Button>
                      {can('sa_licences', 'edit') && (pf.status === 'OPEN' || pf.status === 'EXPIRED') && (
                        <Button size="sm" variant="ghost" disabled={cancel.isPending} title={t('Cancel pro-forma')} onClick={() => window.confirm(t('Cancel pro-forma {{number}}?', { number: pf.number })) && cancel.mutate(pf.id)}>
                          <XIcon />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <p className="text-xs text-muted-foreground">{t('A pro-forma is not a tax invoice. When you record the payment for the same licences, it is marked Paid and linked to the tax invoice.')}</p>
      {shown && (
        <PdfPreviewDialog path={`/licences/admin/proformas/${shown.id}/pdf`} title={t('Pro-forma {{number}}', { number: shown.number })} fileName={fileName(shown)} onClose={() => setShown(null)} />
      )}
    </div>
  );
}

function AdminInvoicesTab({ pools }: { pools: PoolRow[] }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [crediting, setCrediting] = useState<InvoiceDto | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [owner, setOwner] = useState<string | null>(null);
  const [month, setMonth] = useState(thisMonth());
  const pool = pools.find((p) => `${p.kind}:${p.id}` === owner);
  const query = { from: from || undefined, to: to || undefined, companyId: pool?.kind === 'COMPANY' ? pool.id : undefined, partnerId: pool?.kind === 'PARTNER' ? pool.id : undefined };
  const q = useQuery({ queryKey: ['licences', 'admin', 'invoices', query], queryFn: ({ signal }) => api.get<InvoiceDto[]>('/licences/admin/invoices', query, signal) });
  const notes = useQuery({ queryKey: ['licences', 'admin', 'credit-notes', query], queryFn: ({ signal }) => api.get<CreditNoteDto[]>('/licences/admin/credit-notes', query, signal) });
  const exportCsv = useMutation({
    mutationFn: () => downloadFile(`/licences/admin/gst-summary?month=${month}`, `gst-summary-${month}.csv`),
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('From')} htmlFor="inv-from">
          <Input id="inv-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={t('To')} htmlFor="inv-to">
          <Input id="inv-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label={t('Company / partner')} className="min-w-64">
          <Combobox value={owner} onChange={setOwner} options={pools.map((p) => ({ value: `${p.kind}:${p.id}`, label: p.name }))} placeholder={t('All')} />
        </Field>
        {can('sa_licences', 'export') && (
          <div className="ml-auto flex items-end gap-2">
            <Field label={t('GST summary month')} htmlFor="gst-month">
              <Input id="gst-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
            </Field>
            <Button variant="outline" disabled={!month || exportCsv.isPending} onClick={() => exportCsv.mutate()}>
              {exportCsv.isPending ? <Spinner /> : <FileSpreadsheetIcon />}
              {t('Export GST summary (CSV)')}
            </Button>
          </div>
        )}
      </div>
      {q.isError && <FormError message={errorMessage(q.error)} />}
      <Card className="overflow-hidden p-0">
        {q.isPending ? (
          <Skeleton className="m-4 h-32" />
        ) : (
          <InvoicesTable invoices={q.data ?? []} pdfPath={(id) => `/licences/admin/invoices/${id}/pdf`} showBuyer onCredit={can('sa_licences', 'create') ? setCrediting : undefined} />
        )}
      </Card>
      {!!notes.data?.length && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">{t('Credit notes')}</h3>
          <Card className="overflow-hidden p-0">
            <CreditNotesTable notes={notes.data} pdfPath={(id) => `/licences/admin/credit-notes/${id}/pdf`} showBuyer />
          </Card>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t('Credit notes are numbered in their own series and included in the GST summary as negative rows.')}</p>
      <ProformasSection companyId={query.companyId} partnerId={query.partnerId} />
      {crediting && <CreditNoteDialog invoice={crediting} onClose={() => setCrediting(null)} onIssued={() => void queryClient.invalidateQueries({ queryKey: ['licences', 'admin'] })} />}
    </div>
  );
}

/** Platform → Licences & Invoices (Super Admin): every pool, offline payments, grants, partners, invoices, GST export. */
export function LicencesAdminPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const pools = useQuery({ queryKey: POOLS_QUERY, queryFn: ({ signal }) => api.get<PoolRow[]>('/licences/admin/pools', undefined, signal) });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['licences', 'admin'] });
  return (
    <div className="w-full space-y-6 p-4 sm:p-6">
      <PageHeader title={t('Licences & Invoices')} description={t('Licence pools of every company and partner, offline payments, complimentary seats, partners and GST invoices.')} />
      <Tabs defaultValue="pools">
        <TabsList>
          <TabsTrigger value="pools">
            <ShieldCheckIcon className="size-4" />
            {t('Pools')}
          </TabsTrigger>
          <TabsTrigger value="partners">
            <HandshakeIcon className="size-4" />
            {t('Partners')}
          </TabsTrigger>
          <TabsTrigger value="invoices">
            <FileTextIcon className="size-4" />
            {t('Invoices')}
          </TabsTrigger>
          <TabsTrigger value="upi">
            <QrCodeIcon className="size-4" />
            {t('Payments to confirm')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="pools" className="mt-4">
          <AdminPoolsTab pools={pools.data ?? []} loading={pools.isPending} error={pools.error} onChanged={refresh} />
        </TabsContent>
        <TabsContent value="partners" className="mt-4">
          <AdminPartnersTab pools={pools.data ?? []} />
        </TabsContent>
        <TabsContent value="invoices" className="mt-4">
          <AdminInvoicesTab pools={pools.data ?? []} />
        </TabsContent>
        <TabsContent value="upi" className="mt-4">
          <UpiClaimsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
