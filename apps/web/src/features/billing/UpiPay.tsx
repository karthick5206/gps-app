import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpiClaimDto, UpiPayInfoDto } from '@veetracer/shared';
import { BanknoteIcon, CheckCircle2Icon, QrCodeIcon, SmartphoneIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { api, errorMessage, fetchBlob } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().slice(0, 10);
const isPhone = () => /Android|iPhone|iPad/i.test(navigator.userAgent);

type PayProps = { amountPaise: number; body: { items: unknown[]; renewSeatIds: string[] }; onSubmitted: () => void };

/** The uploaded GPay / UPI QR image (authenticated fetch → object URL). */
function UpiImage() {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    fetchBlob('/licences/upi/qr-image')
      .then((b) => {
        if (cancelled) return;
        url = URL.createObjectURL(b);
        setSrc(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, []);
  return src ? <img src={src} alt="UPI QR" className="mx-auto max-h-64 rounded-md border" /> : null;
}

function useSubmitted(onSubmitted: () => void) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['upi-claims'] });
    onSubmitted();
  };
}

/**
 * Buy screen, no online payment: the customer chooses UPI (QR / "Pay with UPI app" for the exact amount, then the
 * UTR) or Cash (not everyone has a UPI app: already paid, or to be collected). Licences activate when VeeTrax
 * confirms the payment.
 */
export function UpiPayBlock(props: PayProps) {
  const { t } = useTranslation();
  const [method, setMethod] = useState<'UPI' | 'CASH'>('UPI');
  const info = useQuery({
    queryKey: ['upi-info', props.amountPaise],
    queryFn: ({ signal }) => api.get<UpiPayInfoDto>('/licences/upi', { amountPaise: props.amountPaise }, signal),
    enabled: props.amountPaise > 0,
  });
  if (info.isPending) return <Spinner />;
  const upi = info.data?.enabled ? info.data : null;
  const m = upi ? method : 'CASH';
  const methods: ('UPI' | 'CASH')[] = upi ? ['UPI', 'CASH'] : ['CASH'];
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex rounded-md bg-muted p-0.5" role="group" aria-label={t('How will you pay?')}>
        {methods.map((x) => (
          <button
            key={x}
            type="button"
            aria-pressed={m === x}
            onClick={() => setMethod(x)}
            className={cn('flex h-8 flex-1 items-center justify-center gap-1.5 rounded text-sm font-medium transition-colors', m === x ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
          >
            {x === 'UPI' ? <QrCodeIcon className="size-4" /> : <BanknoteIcon className="size-4" />}
            {x === 'UPI' ? t('UPI (GPay, PhonePe…)') : t('Cash')}
          </button>
        ))}
      </div>
      {m === 'UPI' && upi ? <UpiPart {...props} d={upi} /> : <CashPart {...props} />}
    </div>
  );
}

function UpiPart({ amountPaise, body, onSubmitted, d }: PayProps & { d: UpiPayInfoDto }) {
  const { t } = useTranslation();
  const done = useSubmitted(onSubmitted);
  const [utr, setUtr] = useState('');
  const [paidOn, setPaidOn] = useState(today());
  const [ownQr, setOwnQr] = useState(false);
  const claim = useMutation({
    mutationFn: () => api.post<UpiClaimDto>('/licences/upi-claims', { ...body, method: 'UPI', utr: utr.trim(), paidOn }),
    onSuccess: done,
  });
  return (
    <div className="space-y-3">
      <p className="font-medium">{t('Pay {{amount}} by UPI', { amount: rupees(amountPaise) })}</p>
      <div className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-center">
        <div className="flex flex-col items-center gap-1">
          {ownQr ? <UpiImage /> : d.svg && <div className="size-52 [&_svg]:size-full" dangerouslySetInnerHTML={{ __html: d.svg }} />}
          {d.hasImage && (
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => setOwnQr((x) => !x)}>
              {ownQr ? t('Show QR with the amount') : t('Show our GPay QR')}
            </button>
          )}
        </div>
        <div className="space-y-1 text-sm">
          <p>{t('Scan with GPay, PhonePe, Paytm or BHIM. The amount and note are filled in.')}</p>
          <p>
            {t('UPI ID')}: <span className="font-medium">{d.vpa}</span>
          </p>
          <p className="text-muted-foreground">{d.payeeName}</p>
          {d.uri && isPhone() && (
            <Button asChild size="sm" className="mt-1">
              <a href={d.uri}>
                <SmartphoneIcon /> {t('Pay with UPI app')}
              </a>
            </Button>
          )}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('UTR / transaction ID')} htmlFor="upi-utr" hint={t('12 digits, shown in your UPI app after paying')}>
          <Input id="upi-utr" inputMode="numeric" value={utr} maxLength={30} onChange={(e) => setUtr(e.target.value)} />
        </Field>
        <Field label={t('Paid on')} htmlFor="upi-date">
          <Input id="upi-date" type="date" value={paidOn} max={today()} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
      </div>
      <FormError message={claim.isError ? errorMessage(claim.error) : null} />
      <Button type="button" className="w-full" disabled={claim.isPending || utr.trim().length < 8} onClick={() => claim.mutate()}>
        {claim.isPending ? <Spinner /> : <CheckCircle2Icon />}
        {t("I've paid")}
      </Button>
      <p className="text-xs text-muted-foreground">{t('We check the payment and activate your licences, usually within a few hours. The GST invoice is emailed to you.')}</p>
    </div>
  );
}

/** Cash: already paid (receipt no. optional) or to be collected (where / when). */
function CashPart({ amountPaise, body, onSubmitted }: PayProps) {
  const { t } = useTranslation();
  const done = useSubmitted(onSubmitted);
  const [receipt, setReceipt] = useState('');
  const [note, setNote] = useState('');
  const [paidOn, setPaidOn] = useState(today());
  const claim = useMutation({
    mutationFn: () => api.post<UpiClaimDto>('/licences/upi-claims', { ...body, method: 'CASH', utr: receipt.trim() || undefined, customerNote: note.trim(), paidOn }),
    onSuccess: done,
  });
  return (
    <div className="space-y-3">
      <p className="font-medium">{t('Pay {{amount}} in cash', { amount: rupees(amountPaise) })}</p>
      <p className="text-sm">{t('Pay our representative or at our office. Tell us if you have already paid, or where and when we should collect it.')}</p>
      <Field label={t('Note')} htmlFor="cash-note" hint={t('e.g. "Paid to Ravi" or "Collect at my shop, Anna Nagar, Monday 11 am", with your phone number')}>
        <Input id="cash-note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('Receipt no. (if you have one)')} htmlFor="cash-receipt">
          <Input id="cash-receipt" value={receipt} maxLength={30} onChange={(e) => setReceipt(e.target.value)} />
        </Field>
        <Field label={t('Date')} htmlFor="cash-date">
          <Input id="cash-date" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
      </div>
      <FormError message={claim.isError ? errorMessage(claim.error) : null} />
      <Button type="button" className="w-full" disabled={claim.isPending || !note.trim()} onClick={() => claim.mutate()}>
        {claim.isPending ? <Spinner /> : <BanknoteIcon />}
        {t('Submit cash payment')}
      </Button>
      <p className="text-xs text-muted-foreground">{t('Your licences are activated once we have received the cash. The GST invoice is emailed to you.')}</p>
    </div>
  );
}

const STATUS_VARIANT = { PENDING: 'warning', CONFIRMED: 'success', REJECTED: 'destructive' } as const;

/** Billing page: the customer's submitted UPI / cash payments and their status. */
export function MyUpiClaims() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['upi-claims'], queryFn: ({ signal }) => api.get<UpiClaimDto[]>('/licences/upi-claims', undefined, signal) });
  if (!q.data?.length) return null;
  return (
    <div className="space-y-2 rounded-lg border p-3 text-sm">
      <p className="font-medium">{t('Your payments')}</p>
      {q.data.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 first:border-t-0 first:pt-0">
          <span>
            {c.method === 'CASH' ? t('Cash') : 'UPI'} · {c.summary}
            {c.utr ? ` · ${c.method === 'CASH' ? t('Receipt') : 'UTR'} ${c.utr}` : ''} · {formatDateTime(c.createdAt)}
          </span>
          <Badge variant={STATUS_VARIANT[c.status]}>{c.status === 'PENDING' ? t('Awaiting confirmation') : c.status === 'CONFIRMED' ? t('Confirmed') : t('Rejected')}</Badge>
          {c.note && <span className="w-full text-xs text-muted-foreground">{c.note}</span>}
        </div>
      ))}
    </div>
  );
}
