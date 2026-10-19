import { useMutation } from '@tanstack/react-query';
import { gstinError, INDIAN_STATES, type BillingProfileDto } from '@veetracer/shared';
import { SaveIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { api, errorMessage } from '@/lib/api';

export function StateSelect({ id, value, onChange, disabled }: { id?: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id}>
        <SelectValue placeholder={t('Select state')} />
      </SelectTrigger>
      <SelectContent>
        {INDIAN_STATES.map((s) => (
          <SelectItem key={s.code} value={s.code}>
            {s.name} ({s.code})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Billing details printed on invoices (required before the first purchase). */
export function BillingProfileForm({ profile, path, canEdit, onSaved }: { profile: BillingProfileDto; path: string; canEdit: boolean; onSaved: () => void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState(profile);
  useEffect(() => setForm(profile), [profile]);
  const set = <K extends keyof BillingProfileDto>(k: K, v: BillingProfileDto[K]) => setForm((f) => ({ ...f, [k]: v }));
  const gstErr = form.gstin.trim() ? gstinError(form.gstin, form.stateCode) : null;
  const pinErr = form.pin.trim() && !/^\d{6}$/.test(form.pin.trim()) ? t('PIN code must be 6 digits') : null;
  const save = useMutation({
    mutationFn: () => {
      const { complete: _c, ...body } = form;
      return api.put<BillingProfileDto>(path, { ...body, gstin: body.gstin.trim().toUpperCase() });
    },
    onSuccess: () => {
      toast.success(t('Billing details saved'));
      onSaved();
    },
  });
  const valid = form.billingName.trim() && form.address.trim() && form.stateCode && form.email.trim() && !gstErr && !pinErr;
  return (
    <form
      className="grid max-w-3xl gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('Billing name')} htmlFor="bp-name" required>
          <Input id="bp-name" value={form.billingName} maxLength={160} disabled={!canEdit} onChange={(e) => set('billingName', e.target.value)} />
        </Field>
        <Field label={t('Billing e-mail')} htmlFor="bp-email" required hint={t('Invoices are e-mailed here.')}>
          <Input id="bp-email" type="email" value={form.email} maxLength={160} disabled={!canEdit} onChange={(e) => set('email', e.target.value)} />
        </Field>
      </div>
      <Field label={t('Address')} htmlFor="bp-address" required>
        <Textarea id="bp-address" rows={3} value={form.address} maxLength={500} disabled={!canEdit} onChange={(e) => set('address', e.target.value)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t('City')} htmlFor="bp-city">
          <Input id="bp-city" value={form.city} maxLength={80} disabled={!canEdit} onChange={(e) => set('city', e.target.value)} />
        </Field>
        <Field label={t('State')} htmlFor="bp-state" required>
          <StateSelect id="bp-state" value={form.stateCode} onChange={(v) => set('stateCode', v)} disabled={!canEdit} />
        </Field>
        <Field label={t('PIN code')} htmlFor="bp-pin" error={pinErr ?? undefined}>
          <Input id="bp-pin" inputMode="numeric" value={form.pin} maxLength={6} disabled={!canEdit} onChange={(e) => set('pin', e.target.value.replace(/\D/g, ''))} />
        </Field>
      </div>
      <Field label={t('GSTIN')} htmlFor="bp-gstin" error={gstErr ? t(gstErr) : undefined} hint={t('Optional. Needed to claim input tax credit.')}>
        <Input id="bp-gstin" value={form.gstin} maxLength={15} disabled={!canEdit} onChange={(e) => set('gstin', e.target.value.toUpperCase())} placeholder="33ABCDE1234F1Z5" />
      </Field>
      <FormError message={save.error ? errorMessage(save.error) : null} />
      {canEdit && (
        <div>
          <Button type="submit" disabled={!valid || save.isPending}>
            {save.isPending ? <Spinner /> : <SaveIcon />}
            {t('Save billing details')}
          </Button>
        </div>
      )}
    </form>
  );
}
