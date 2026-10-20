import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreditNoteDto, InvoiceDto } from '@veetracer/shared';
import { FileSpreadsheetIcon, FileTextIcon, QrCodeIcon, HandshakeIcon, ShieldCheckIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
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
import { CreditNotesTable, InvoicesTable } from '../shared';
import { CreditNoteDialog } from './CreditNoteDialog';
import { AdminPartnersTab } from './AdminPartnersTab';
import { AdminPoolsTab, POOLS_QUERY, type PoolRow } from './AdminPoolsTab';
import { UpiClaimsTab } from './UpiClaimsTab';

const thisMonth = () => new Date().toISOString().slice(0, 7);

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
            {t('UPI payments')}
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
