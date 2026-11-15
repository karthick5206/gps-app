import { PAYMENT_METHODS, type BillingPaymentDto, type CreateCreditNoteRequest, type CustomerInvoiceDto, type InvoicePartySnapshot, type RecordPaymentRequest } from '@veetracer/shared';
import { useQuery } from '@tanstack/react-query';
import { BadgeCheckIcon, FileDownIcon, FileMinusIcon, HandCoinsIcon, Trash2Icon, Undo2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import { api, downloadFile } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { pricingErrorMessage } from './errors';
import { amountError, minorToMajorString } from './money';
import { P, pk, usePricingMutation } from './pricing-api';
import { enumLabel, Facts, Labeled, Money, PriceBreakdown, PricingShell, QueryView, ReasonDialog, ScrollTable, Section, Sel, SimpleDialog, StatusPill, Td, Th, todayYmd } from './ui';

function Party({ title, p }: { title: string; p: InvoicePartySnapshot }) {
  const { t } = useTranslation();
  return (
    <div className="min-w-0 text-sm">
      <p className="text-xs font-medium text-muted-foreground uppercase">{t(title)}</p>
      <p className="font-medium">{p.name}</p>
      {[p.address, [p.city, p.stateCode].filter(Boolean).join(' '), p.country, p.taxRegistration ? `${t('Tax reg.')} ${p.taxRegistration}` : null, p.email]
        .filter(Boolean)
        .map((x, i) => (
          <p key={i} className="text-muted-foreground">
            {x}
          </p>
        ))}
    </div>
  );
}

/** Pricing → Customer invoices → one invoice: lines, tax, payments, credit notes; issue, PDF, payment, credit note. */
export function InvoiceDetailPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: pk('invoice', id), queryFn: ({ signal }) => api.get<CustomerInvoiceDto>(`${P}/invoices/${id}`, undefined, signal), enabled: !!id });
  const [issuing, setIssuing] = useState(false);
  const [invoiceDate, setInvoiceDate] = useState(todayYmd());
  const [deleting, setDeleting] = useState(false);
  const [paying, setPaying] = useState(false);
  const [pay, setPay] = useState<RecordPaymentRequest>({ amount: '', receivedAt: todayYmd(), method: 'BANK_TRANSFER', reference: '', note: '' });
  const [reversing, setReversing] = useState<BillingPaymentDto | null>(null);
  const [crediting, setCrediting] = useState(false);
  const [creditAmount, setCreditAmount] = useState('');
  const [pdfBusy, setPdfBusy] = useState(false);
  const inv = q.data;
  const issue = usePricingMutation(() => api.post(`${P}/invoices/${id}/issue`, { invoiceDate }), { success: 'Invoice issued', toastError: false, onSuccess: () => setIssuing(false) });
  const del = usePricingMutation(() => api.delete(`${P}/invoices/${id}`), { success: 'Draft invoice deleted', onSuccess: () => navigate('/pricing/invoices') });
  const record = usePricingMutation(() => api.post(`${P}/invoices/${id}/payments`, { ...pay, amount: pay.amount.trim(), receivedAt: new Date(`${pay.receivedAt}T12:00:00`).toISOString(), reference: pay.reference || null, note: pay.note || null }), { success: 'Payment recorded', toastError: false, onSuccess: () => setPaying(false) });
  const reverse = usePricingMutation((reason: string) => api.post(`${P}/payments/${reversing!.id}/reverse`, { reason }), { success: 'Payment reversed', toastError: false, onSuccess: () => setReversing(null) });
  const credit = usePricingMutation((reason: string) => api.post(`${P}/invoices/${id}/credit-notes`, { reason, amount: creditAmount.trim() || null } satisfies CreateCreditNoteRequest), { success: 'Credit note issued', toastError: false, onSuccess: () => setCrediting(false) });
  const pdf = async () => {
    if (!inv) return;
    setPdfBusy(true);
    try {
      await downloadFile(`${P}/invoices/${inv.id}/pdf`, `${inv.number ?? inv.id}.pdf`);
    } catch (e) {
      toast.error(pricingErrorMessage(e, t));
    } finally {
      setPdfBusy(false);
    }
  };
  const payErr = inv && pay.amount.trim() ? amountError(pay.amount, inv.currency) : null;
  const creditErr = inv && creditAmount.trim() ? amountError(creditAmount, inv.currency) : null;

  return (
    <QueryView query={q}>
      {(i) => {
        const issued = i.status === 'ISSUED';
        const creditable = BigInt(i.totalMinor) - BigInt(i.creditedMinor);
        return (
          <PricingShell
            title={i.number ? t('Invoice {{n}}', { n: i.number }) : t('Draft invoice')}
            description={
              <span className="flex flex-wrap items-center gap-2">
                <StatusPill status={i.status} />
                {issued && <StatusPill status={i.paymentStatus} />}
                {i.customerName}
              </span>
            }
            actions={
              <>
                {!issued && can('pricing_invoices', 'command') && (
                  <Button size="sm" onClick={() => setIssuing(true)}>
                    <BadgeCheckIcon /> {t('Issue')}
                  </Button>
                )}
                {!issued && can('pricing_invoices', 'delete') && (
                  <Button size="sm" variant="outline" onClick={() => setDeleting(true)}>
                    <Trash2Icon /> {t('Delete draft')}
                  </Button>
                )}
                {issued && (
                  <Button size="sm" variant="outline" onClick={() => void pdf()} disabled={pdfBusy}>
                    <FileDownIcon /> PDF
                  </Button>
                )}
                {issued && can('pricing_invoices', 'edit') && (
                  <Button size="sm" variant="outline" onClick={() => (setPay({ amount: BigInt(i.balanceMinor) > 0n ? minorToMajorString(i.balanceMinor, i.currency) : '', receivedAt: todayYmd(), method: 'BANK_TRANSFER', reference: '', note: '' }), setPaying(true))}>
                    <HandCoinsIcon /> {t('Record payment')}
                  </Button>
                )}
                {issued && can('pricing_adjustments', 'approve') && creditable > 0n && (
                  <Button size="sm" variant="outline" onClick={() => (setCreditAmount(''), setCrediting(true))}>
                    <FileMinusIcon /> {t('Credit note')}
                  </Button>
                )}
              </>
            }
          >
            {!issued && <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">{t('Draft: check the lines, then issue. Issuing assigns the number and freezes the invoice.')}</p>}
            <Section>
              <div className="grid gap-4 md:grid-cols-3">
                <Party title="Supplier" p={i.supplier} />
                <Party title="Bill to" p={i.buyer} />
                <Facts
                  items={[
                    ['Period', `${i.periodStart} – ${i.periodEnd}`],
                    ['Invoice date', i.invoiceDate ?? '—'],
                    ['Due', i.dueDate ?? '—'],
                    ['Contract', i.contractName ?? '—'],
                    ['Scope', i.consolidated ? t('Consolidated') : t('Branch')],
                  ]}
                />
              </div>
            </Section>
            <Section title={t('Lines')}>
              <ScrollTable label={t('Invoice lines')} minWidth={760}>
                <thead>
                  <tr>
                    <Th>{t('Description')}</Th>
                    <Th>{t('Date')}</Th>
                    <Th right>{t('Quantity')}</Th>
                    <Th right>{t('Amount')}</Th>
                    <Th right>{t('Discount')}</Th>
                    <Th right>{t('Tax')}</Th>
                    <Th right>{t('Total')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {i.lines.map((l) => (
                    <tr key={l.id}>
                      <Td>
                        {l.description}
                        <span className="block text-xs text-muted-foreground">
                          {t(enumLabel(l.sourceType))}
                          {l.taxCode ? ` · ${l.taxCode}` : ''}
                        </span>
                      </Td>
                      <Td className="whitespace-nowrap">{l.serviceDate ?? '—'}</Td>
                      <Td right className="whitespace-nowrap">
                        {l.quantity} {l.unit}
                      </Td>
                      <Td right>
                        <Money minor={l.amountMinor} currency={i.currency} />
                      </Td>
                      <Td right>{l.discountMinor !== '0' ? <Money minor={`-${l.discountMinor}`} currency={i.currency} /> : '—'}</Td>
                      <Td right>
                        <Money minor={l.taxMinor} currency={i.currency} />
                      </Td>
                      <Td right className="font-medium">
                        <Money minor={l.totalMinor} currency={i.currency} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </ScrollTable>
              <div className="mt-3">
                <PriceBreakdown totalsOnly currency={i.currency} lines={[]} subtotalMinor={i.subtotalMinor} discountMinor={i.discountMinor} taxLines={i.taxLines} taxMinor={i.taxMinor} totalMinor={i.totalMinor} />
              </div>
              {issued && (
                <dl className="mt-2 ml-auto grid w-full max-w-sm grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">{t('Credited')}</dt>
                  <dd className="text-right">
                    <Money minor={i.creditedMinor === '0' ? '0' : `-${i.creditedMinor}`} currency={i.currency} />
                  </dd>
                  <dt className="text-muted-foreground">{t('Paid')}</dt>
                  <dd className="text-right">
                    <Money minor={i.paidMinor === '0' ? '0' : `-${i.paidMinor}`} currency={i.currency} />
                  </dd>
                  <dt className="border-t pt-1 font-semibold">{t('Balance')}</dt>
                  <dd className="border-t pt-1 text-right font-semibold">
                    <Money minor={i.balanceMinor} currency={i.currency} />
                  </dd>
                </dl>
              )}
            </Section>
            {issued && (
              <Section title={t('Payments')}>
                {i.payments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('No payments recorded.')}</p>
                ) : (
                  <ScrollTable label={t('Payments')} minWidth={640}>
                    <thead>
                      <tr>
                        <Th>{t('Received')}</Th>
                        <Th>{t('Method')}</Th>
                        <Th>{t('Reference')}</Th>
                        <Th right>{t('Amount')}</Th>
                        <Th />
                      </tr>
                    </thead>
                    <tbody>
                      {i.payments.map((p) => (
                        <tr key={p.id} className={p.reversedBy || p.reversalOf ? 'text-muted-foreground' : undefined}>
                          <Td className="whitespace-nowrap">{formatDateTime(p.receivedAt)}</Td>
                          <Td>
                            {t(enumLabel(p.method))}
                            {p.reversalOf && <span className="block text-xs">{t('Reversal')}</span>}
                            {p.reversedBy && <span className="block text-xs">{t('Reversed')}</span>}
                          </Td>
                          <Td className="text-xs">{[p.reference, p.note].filter(Boolean).join(' · ') || '—'}</Td>
                          <Td right>
                            <Money minor={p.amountMinor} currency={p.currency} />
                          </Td>
                          <Td right>
                            {can('pricing_invoices', 'edit') && !p.reversedBy && !p.reversalOf && (
                              <Button size="sm" variant="ghost" onClick={() => setReversing(p)}>
                                <Undo2Icon /> {t('Reverse')}
                              </Button>
                            )}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </ScrollTable>
                )}
              </Section>
            )}
            {i.creditNotes.length > 0 && (
              <Section title={t('Credit notes')}>
                <ScrollTable label={t('Credit notes')} minWidth={560}>
                  <thead>
                    <tr>
                      <Th>{t('Number')}</Th>
                      <Th>{t('Issued')}</Th>
                      <Th>{t('Reason')}</Th>
                      <Th right>{t('Tax')}</Th>
                      <Th right>{t('Total')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {i.creditNotes.map((c) => (
                      <tr key={c.id}>
                        <Td className="font-medium">{c.number}</Td>
                        <Td className="whitespace-nowrap">{formatDateTime(c.issuedAt)}</Td>
                        <Td className="text-xs">{c.reason}</Td>
                        <Td right>
                          <Money minor={c.taxMinor} currency={c.currency} />
                        </Td>
                        <Td right>
                          <Money minor={c.totalMinor} currency={c.currency} />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </ScrollTable>
              </Section>
            )}

            <SimpleDialog open={issuing} onOpenChange={setIssuing} title="Issue invoice" description="Issuing assigns the next invoice number and freezes the invoice and its trips: it can never be changed or deleted afterwards (corrections are credit notes)." pending={issue.isPending} error={issue.error} submitLabel="Issue invoice" onSubmit={() => issue.mutate(undefined)}>
              <Labeled label="Invoice date">{(fid) => <Input id={fid} type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />}</Labeled>
            </SimpleDialog>
            <ConfirmDialog open={deleting} onOpenChange={setDeleting} title={t('Delete draft invoice')} description={t('Its trips, periods and adjustments become available for the next invoice.')} destructive pending={del.isPending} onConfirm={() => del.mutate(undefined)} confirmLabel={t('Delete')} />
            <SimpleDialog open={paying} onOpenChange={setPaying} title="Record payment" pending={record.isPending} error={record.error} onSubmit={() => !payErr && pay.amount.trim() && record.mutate(undefined)}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Labeled label={`${t('Amount')} (${i.currency})`} error={payErr ?? (!pay.amount.trim() ? 'Required' : null)}>
                  {(fid) => <Input id={fid} inputMode="decimal" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} />}
                </Labeled>
                <Labeled label="Received on">{(fid) => <Input id={fid} type="date" value={pay.receivedAt} onChange={(e) => setPay({ ...pay, receivedAt: e.target.value })} />}</Labeled>
                <Labeled label="Method">{(fid) => <Sel id={fid} value={pay.method} onChange={(v) => setPay({ ...pay, method: v as RecordPaymentRequest['method'] })} options={PAYMENT_METHODS.map((m) => ({ value: m, label: t(enumLabel(m)) }))} />}</Labeled>
                <Labeled label="Reference">{(fid) => <Input id={fid} value={pay.reference ?? ''} maxLength={120} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />}</Labeled>
                <Labeled label="Note" className="sm:col-span-2">{(fid) => <Input id={fid} value={pay.note ?? ''} maxLength={500} onChange={(e) => setPay({ ...pay, note: e.target.value })} />}</Labeled>
              </div>
            </SimpleDialog>
            <ReasonDialog open={!!reversing} onOpenChange={(o) => !o && setReversing(null)} title="Reverse payment" description="Adds a reversal entry; the original payment stays in the ledger." destructive pending={reverse.isPending} error={reverse.error} onSubmit={(r) => reverse.mutate(r)} confirmLabel="Reverse" />
            <ReasonDialog open={crediting} onOpenChange={setCrediting} title="Issue credit note" description="A credit note reduces what the customer owes. Tax is split in proportion to the invoice." pending={credit.isPending} error={credit.error} canSubmit={!creditErr} onSubmit={(r) => credit.mutate(r)} confirmLabel="Issue credit note">
              <Labeled label={`${t('Amount including tax')} (${i.currency})`} error={creditErr} hint={t('Empty = full credit of {{amount}}', { amount: minorToMajorString(creditable.toString(), i.currency) })}>
                {(fid) => <Input id={fid} inputMode="decimal" value={creditAmount} onChange={(e) => setCreditAmount(e.target.value)} />}
              </Labeled>
            </ReasonDialog>
          </PricingShell>
        );
      }}
    </QueryView>
  );
}
