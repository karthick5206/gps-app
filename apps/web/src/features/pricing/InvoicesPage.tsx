import { INVOICE_STATUSES, PAYMENT_STATUSES, type BranchDto, type CustomerInvoiceSummaryDto, type GenerateInvoiceRequest, type GenerateInvoiceResponse, type PricingPage } from '@veetracer/shared';
import { FilePlusIcon, ReceiptIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { newIdempotencyKey, P, postIdempotent, useContractOptions, usePricingMutation, usePricingQuery } from './pricing-api';
import { Empty, enumLabel, FilterBar, Labeled, Money, Pager, PricingShell, QueryView, ScrollTable, Sel, SimpleDialog, StatusPill, Td, Th, monthEnd, monthStart, todayYmd } from './ui';

const PAGE_SIZE = 25;

function GenerateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const navigate = useNavigate();
  const { contracts } = useContractOptions(open);
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: open && can('branches') });
  const today = todayYmd();
  const prev = monthStart(new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)).toISOString().slice(0, 10));
  const [form, setForm] = useState<GenerateInvoiceRequest>({ contractId: '', periodStart: prev, periodEnd: monthEnd(prev), branchId: null });
  // One key per dialog: a retry after a network error replays the same request instead of drafting twice.
  const [key] = useState(newIdempotencyKey);
  const consolidatedAllowed = me?.dataScope === 'COMPANY';
  const gen = usePricingMutation((b: GenerateInvoiceRequest) => postIdempotent<GenerateInvoiceResponse>(`${P}/invoices/generate`, b, key), {
    toastError: false,
    onSuccess: (r) => {
      const s = r.skipped;
      toast.success(r.replayed ? t('This invoice was already generated') : t('Draft invoice generated'), {
        description: s.needsReview + s.noPricing + s.errors ? t('Left out: {{review}} needing review, {{none}} without pricing, {{errors}} with errors.', { review: s.needsReview, none: s.noPricing, errors: s.errors }) : undefined,
      });
      onOpenChange(false);
      navigate(`/pricing/invoices/${r.invoice.id}`);
    },
  });
  const contractId = form.contractId || contracts[0]?.id || '';
  const valid = !!contractId && form.periodStart <= form.periodEnd && (consolidatedAllowed || !!form.branchId);
  return (
    <SimpleDialog open={open} onOpenChange={onOpenChange} title="Generate invoice" description="Drafts one invoice from the contract’s priced trips, closed availability periods and approved adjustments that are not invoiced yet. Trips needing review are left out." pending={gen.isPending} error={gen.error} submitLabel="Generate draft" onSubmit={() => valid && gen.mutate({ ...form, contractId })}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Labeled label="Contract" className="sm:col-span-2">{(id) => <Sel id={id} value={contractId} onChange={(v) => setForm({ ...form, contractId: v })} options={contracts.map((c) => ({ value: c.id, label: `${c.name} · ${c.customerName}` }))} />}</Labeled>
        <Labeled label="Period start">{(id) => <Input id={id} type="date" value={form.periodStart} onChange={(e) => setForm({ ...form, periodStart: e.target.value })} />}</Labeled>
        <Labeled label="Period end (inclusive)" error={form.periodStart > form.periodEnd ? 'Must be after the start date' : null}>
          {(id) => <Input id={id} type="date" value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })} />}
        </Labeled>
        {can('branches') && (
          <Labeled label="Branch" className="sm:col-span-2" hint={consolidatedAllowed ? 'Empty = one consolidated invoice for every branch.' : 'Choose your branch (consolidated invoices need a company-wide user).'}>
            {(id) => <Sel id={id} value={form.branchId ?? ''} allLabel={consolidatedAllowed ? 'Consolidated (all branches)' : 'Choose a branch'} onChange={(v) => setForm({ ...form, branchId: v || null })} options={branches.options} />}
          </Labeled>
        )}
      </div>
    </SimpleDialog>
  );
}

/** Pricing → Customer invoices (menu pricing_invoices). */
export function InvoicesPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const { contracts } = useContractOptions();
  const [page, setPage] = useState(1);
  const [generating, setGenerating] = useState(false);
  const status = params.get('status') ?? '';
  const paymentStatus = params.get('payment') ?? '';
  const contractId = params.get('contract') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
    setPage(1);
  };
  const list = usePricingQuery<PricingPage<CustomerInvoiceSummaryDto>>(['invoices'], `${P}/invoices`, { status: status || undefined, paymentStatus: paymentStatus || undefined, contractId: contractId || undefined, from: from || undefined, to: to || undefined, page, pageSize: PAGE_SIZE });
  return (
    <PricingShell
      title={t('Customer invoices')}
      description={t('Drafts, issued invoices, payments and credit notes. Issued invoices never change; corrections are credit notes.')}
      actions={
        can('pricing_invoices', 'create') && (
          <Button size="sm" onClick={() => setGenerating(true)}>
            <FilePlusIcon /> {t('Generate invoice')}
          </Button>
        )
      }
    >
      <FilterBar>
        <Labeled label="Status">{(id) => <Sel id={id} value={status} allLabel="All statuses" onChange={(v) => set('status', v)} options={INVOICE_STATUSES.map((s) => ({ value: s, label: t(enumLabel(s)) }))} />}</Labeled>
        <Labeled label="Payment">{(id) => <Sel id={id} value={paymentStatus} allLabel="Any" onChange={(v) => set('payment', v)} options={PAYMENT_STATUSES.map((s) => ({ value: s, label: t(enumLabel(s)) }))} />}</Labeled>
        <Labeled label="Contract">{(id) => <Sel id={id} value={contractId} allLabel="All contracts" onChange={(v) => set('contract', v)} options={contracts.map((c) => ({ value: c.id, label: c.name }))} />}</Labeled>
        <Labeled label="From">{(id) => <Input id={id} type="date" value={from} onChange={(e) => set('from', e.target.value)} />}</Labeled>
        <Labeled label="To">{(id) => <Input id={id} type="date" value={to} onChange={(e) => set('to', e.target.value)} />}</Labeled>
      </FilterBar>
      <QueryView query={list}>
        {(d) =>
          d.items.length === 0 ? (
            <Empty icon={ReceiptIcon} title="No invoices" description="Generate a draft from a contract and period, check it, then issue it." />
          ) : (
            <>
              <ScrollTable label={t('Customer invoices')} minWidth={900}>
                <thead>
                  <tr>
                    <Th>{t('Invoice')}</Th>
                    <Th>{t('Customer')}</Th>
                    <Th>{t('Period')}</Th>
                    <Th>{t('Status')}</Th>
                    <Th right>{t('Total')}</Th>
                    <Th right>{t('Balance')}</Th>
                    <Th>{t('Due')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((i) => (
                    <tr key={i.id} className="hover:bg-muted/40">
                      <Td>
                        <Link to={`/pricing/invoices/${i.id}`} className="font-medium text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                          {i.number ?? t('Draft')}
                        </Link>
                        <span className="block text-xs text-muted-foreground">{i.contractName}</span>
                      </Td>
                      <Td>
                        {i.customerName ?? '—'}
                        <span className="block text-xs text-muted-foreground">{i.consolidated ? t('Consolidated') : t('Branch')}</span>
                      </Td>
                      <Td className="whitespace-nowrap">
                        {i.periodStart} – {i.periodEnd}
                      </Td>
                      <Td>
                        <span className="flex flex-wrap gap-1">
                          <StatusPill status={i.status} />
                          {i.status === 'ISSUED' && <StatusPill status={i.paymentStatus} />}
                        </span>
                      </Td>
                      <Td right>
                        <Money minor={i.totalMinor} currency={i.currency} />
                      </Td>
                      <Td right>
                        <Money minor={i.balanceMinor} currency={i.currency} />
                      </Td>
                      <Td className="whitespace-nowrap">{i.dueDate ?? '—'}</Td>
                    </tr>
                  ))}
                </tbody>
              </ScrollTable>
              <Pager page={page} pageSize={PAGE_SIZE} total={d.total} onPage={setPage} />
            </>
          )
        }
      </QueryView>
      {generating && <GenerateDialog open={generating} onOpenChange={setGenerating} />}
    </PricingShell>
  );
}
