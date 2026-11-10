import { SUPPLIER_PAYMENT_MODE_LABEL, SUPPLIER_PAYMENT_MODES, type StockDocDto, type SupplierPaymentMode } from '@veetracer/shared';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import { rupees, toPaise, toRupeesText } from './stock-api';

const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const STATUS: Record<string, { label: string; tone: 'success' | 'warning' | 'destructive' }> = { PAID: { label: 'Paid', tone: 'success' }, PART: { label: 'Part paid', tone: 'warning' }, UNPAID: { label: 'Unpaid', tone: 'warning' } };

/** Goods received (platform): what is owed to the supplier for this bill, the payments made, and "Record payment". */
export function SupplierBillPanel({ doc, act }: { doc: StockDocDto; act: (fn: () => Promise<unknown>) => void }) {
  const { t } = useTranslation();
  const bill = doc.supplierBill!;
  const [form, setForm] = useState<{ paidOn: string; amount: string; mode: SupplierPaymentMode; reference: string } | null>(null);
  const status = STATUS[bill.status];
  return (
    <div className="space-y-2 rounded-md border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{t('Payment to supplier')}:</span>
        <Badge variant={bill.overdue ? 'destructive' : status.tone}>{bill.overdue ? t('Overdue') : t(status.label)}</Badge>
        <span className="text-muted-foreground">
          {t('Bill {{amount}}', { amount: rupees(bill.amountPaise) })}
          {bill.returnsPaise > 0 && ` · ${t('less returns {{amount}}', { amount: rupees(bill.returnsPaise) })}`}
          {` · ${t('paid {{amount}}', { amount: rupees(bill.paidPaise) })}`}
        </span>
        {bill.duePaise > 0 && (
          <span className="font-semibold tabular-nums">
            {t('Due {{amount}} by {{date}}', { amount: rupees(bill.duePaise), date: bill.dueDate })}
          </span>
        )}
        {bill.duePaise > 0 && !form && (
          <Button size="sm" variant="outline" onClick={() => setForm({ paidOn: today(), amount: toRupeesText(bill.duePaise), mode: 'UPI', reference: '' })}>
            <PlusIcon /> {t('Record payment')}
          </Button>
        )}
      </div>
      {form && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('Paid on')} htmlFor="sp-on">
            <Input id="sp-on" type="date" className="w-40" max={today()} value={form.paidOn} onChange={(e) => setForm({ ...form, paidOn: e.target.value })} />
          </Field>
          <Field label={t('Amount (₹)')} htmlFor="sp-amt">
            <Input id="sp-amt" inputMode="decimal" className="w-32" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </Field>
          <Field label={t('How')} htmlFor="sp-mode">
            <Select value={form.mode} onValueChange={(v) => setForm({ ...form, mode: v as SupplierPaymentMode })}>
              <SelectTrigger id="sp-mode" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SUPPLIER_PAYMENT_MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {t(SUPPLIER_PAYMENT_MODE_LABEL[m])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('UTR / cheque no. (optional)')} htmlFor="sp-ref">
            <Input id="sp-ref" className="w-44" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          </Field>
          <Button
            size="sm"
            onClick={() => {
              const f = form;
              setForm(null);
              act(() => api.post(`/stock/docs/${doc.id}/supplier-payments`, { paidOn: f.paidOn, amountPaise: toPaise(f.amount), mode: f.mode, reference: f.reference }));
            }}
          >
            {t('Save payment')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
            {t('Cancel')}
          </Button>
        </div>
      )}
      {bill.payments.length > 0 && (
        <ul className="space-y-0.5 text-xs">
          {bill.payments.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2">
              <span className="tabular-nums">{p.paidOn}</span>
              <span className="font-medium tabular-nums">{rupees(p.amountPaise)}</span>
              <span>{t(SUPPLIER_PAYMENT_MODE_LABEL[p.mode] ?? p.mode)}</span>
              {p.reference && <span className="text-muted-foreground">{p.reference}</span>}
              <span className="text-muted-foreground">{p.createdByName}</span>
              <button
                type="button"
                aria-label={t('Remove payment')}
                className="text-muted-foreground hover:text-destructive"
                onClick={() => {
                  if (confirm(t('Remove this payment of {{amount}}? Use this only for a payment entered by mistake.', { amount: rupees(p.amountPaise) }))) act(() => api.delete(`/stock/supplier-payments/${p.id}`));
                }}
              >
                <Trash2Icon className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
