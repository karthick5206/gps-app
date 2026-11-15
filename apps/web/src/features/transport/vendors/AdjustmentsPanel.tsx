import { ADJUSTMENT_DEDUCTS, ADJUSTMENT_KINDS, ADJUSTMENT_LABEL, type AdjustmentKind, type VendorStatementDto } from '@veetracer/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import { Panel } from '@/features/dashboard/refresh/kit';
import { api, errorMessage } from '@/lib/api';

const inr = (n: number) => `${n < 0 ? '−' : ''}₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sel = 'h-9 rounded-md border border-input bg-card px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

/**
 * v1.16.13 statement adjustments for one vendor and month: not available days (deducted pro rata from a monthly fee
 * when no amount is given), penalties, toll / parking actuals (no GST), other extras and deductions. Each line is
 * audited and goes into the statement total.
 */
export function AdjustmentsPanel({ s }: { s: VendorStatementDto }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const editable = can('etms_billing', 'export');
  const [objectId, setObjectId] = useState('');
  const [kind, setKind] = useState<AdjustmentKind>('NOT_AVAILABLE');
  const [days, setDays] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['vendor-statement'] });
  const add = useMutation({
    mutationFn: () =>
      api.post('/transport/billing/adjustments', {
        month: s.month,
        vendorId: s.vendor.id,
        objectId: objectId || null,
        kind,
        days: kind === 'NOT_AVAILABLE' && days ? Number(days) : null,
        amount: amount ? Number(amount) : null,
        note: note || null,
      }),
    onSuccess: () => {
      toast.success(t('Adjustment added'));
      setDays('');
      setAmount('');
      setNote('');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/transport/billing/adjustments/${id}`),
    onSuccess: () => {
      toast.success(t('Adjustment removed'));
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const chosen = s.vehicles.find((v) => v.objectId === objectId);
  return (
    <Panel title={t('Adjustments')} subtitle={t('Not available days, penalties, toll / parking and other extras or deductions for this month')} id="bill-adjustments">
      {editable && (
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">{t('Vehicle')}</span>
            <select className={`${sel} w-56`} value={objectId} onChange={(e) => setObjectId(e.target.value)}>
              <option value="">{t('Whole vendor')}</option>
              {s.vehicles.map((v) => (
                <option key={v.objectId} value={v.objectId}>
                  {v.vehicle}
                  {v.idleDays ? ` (${t('{{n}} idle days', { n: v.idleDays })})` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">{t('Type')}</span>
            <select className={`${sel} w-52`} value={kind} onChange={(e) => setKind(e.target.value as AdjustmentKind)}>
              {ADJUSTMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {(ADJUSTMENT_DEDUCTS as readonly string[]).includes(k) ? '− ' : '+ '}
                  {t(ADJUSTMENT_LABEL[k])}
                </option>
              ))}
            </select>
          </label>
          {kind === 'NOT_AVAILABLE' && (
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">{t('Days')}</span>
              <Input type="number" min={0.5} max={31} step={0.5} value={days} onChange={(e) => setDays(e.target.value)} className="h-9 w-24" placeholder={chosen?.idleDays ? String(chosen.idleDays) : ''} />
            </label>
          )}
          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">{kind === 'NOT_AVAILABLE' ? t('₹ (empty = monthly fee per day)') : t('₹ amount')}</span>
            <Input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="h-9 w-40" />
          </label>
          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">{t('Note')}</span>
            <Input value={note} onChange={(e) => setNote(e.target.value)} className="h-9 w-56" maxLength={300} placeholder={t('e.g. breakdown 12–13 Nov')} />
          </label>
          <Button size="sm" onClick={() => add.mutate()} disabled={add.isPending || (kind === 'NOT_AVAILABLE' ? !days : !amount)}>
            <PlusIcon /> {t('Add')}
          </Button>
        </div>
      )}
      {s.adjustments.length ? (
        <ul className="divide-y rounded-lg border text-sm">
          {s.adjustments.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{t(ADJUSTMENT_LABEL[a.kind])}</span>
                {a.days ? ` · ${t('{{n}} day(s)', { n: a.days })}` : ''} · {a.vehicle ?? t('Whole vendor')}
                {a.note && <span className="block text-xs text-muted-foreground">{a.note}</span>}
              </span>
              <span className={a.amount < 0 ? 'font-medium text-destructive-fg tabular-nums' : 'font-medium tabular-nums'}>{inr(a.amount)}</span>
              {editable && (
                <Button size="icon-sm" variant="ghost" aria-label={t('Remove')} onClick={() => del.mutate(a.id)}>
                  <Trash2Icon />
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t('No adjustments for this month.')}</p>
      )}
    </Panel>
  );
}
