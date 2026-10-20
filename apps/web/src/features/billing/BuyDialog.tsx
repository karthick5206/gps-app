import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import {
  API_PLAN_LABELS,
  API_PLANS,
  LICENCE_TYPE_LABELS,
  OFFLINE_PAYMENT_MODES,
  PAYMENT_MODE_LABELS,
  type ApiPlan,
  type CheckoutDto,
  type LicenceOverviewDto,
  type OfflinePaymentMode,
  type QuoteDto,
  SEAT_LICENCE_TYPES,
  type SeatLicenceType,
} from '@veetracer/shared';
import { BanknoteIcon, CreditCardIcon, ReceiptIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { api, errorMessage } from '@/lib/api';
import { openCheckout } from './razorpay';
import { formatDay, rupees, TYPE_ICONS } from './shared';

type Quantities = Record<SeatLicenceType, number>;
const ZERO: Quantities = { USER: 0, GPS_DEVICE: 0, DASHCAM: 0, FUEL_SENSOR: 0, MOBILE_TRACKER: 0 };

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** GST breakdown of a quote (CGST + SGST / CGST + UTGST / IGST). */
export function QuoteSummary({ quote }: { quote: QuoteDto }) {
  const { t } = useTranslation();
  const g = quote.gst;
  const half = g.ratePct / 2;
  const taxes: [string, number][] =
    g.kind === 'IGST'
      ? [[`IGST ${g.ratePct}%`, g.igstPaise]]
      : [
          [`CGST ${half}%`, g.cgstPaise],
          [`${g.kind === 'CGST_UTGST' ? 'UTGST' : 'SGST'} ${half}%`, g.sgstPaise],
        ];
  return (
    <div className="space-y-2 rounded-lg border p-3 text-sm">
      {quote.lines.map((l, i) => (
        <div key={i} className="flex justify-between gap-3">
          <span>
            {l.quantity} × {t(LICENCE_TYPE_LABELS[l.type])}
            {l.plan ? ` (${t(API_PLAN_LABELS[l.plan])})` : ''} {l.kind === 'RENEWAL' ? t('renewal') : ''}
            <span className="block text-xs text-muted-foreground">
              {formatDay(l.periodFrom)} – {formatDay(l.periodTo)}
            </span>
          </span>
          <span className="tabular-nums">{rupees(l.amountPaise)}</span>
        </div>
      ))}
      <div className="space-y-1 border-t pt-2 text-muted-foreground">
        <div className="flex justify-between">
          <span>{t('Taxable value')}</span>
          <span className="tabular-nums">{rupees(g.taxablePaise)}</span>
        </div>
        {taxes.map(([label, v]) => (
          <div key={label} className="flex justify-between">
            <span>{label}</span>
            <span className="tabular-nums">{rupees(v)}</span>
          </div>
        ))}
      </div>
      <div className="flex justify-between border-t pt-2 font-semibold">
        <span>{t('Total (GST inclusive)')}</span>
        <span className="tabular-nums">{rupees(g.totalPaise)}</span>
      </div>
    </div>
  );
}

/**
 * Buy new licences and / or renew selected seats. `mode="pay"`: the customer / partner pays online (Razorpay) or
 * sees the pay-offline instructions. `mode="record"`: a Super Admin / partner records a cash, UPI, bank or cheque payment.
 */
export function BuyDialog({
  open,
  onOpenChange,
  overview,
  basePath,
  recordPath,
  renewSeatIds,
  mode,
  onDone,
  initialApiPlan,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  overview: LicenceOverviewDto;
  basePath: string;
  recordPath?: string;
  renewSeatIds: string[];
  mode: 'pay' | 'record';
  onDone: () => void;
  /** Preselect a Developer API plan (link from the Developer API page). */
  initialApiPlan?: ApiPlan | null;
}) {
  const { t } = useTranslation();
  const [qty, setQty] = useState<Quantities>(ZERO);
  const [apiPlan, setApiPlan] = useState<ApiPlan | null>(initialApiPlan ?? null);
  const [apiQty, setApiQty] = useState(1);
  const isPartnerPool = overview.owner.kind === 'PARTNER';
  const currentApi = overview.apiAccess?.seat ?? null;
  const [payMode, setPayMode] = useState<OfflinePaymentMode>('BANK_TRANSFER');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(today());
  useEffect(() => {
    if (open) {
      setQty(ZERO);
      setApiPlan(initialApiPlan ?? null);
      setApiQty(1);
      setReference('');
      setPaidOn(today());
    }
  }, [open]);

  const body = useMemo(
    () => ({
      items: [
        ...SEAT_LICENCE_TYPES.filter((ty) => qty[ty] > 0).map((type) => ({ type, quantity: qty[type] })),
        ...(apiPlan ? [{ type: 'API_ACCESS' as const, quantity: isPartnerPool ? apiQty : 1, plan: apiPlan }] : []),
      ],
      renewSeatIds,
    }),
    [qty, renewSeatIds, apiPlan, apiQty, isPartnerPool],
  );
  const hasAny = body.items.length > 0 || renewSeatIds.length > 0;
  const quote = useQuery({
    queryKey: [basePath, 'quote', body],
    queryFn: () => api.post<QuoteDto>(`${basePath}/quote`, body),
    enabled: open && hasAny,
    placeholderData: keepPreviousData,
    retry: false,
  });

  const pay = useMutation({
    mutationFn: async () => {
      const order = await api.post<CheckoutDto>(`${basePath}/checkout`, body);
      const res = await openCheckout(order);
      if (!res) return 'cancelled' as const;
      const v = await api.post<{ status: 'PAID' | 'PENDING' }>(`${basePath}/checkout/verify`, {
        razorpayOrderId: res.razorpay_order_id,
        razorpayPaymentId: res.razorpay_payment_id,
        razorpaySignature: res.razorpay_signature,
      });
      return v.status;
    },
    onSuccess: (status) => {
      if (status === 'cancelled') return;
      toast.success(status === 'PAID' ? t('Payment received. Your licences are active and the invoice has been e-mailed.') : t('Payment received. Licences activate as soon as the bank confirms it.'));
      onOpenChange(false);
      onDone();
    },
  });

  const record = useMutation({
    mutationFn: () => api.post(recordPath!, { ...body, mode: payMode, reference: reference.trim() || undefined, paidOn, amountPaise: quote.data?.gst.totalPaise ?? 0 }),
    onSuccess: () => {
      toast.success(t('Payment recorded. Licences activated and invoice issued.'));
      onOpenChange(false);
      onDone();
    },
  });

  const busy = pay.isPending || record.isPending;
  const p = overview.payOffline;
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{mode === 'record' ? t('Record payment') : t('Buy or renew licences')}</DialogTitle>
          <DialogDescription>{t('Prices are per licence per year and include GST. Each licence runs 12 months from activation.')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          {!overview.billing.complete && <FormError message={t('Fill in the billing details (name, address, state and e-mail) before buying')} />}
          <div className="grid gap-3 sm:grid-cols-2">
            {SEAT_LICENCE_TYPES.map((type) => {
              const Icon = TYPE_ICONS[type];
              return (
                <Field key={type} label={`${t(LICENCE_TYPE_LABELS[type])} — ${rupees(overview.pricesPaise[type])}`} htmlFor={`qty-${type}`}>
                  <div className="flex items-center gap-2">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <Input
                      id={`qty-${type}`}
                      type="number"
                      min={0}
                      max={1000}
                      value={qty[type] || ''}
                      placeholder="0"
                      disabled={!overview.pricesPaise[type]}
                      onChange={(e) => setQty((q) => ({ ...q, [type]: Math.max(0, Math.min(1000, Math.floor(Number(e.target.value) || 0))) }))}
                    />
                  </div>
                </Field>
              );
            })}
          </div>
          <ApiPlanPicker overview={overview} plan={apiPlan} onPlan={setApiPlan} quantity={isPartnerPool ? apiQty : null} onQuantity={setApiQty} />
          {apiPlan && currentApi && !currentApi.locked && (
            <p className="text-sm text-muted-foreground">
              {t('Buying a plan replaces the current {{plan}} plan from today; the new plan runs 12 months. To keep the current plan, renew it from the licence list instead.', { plan: t(API_PLAN_LABELS[currentApi.plan]) })}
            </p>
          )}
          {renewSeatIds.length > 0 && <p className="text-sm text-muted-foreground">{t('{{n}} selected licence(s) will be renewed for 12 months.', { n: renewSeatIds.length })}</p>}
          {quote.isError && <FormError message={errorMessage(quote.error)} />}
          {hasAny && quote.data && <QuoteSummary quote={quote.data} />}
          {mode === 'record' && (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t('Payment mode')} htmlFor="pay-mode" required>
                <Select value={payMode} onValueChange={(v) => setPayMode(v as OfflinePaymentMode)}>
                  <SelectTrigger id="pay-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OFFLINE_PAYMENT_MODES.map((m) => (
                      <SelectItem key={m} value={m}>
                        {t(PAYMENT_MODE_LABELS[m])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t('Reference')} htmlFor="pay-ref" hint={t('UTR / cheque no. / receipt no.')}>
                <Input id="pay-ref" value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} />
              </Field>
              <Field label={t('Paid on')} htmlFor="pay-date" required>
                <Input id="pay-date" type="date" value={paidOn} max={today()} onChange={(e) => setPaidOn(e.target.value)} />
              </Field>
            </div>
          )}
          {mode === 'pay' && !overview.onlinePayment.enabled && hasAny && quote.data && (
            <div className="space-y-1 rounded-lg border border-dashed p-3 text-sm">
              <p className="font-medium">{t('Pay offline')}</p>
              <p className="text-muted-foreground">
                {t('Transfer {{amount}} to the account below and send us the reference. Your licences are activated and the invoice is e-mailed when the payment is recorded.', { amount: rupees(quote.data.gst.totalPaise) })}
              </p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                {[
                  [t('Account name'), p.bankAccountName || p.supplierName],
                  [t('Bank'), p.bankName],
                  [t('Account no.'), p.bankAccountNo],
                  [t('IFSC'), p.bankIfsc],
                  [t('Branch'), p.bankBranch],
                  [t('UPI ID'), p.upiId],
                ]
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="font-medium">{v}</dd>
                    </div>
                  ))}
              </dl>
            </div>
          )}
          <FormError message={pay.error ? errorMessage(pay.error) : record.error ? errorMessage(record.error) : null} />
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          {mode === 'record' ? (
            <Button disabled={!quote.data || !hasAny || busy || !overview.billing.complete} onClick={() => record.mutate()}>
              {record.isPending ? <Spinner /> : <ReceiptIcon />}
              {t('Record payment & issue invoice')}
            </Button>
          ) : overview.onlinePayment.enabled ? (
            <Button disabled={!quote.data || !hasAny || busy || !overview.billing.complete} onClick={() => pay.mutate()}>
              {pay.isPending ? <Spinner /> : <CreditCardIcon />}
              {quote.data ? t('Pay {{amount}}', { amount: rupees(quote.data.gst.totalPaise) }) : t('Pay')}
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              <BanknoteIcon />
              {t('Done')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Developer API plan choice (one per company; partner pools buy a quantity to allocate). */
function ApiPlanPicker({ overview, plan, onPlan, quantity, onQuantity }: { overview: LicenceOverviewDto; plan: ApiPlan | null; onPlan: (p: ApiPlan | null) => void; quantity: number | null; onQuantity: (n: number) => void }) {
  const { t } = useTranslation();
  const Icon = TYPE_ICONS.API_ACCESS;
  const limits = plan ? overview.apiPlans[plan] : null;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('Developer API plan')} htmlFor="api-plan" hint={limits ? t('{{vehicles}} vehicles · {{perMinute}}/min per key · {{perDay}}/day · {{webhooks}} webhook(s)', { vehicles: limits.maxVehicles ?? t('Unlimited'), perMinute: limits.ratePerMinute, perDay: limits.ratePerDay.toLocaleString('en-IN'), webhooks: limits.maxWebhooks }) : undefined}>
        <div className="flex items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <Select value={plan ?? 'none'} onValueChange={(v) => onPlan(v === 'none' ? null : (v as ApiPlan))}>
            <SelectTrigger id="api-plan">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t('No Developer API plan')}</SelectItem>
              {API_PLANS.map((p) => (
                <SelectItem key={p} value={p} disabled={!overview.apiPlans[p].pricePaise}>
                  {t(API_PLAN_LABELS[p])} — {rupees(overview.apiPlans[p].pricePaise)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Field>
      {quantity !== null && plan && (
        <Field label={t('Quantity')} htmlFor="api-qty">
          <Input id="api-qty" type="number" min={1} max={1000} value={quantity} onChange={(e) => onQuantity(Math.max(1, Math.min(1000, Math.floor(Number(e.target.value) || 1))))} />
        </Field>
      )}
    </div>
  );
}
