import { useMutation, useQuery } from '@tanstack/react-query';
import { API_PLAN_LABELS, LICENCE_TYPE_LABELS, REFUND_MODE_LABELS, REFUND_MODES, toPaise, type CreditNoteDto, type InvoiceCreditsDto, type InvoiceDto, type RefundMode } from '@veetracer/shared';
import { FileMinusIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { CreditNotesTable, formatDay, rupees } from '../shared';

interface LineInput {
  quantity: number;
  /** Rupees, as typed; empty = unit price × quantity. */
  amount: string;
}

/** Super Admin: credit note against an invoice — choose lines / quantities (or an amount), reason, refund. */
export function CreditNoteDialog({ invoice, onClose, onIssued }: { invoice: InvoiceDto; onClose: () => void; onIssued: () => void }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['licences', 'admin', 'credits', invoice.id], queryFn: ({ signal }) => api.get<InvoiceCreditsDto>(`/licences/admin/invoices/${invoice.id}/credits`, undefined, signal) });
  const [inputs, setInputs] = useState<Record<number, LineInput>>({});
  const [reason, setReason] = useState('');
  const [refundMode, setRefundMode] = useState<RefundMode>('BANK_TRANSFER');
  const [reference, setReference] = useState('');
  const [keepSeats, setKeepSeats] = useState(false);

  const lines = useMemo(
    () =>
      (q.data?.lines ?? [])
        .map((l) => {
          const v = inputs[l.lineIndex];
          if (!v) return null;
          const amountPaise = v.amount.trim() ? toPaise(Number(v.amount)) : l.unitPaise * v.quantity;
          return amountPaise > 0 ? { lineIndex: l.lineIndex, quantity: v.quantity, amountPaise } : null;
        })
        .filter((x): x is { lineIndex: number; quantity: number; amountPaise: number } => !!x),
    [inputs, q.data],
  );
  const total = lines.reduce((a, l) => a + l.amountPaise, 0);
  const set = (i: number, patch: Partial<LineInput>) => setInputs((s) => ({ ...s, [i]: { ...{ quantity: 0, amount: '' }, ...s[i], ...patch } }));

  const issue = useMutation({
    mutationFn: () =>
      api.post<CreditNoteDto>(`/licences/admin/invoices/${invoice.id}/credit-notes`, {
        lines,
        reason: reason.trim(),
        refundMode,
        refundReference: reference.trim() || undefined,
        keepSeatsActive: keepSeats,
      }),
    onSuccess: (cn) => {
      toast.success(t('Credit note {{number}} issued and e-mailed', { number: cn.number }));
      onIssued();
      onClose();
    },
  });

  const remaining = q.data?.remainingPaise ?? 0;
  const valid = lines.length > 0 && reason.trim().length >= 3 && total <= remaining;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('Credit note against {{number}}', { number: invoice.number })}</DialogTitle>
          <DialogDescription>
            {t('Invoice total {{total}} · already credited {{credited}} · left {{left}}', { total: rupees(invoice.totalPaise), credited: rupees(q.data?.creditedPaise ?? 0), left: rupees(remaining) })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {q.isPending ? (
            <Skeleton className="h-32" />
          ) : q.isError ? (
            <FormError message={errorMessage(q.error)} />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Line')}</TableHead>
                    <TableHead className="text-right">{t('Left')}</TableHead>
                    <TableHead className="w-24">{t('Quantity')}</TableHead>
                    <TableHead className="w-32">{t('Amount (₹)')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {q.data.lines.map((l) => (
                    <TableRow key={l.lineIndex}>
                      <TableCell className="text-sm">
                        {t(LICENCE_TYPE_LABELS[l.type])}{l.plan ? ` (${t(API_PLAN_LABELS[l.plan])})` : ''} — {l.kind === 'RENEWAL' ? t('renewal') : t('new')} × {l.quantity}
                        <div className="text-xs text-muted-foreground">
                          {formatDay(l.periodFrom)} – {formatDay(l.periodTo)} · {rupees(l.unitPaise)}
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {l.remainingQuantity} · {rupees(l.remainingPaise)}
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          min={0}
                          max={l.remainingQuantity}
                          aria-label={t('Quantity')}
                          disabled={l.remainingPaise <= 0}
                          value={inputs[l.lineIndex]?.quantity || ''}
                          placeholder="0"
                          onChange={(e) => set(l.lineIndex, { quantity: Math.max(0, Math.min(l.remainingQuantity, Math.floor(Number(e.target.value) || 0))) })}
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          inputMode="decimal"
                          aria-label={t('Amount (₹)')}
                          disabled={l.remainingPaise <= 0}
                          value={inputs[l.lineIndex]?.amount ?? ''}
                          placeholder={inputs[l.lineIndex]?.quantity ? String((l.unitPaise * inputs[l.lineIndex].quantity) / 100) : '0'}
                          onChange={(e) => set(l.lineIndex, { amount: e.target.value.replace(/[^\d.]/g, '') })}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="text-xs text-muted-foreground">{t('Quantity = licences credited (unit price each). Enter an amount without a quantity for a price correction.')}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('Reason')} htmlFor="cn-reason" required className="sm:col-span-2">
                  <Input id="cn-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
                </Field>
                <Field label={t('Refund mode')} htmlFor="cn-mode" required>
                  <Select value={refundMode} onValueChange={(v) => setRefundMode(v as RefundMode)}>
                    <SelectTrigger id="cn-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {REFUND_MODES.map((m) => (
                        <SelectItem key={m} value={m}>
                          {t(REFUND_MODE_LABELS[m])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={t('Refund reference')} htmlFor="cn-ref" hint={t('UTR / cheque no. / Razorpay refund id')}>
                  <Input id="cn-ref" value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} />
                </Field>
              </div>
              <div className="flex items-start gap-2">
                <Checkbox id="cn-keep" checked={keepSeats} onCheckedChange={(v) => setKeepSeats(v === true)} />
                <Label htmlFor="cn-keep" className="text-sm font-normal">
                  {t('Keep the licences active (e.g. price correction). Otherwise the credited licences end now.')}
                </Label>
              </div>
              {q.data.creditNotes.length > 0 && (
                <div className="space-y-1">
                  <p className="text-sm font-semibold">{t('Credit notes')}</p>
                  <CreditNotesTable notes={q.data.creditNotes} pdfPath={(id) => `/licences/admin/credit-notes/${id}/pdf`} />
                </div>
              )}
            </>
          )}
          {total > remaining && <FormError message={t('The credit exceeds what is left to credit on this invoice')} />}
          <FormError message={issue.error ? errorMessage(issue.error) : null} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" disabled={issue.isPending} onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button variant="destructive" disabled={!valid || issue.isPending} onClick={() => issue.mutate()}>
            {issue.isPending ? <Spinner /> : <FileMinusIcon />}
            {total ? t('Issue credit note of {{amount}}', { amount: rupees(total) }) : t('Issue credit note')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
