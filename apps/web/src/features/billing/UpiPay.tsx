import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpiClaimDto, UpiPayInfoDto } from '@veetracer/shared';
import { CheckCircle2Icon, QrCodeIcon, SmartphoneIcon } from 'lucide-react';
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

const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().slice(0, 10);
const isPhone = () => /Android|iPhone|iPad/i.test(navigator.userAgent);

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

/**
 * Buy screen, no online payment: QR (or "Pay with UPI app" on a phone) for the exact amount, then "I've paid" with
 * the UTR. Licences activate when VeeTrax confirms the payment.
 */
export function UpiPayBlock({ amountPaise, body, onSubmitted }: { amountPaise: number; body: { items: unknown[]; renewSeatIds: string[] }; onSubmitted: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [utr, setUtr] = useState('');
  const [paidOn, setPaidOn] = useState(today());
  const [ownQr, setOwnQr] = useState(false);
  const info = useQuery({
    queryKey: ['upi-info', amountPaise],
    queryFn: ({ signal }) => api.get<UpiPayInfoDto>('/licences/upi', { amountPaise }, signal),
    enabled: amountPaise > 0,
  });
  const claim = useMutation({
    mutationFn: () => api.post<UpiClaimDto>('/licences/upi-claims', { ...body, utr: utr.trim(), paidOn }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['upi-claims'] });
      onSubmitted();
    },
  });
  const d = info.data;
  if (info.isPending) return <Spinner />;
  if (!d?.enabled) return null;
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <p className="flex items-center gap-2 font-medium">
        <QrCodeIcon className="size-4" /> {t('Pay {{amount}} by UPI', { amount: rupees(amountPaise) })}
      </p>
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

const STATUS_VARIANT = { PENDING: 'warning', CONFIRMED: 'success', REJECTED: 'destructive' } as const;

/** Billing page: the customer's submitted UPI payments and their status. */
export function MyUpiClaims() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['upi-claims'], queryFn: ({ signal }) => api.get<UpiClaimDto[]>('/licences/upi-claims', undefined, signal) });
  if (!q.data?.length) return null;
  return (
    <div className="space-y-2 rounded-lg border p-3 text-sm">
      <p className="font-medium">{t('UPI payments')}</p>
      {q.data.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 first:border-t-0 first:pt-0">
          <span>
            {c.summary} · UTR {c.utr} · {formatDateTime(c.createdAt)}
          </span>
          <Badge variant={STATUS_VARIANT[c.status]}>{c.status === 'PENDING' ? t('Awaiting confirmation') : c.status === 'CONFIRMED' ? t('Confirmed') : t('Rejected')}</Badge>
          {c.note && <span className="w-full text-xs text-muted-foreground">{c.note}</span>}
        </div>
      ))}
    </div>
  );
}
