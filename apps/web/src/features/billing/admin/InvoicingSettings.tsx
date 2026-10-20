import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatInvoiceNumber, financialYear, gstinError, type InvoicingSettingsDto } from '@veetracer/shared';
import { ImageUpIcon, SaveIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage, fetchBlob } from '@/lib/api';
import { StateSelect } from '../BillingProfileForm';

const QUERY = ['licences', 'settings', 'invoicing'];
type Form = Omit<InvoicingSettingsDto, 'hasLogo' | 'hasUpiQr' | 'addressLines'> & { address: string };

function Logo({ version, path = '/licences/settings/logo' }: { version: number; path?: string }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked: string | null = null;
    fetchBlob(path)
      .then((b) => {
        revoked = URL.createObjectURL(b);
        setUrl(revoked);
      })
      .catch(() => setUrl(null));
    return () => {
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [version]);
  return url ? <img src={url} alt={t('Invoice logo')} className="h-14 max-w-48 rounded border bg-white object-contain p-1" /> : null;
}

/** Platform Settings → Invoicing: supplier details printed on every tax invoice. */
export function InvoicingSettings() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [logoVersion, setLogoVersion] = useState(0);
  const q = useQuery({ queryKey: QUERY, queryFn: ({ signal }) => api.get<InvoicingSettingsDto>('/licences/settings/invoicing', undefined, signal) });
  const [form, setForm] = useState<Form | null>(null);
  useEffect(() => {
    if (q.data) {
      const { hasLogo: _h, hasUpiQr: _u, addressLines, ...rest } = q.data;
      setForm({ ...rest, address: addressLines.join('\n') });
    }
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => {
      const { address, ...rest } = form!;
      return api.put<InvoicingSettingsDto>('/licences/settings/invoicing', { ...rest, addressLines: address.split('\n').map((l) => l.trim()).filter(Boolean) });
    },
    onSuccess: (data) => {
      queryClient.setQueryData(QUERY, data);
      toast.success(t('Invoicing details saved'));
    },
  });
  const upload = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return api.upload<InvoicingSettingsDto>('/licences/settings/logo', fd);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(QUERY, data);
      setLogoVersion((v) => v + 1);
      toast.success(t('Logo uploaded'));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const upiRef = useRef<HTMLInputElement>(null);
  const [upiVersion, setUpiVersion] = useState(0);
  const uploadUpi = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return api.upload<InvoicingSettingsDto>('/licences/settings/upi-qr', fd);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(QUERY, data);
      setUpiVersion((v) => v + 1);
      toast.success(t('UPI QR uploaded'));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const removeUpi = useMutation({
    mutationFn: () => api.delete<InvoicingSettingsDto>('/licences/settings/upi-qr'),
    onSuccess: (data) => queryClient.setQueryData(QUERY, data),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const removeLogo = useMutation({
    mutationFn: () => api.delete<InvoicingSettingsDto>('/licences/settings/logo'),
    onSuccess: (data) => queryClient.setQueryData(QUERY, data),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const editable = can('sa_platform_settings', 'edit');
  if (q.isPending || (!form && !q.isError)) return <Skeleton className="h-96 w-full" />;
  if (q.isError || !form) return <FormError message={errorMessage(q.error)} />;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const text = (k: keyof Form, label: string, opts: { hint?: string; max?: number; upper?: boolean } = {}) => (
    <Field label={label} htmlFor={`inv-${k}`} hint={opts.hint}>
      <Input id={`inv-${k}`} value={form[k] as string} maxLength={opts.max ?? 160} disabled={!editable} onChange={(e) => set(k, (opts.upper ? e.target.value.toUpperCase() : e.target.value) as never)} />
    </Field>
  );
  const gstErr = form.gstin.trim() ? gstinError(form.gstin, form.stateCode) : null;
  return (
    <Card className="max-w-4xl p-4">
      <form
        className="grid gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!gstErr) save.mutate();
        }}
      >
        <section className="grid gap-4">
          <h3 className="font-medium">{t('Supplier (your business)')}</h3>
          <div className="flex flex-wrap items-center gap-3">
            {q.data.hasLogo && <Logo version={logoVersion} />}
            {editable && (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) upload.mutate(f);
                    e.target.value = '';
                  }}
                />
                <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
                  {upload.isPending ? <Spinner /> : <ImageUpIcon />}
                  {q.data.hasLogo ? t('Change logo') : t('Upload logo')}
                </Button>
                {q.data.hasLogo && (
                  <Button type="button" variant="ghost" onClick={() => removeLogo.mutate()} disabled={removeLogo.isPending}>
                    <Trash2Icon />
                    {t('Remove logo')}
                  </Button>
                )}
                <span className="text-xs text-muted-foreground">{t('PNG, JPG or SVG, up to 1 MB. Shown at the top of invoices.')}</span>
              </>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {text('legalName', t('Legal name'), { max: 200 })}
            <Field label={t('GSTIN')} htmlFor="inv-gstin" error={gstErr ? t(gstErr) : undefined}>
              <Input id="inv-gstin" value={form.gstin} maxLength={15} disabled={!editable} onChange={(e) => set('gstin', e.target.value.toUpperCase())} />
            </Field>
          </div>
          <Field label={t('Address')} htmlFor="inv-address" hint={t('One line per row.')}>
            <Textarea id="inv-address" rows={3} value={form.address} disabled={!editable} onChange={(e) => set('address', e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            {text('city', t('City'), { max: 80 })}
            <Field label={t('State')} htmlFor="inv-state">
              <StateSelect id="inv-state" value={form.stateCode} onChange={(v) => set('stateCode', v)} disabled={!editable} />
            </Field>
            {text('pin', t('PIN code'), { max: 10 })}
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {text('pan', t('PAN'), { max: 10, upper: true })}
            {text('phone', t('Phone'), { max: 40 })}
            {text('email', t('E-mail'))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {text('website', t('Website'))}
            {text('accountsEmail', t('Accounts e-mail'), { hint: t('Gets a copy of every invoice e-mail.') })}
          </div>
        </section>
        <section className="grid gap-4">
          <h3 className="font-medium">{t('Numbering and tax')}</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            {text('invoicePrefix', t('Invoice prefix'), { max: 16, upper: true, hint: t('Next number looks like {{example}}', { example: formatInvoiceNumber(form.invoicePrefix, financialYear(new Date()), 1) }) })}
            {text('creditNotePrefix', t('Credit note prefix'), { max: 20, upper: true, hint: t('Next number looks like {{example}}', { example: formatInvoiceNumber(form.creditNotePrefix, financialYear(new Date()), 1) }) })}
            {text('sacCode', t('SAC code'), { max: 8, hint: t('Default 998314 — confirm with your accountant.') })}
          </div>
        </section>
        <section className="grid gap-4">
          <h3 className="font-medium">{t('Payment details (printed on invoices and shown for offline payment)')}</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            {text('bankName', t('Bank'), { max: 120 })}
            {text('bankAccountName', t('Account name'))}
            {text('bankAccountNo', t('Account no.'), { max: 40 })}
            {text('bankIfsc', t('IFSC'), { max: 20, upper: true })}
            {text('bankBranch', t('Branch'), { max: 120 })}
            {text('upiId', t('UPI ID'), { max: 80 })}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {q.data.hasUpiQr && <Logo version={upiVersion} path="/licences/settings/upi-qr" />}
            {editable && (
              <>
                <input
                  ref={upiRef}
                  type="file"
                  accept="image/png,image/jpeg"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) uploadUpi.mutate(f);
                    e.target.value = '';
                  }}
                />
                <Button type="button" variant="outline" onClick={() => upiRef.current?.click()} disabled={uploadUpi.isPending}>
                  {uploadUpi.isPending ? <Spinner /> : <ImageUpIcon />}
                  {q.data.hasUpiQr ? t('Change UPI QR') : t('Upload UPI QR')}
                </Button>
                {q.data.hasUpiQr && (
                  <Button type="button" variant="ghost" onClick={() => removeUpi.mutate()} disabled={removeUpi.isPending}>
                    <Trash2Icon />
                    {t('Remove UPI QR')}
                  </Button>
                )}
                <span className="text-xs text-muted-foreground">{t('Your GPay / UPI QR (PNG or JPG). Shown on the Buy screen and sent in welcome emails.')}</span>
              </>
            )}
          </div>
        </section>
        <Field label={t('Terms')} htmlFor="inv-terms">
          <Textarea id="inv-terms" rows={3} value={form.terms} maxLength={4000} disabled={!editable} onChange={(e) => set('terms', e.target.value)} />
        </Field>
        <Field label={t('Footer note')} htmlFor="inv-footer">
          <Textarea id="inv-footer" rows={2} value={form.footerNote} maxLength={1000} disabled={!editable} onChange={(e) => set('footerNote', e.target.value)} />
        </Field>
        <FormError message={save.error ? errorMessage(save.error) : null} />
        {editable && (
          <div>
            <Button type="submit" disabled={save.isPending || !!gstErr}>
              {save.isPending ? <Spinner /> : <SaveIcon />}
              {t('Save invoicing details')}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}
