import { zodResolver } from '@hookform/resolvers/zod';
import { TAX_REGIMES, type BillingSupplierProfileDto, type CreatePricingTaxProfileRequest, type CreatePricingTaxRateRequest, type PricingCalendarDto, type PricingTaxProfileDto, type UpsertBillingSupplierProfileRequest, type UpsertPricingCalendarRequest } from '@veetracer/shared';
import { CalendarDaysIcon, PlusIcon, SaveIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input, Textarea } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { SelectField, TextField } from '@/features/masters/form-fields';
import { api } from '@/lib/api';
import { pricingErrorMessage } from './errors';
import { P, useCalendars, usePricingMutation, useSupplier, useTaxProfiles } from './pricing-api';
import { Empty, enumLabel, Labeled, QueryView, ScrollTable, Section, Sel, SimpleDialog, Td, Th, todayYmd, PricingShell } from './ui';

const supplierSchema = z
  .object({
    legalName: z.string().trim().min(1, 'Required').max(200),
    address: z.string().trim().min(1, 'Required').max(500),
    city: z.string().trim().max(100),
    stateCode: z.string().trim().max(10),
    country: z.string().trim().regex(/^[A-Za-z]{2}$/, 'Two-letter country code'),
    taxRegime: z.enum(TAX_REGIMES),
    taxRegistration: z.string().trim().max(40),
    invoicePrefix: z.string().trim().regex(/^[A-Za-z0-9-]{0,16}$/, 'Up to 16 letters, digits or -'),
    creditNotePrefix: z.string().trim().regex(/^[A-Za-z0-9-]{0,16}$/, 'Up to 16 letters, digits or -'),
    fiscalYearStartMonth: z.string().regex(/^(?:[1-9]|1[0-2])$/, '1–12'),
    email: z.string().trim().max(200),
    phone: z.string().trim().max(40),
  })
  .superRefine((v, ctx) => {
    if (v.taxRegime === 'IN_GST' && !/^\d{2}$/.test(v.stateCode)) ctx.addIssue({ code: 'custom', path: ['stateCode'], message: 'India GST needs the two-digit GST state code' });
  });
type SupplierValues = z.infer<typeof supplierSchema>;

function SupplierForm({ supplier, editable }: { supplier: BillingSupplierProfileDto | null; editable: boolean }) {
  const { t } = useTranslation();
  const form = useForm<SupplierValues>({
    resolver: zodResolver(supplierSchema),
    defaultValues: {
      legalName: supplier?.legalName ?? '',
      address: supplier?.address ?? '',
      city: supplier?.city ?? '',
      stateCode: supplier?.stateCode ?? '',
      country: supplier?.country ?? 'IN',
      taxRegime: supplier?.taxRegime ?? 'IN_GST',
      taxRegistration: supplier?.taxRegistration ?? '',
      invoicePrefix: supplier?.invoicePrefix ?? 'INV',
      creditNotePrefix: supplier?.creditNotePrefix ?? 'CN',
      fiscalYearStartMonth: String(supplier?.fiscalYearStartMonth ?? 4),
      email: supplier?.email ?? '',
      phone: supplier?.phone ?? '',
    },
  });
  const save = usePricingMutation(
    (v: SupplierValues) =>
      api.put(`${P}/settings/supplier`, {
        ...(supplier ? { expectedVersion: supplier.version } : {}),
        legalName: v.legalName,
        address: v.address,
        city: v.city,
        stateCode: v.stateCode || null,
        country: v.country.toUpperCase(),
        taxRegime: v.taxRegime,
        taxRegistration: v.taxRegistration || null,
        invoicePrefix: v.invoicePrefix,
        creditNotePrefix: v.creditNotePrefix,
        fiscalYearStartMonth: Number(v.fiscalYearStartMonth),
        email: v.email || null,
        phone: v.phone || null,
      } satisfies UpsertBillingSupplierProfileRequest),
    { success: 'Supplier saved', toastError: false },
  );
  return (
    <form noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4">
      {save.isError && <FormError message={pricingErrorMessage(save.error, t)} />}
      <fieldset disabled={!editable} className="grid gap-4 sm:grid-cols-2">
        <TextField form={form} name="legalName" label="Legal name" required className="sm:col-span-2" />
        <TextField form={form} name="address" label="Address" required multiline className="sm:col-span-2" />
        <TextField form={form} name="city" label="City" />
        <TextField form={form} name="stateCode" label="GST state code" hint="Two digits, e.g. 33 for Tamil Nadu." />
        <TextField form={form} name="country" label="Country (2 letters)" />
        <SelectField form={form} name="taxRegime" label="Tax regime" options={TAX_REGIMES.map((r) => ({ value: r, label: r === 'IN_GST' ? 'India GST' : r === 'SIMPLE' ? 'Simple (one rate per code)' : 'No tax' }))} />
        <TextField form={form} name="taxRegistration" label="Tax registration (GSTIN / VAT)" />
        <TextField form={form} name="fiscalYearStartMonth" label="Fiscal year starts in month" type="number" />
        <TextField form={form} name="invoicePrefix" label="Invoice number prefix" />
        <TextField form={form} name="creditNotePrefix" label="Credit note prefix" />
        <TextField form={form} name="email" label="Email" type="email" />
        <TextField form={form} name="phone" label="Phone" type="tel" />
      </fieldset>
      {editable && (
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? <Spinner /> : <SaveIcon />} {t('Save supplier')}
        </Button>
      )}
    </form>
  );
}

const emptyRate = (): CreatePricingTaxRateRequest => ({ taxCode: 'GST18', label: 'GST 18%', ratePercent: '18', sac: '996601', validFrom: todayYmd(), validTo: null });

function RateFields({ rate, onChange }: { rate: CreatePricingTaxRateRequest; onChange: (r: CreatePricingTaxRateRequest) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Labeled label="Tax code">{(id) => <Input id={id} value={rate.taxCode} maxLength={32} onChange={(e) => onChange({ ...rate, taxCode: e.target.value.toUpperCase() })} />}</Labeled>
      <Labeled label="Label">{(id) => <Input id={id} value={rate.label} maxLength={80} onChange={(e) => onChange({ ...rate, label: e.target.value })} />}</Labeled>
      <Labeled label="Rate (%)" error={/^\d{1,3}(\.\d{1,4})?$/.test(rate.ratePercent) ? null : 'Enter a number'}>
        {(id) => <Input id={id} inputMode="decimal" value={rate.ratePercent} onChange={(e) => onChange({ ...rate, ratePercent: e.target.value })} />}
      </Labeled>
      <Labeled label="SAC / HSN">{(id) => <Input id={id} value={rate.sac ?? ''} maxLength={20} onChange={(e) => onChange({ ...rate, sac: e.target.value || null })} />}</Labeled>
      <Labeled label="Valid from">{(id) => <Input id={id} type="date" value={rate.validFrom} onChange={(e) => onChange({ ...rate, validFrom: e.target.value })} />}</Labeled>
      <Labeled label="Valid until">{(id) => <Input id={id} type="date" value={rate.validTo ?? ''} onChange={(e) => onChange({ ...rate, validTo: e.target.value || null })} />}</Labeled>
    </div>
  );
}

function TaxProfiles({ profiles, editable }: { profiles: PricingTaxProfileDto[]; editable: boolean }) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [profile, setProfile] = useState<CreatePricingTaxProfileRequest>({ name: '', regime: 'IN_GST', defaultTaxCode: 'GST18', jurisdiction: null });
  const [rate, setRate] = useState<CreatePricingTaxRateRequest>(emptyRate);
  const [rateFor, setRateFor] = useState<PricingTaxProfileDto | null>(null);
  const create = usePricingMutation(() => api.post(`${P}/settings/tax-profiles`, { ...profile, name: profile.name.trim(), rates: profile.regime === 'NONE' ? [] : [rate] } satisfies CreatePricingTaxProfileRequest), { success: 'Tax profile created', toastError: false, onSuccess: () => setCreating(false) });
  const addRate = usePricingMutation(() => api.post(`${P}/settings/tax-profiles/${rateFor!.id}/rates`, rate), { success: 'Tax rate added', toastError: false, onSuccess: () => setRateFor(null) });
  return (
    <>
      {editable && (
        <Button size="sm" variant="outline" className="mb-3" onClick={() => (setProfile({ name: '', regime: 'IN_GST', defaultTaxCode: 'GST18', jurisdiction: null }), setRate(emptyRate()), setCreating(true))}>
          <PlusIcon /> {t('New tax profile')}
        </Button>
      )}
      {profiles.length === 0 ? (
        <Empty title="No tax profiles" description="Contracts need a tax profile so invoices carry tax." />
      ) : (
        <div className="space-y-3">
          {profiles.map((p) => (
            <div key={p.id} className="rounded-lg border p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">
                  {p.name} <span className="text-xs text-muted-foreground">· {t(enumLabel(p.regime))}{p.defaultTaxCode ? ` · ${t('default')} ${p.defaultTaxCode}` : ''}</span>
                </p>
                {editable && p.regime !== 'NONE' && (
                  <Button size="sm" variant="ghost" onClick={() => (setRate(emptyRate()), setRateFor(p))}>
                    <PlusIcon /> {t('Add rate')}
                  </Button>
                )}
              </div>
              {p.rates.length > 0 && (
                <ScrollTable label={p.name} minWidth={520}>
                  <thead>
                    <tr>
                      <Th>{t('Code')}</Th>
                      <Th>{t('Label')}</Th>
                      <Th right>{t('Rate')}</Th>
                      <Th>{t('SAC / HSN')}</Th>
                      <Th>{t('Validity')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.rates.map((r) => (
                      <tr key={r.id}>
                        <Td className="font-mono text-xs">{r.taxCode}</Td>
                        <Td>{r.label}</Td>
                        <Td right>{r.ratePercent}%</Td>
                        <Td>{r.sac ?? '—'}</Td>
                        <Td className="whitespace-nowrap">
                          {r.validFrom} – {r.validTo ?? t('open')}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </ScrollTable>
              )}
            </div>
          ))}
        </div>
      )}
      <SimpleDialog open={creating} onOpenChange={setCreating} wide title="New tax profile" pending={create.isPending} error={create.error} onSubmit={() => profile.name.trim() && create.mutate(undefined)}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Labeled label="Name" error={profile.name.trim() ? null : 'Required'}>{(id) => <Input id={id} value={profile.name} maxLength={80} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />}</Labeled>
          <Labeled label="Regime">{(id) => <Sel id={id} value={profile.regime} onChange={(v) => setProfile({ ...profile, regime: v as CreatePricingTaxProfileRequest['regime'] })} options={TAX_REGIMES.map((r) => ({ value: r, label: t(enumLabel(r)) }))} />}</Labeled>
          <Labeled label="Default tax code">{(id) => <Input id={id} value={profile.defaultTaxCode ?? ''} maxLength={32} onChange={(e) => setProfile({ ...profile, defaultTaxCode: e.target.value.toUpperCase() || null })} />}</Labeled>
        </div>
        {profile.regime !== 'NONE' && (
          <fieldset className="space-y-2 rounded-lg border p-3">
            <legend className="px-1 text-sm font-semibold">{t('First rate')}</legend>
            <RateFields rate={rate} onChange={setRate} />
          </fieldset>
        )}
      </SimpleDialog>
      <SimpleDialog open={!!rateFor} onOpenChange={(o) => !o && setRateFor(null)} wide title="Add tax rate" description={rateFor?.name} pending={addRate.isPending} error={addRate.error} onSubmit={() => addRate.mutate(undefined)}>
        <RateFields rate={rate} onChange={setRate} />
      </SimpleDialog>
    </>
  );
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function Calendars({ calendars, editable }: { calendars: PricingCalendarDto[]; editable: boolean }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<UpsertPricingCalendarRequest | null>(null);
  const [text, setText] = useState('');
  useEffect(() => setText(editing?.holidays.join('\n') ?? ''), [editing]);
  const dates = text.split(/[\s,;]+/).filter(Boolean);
  const bad = dates.filter((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d));
  const save = usePricingMutation(() => api.put(`${P}/settings/calendars`, { ...editing!, name: editing!.name.trim(), holidays: dates } satisfies UpsertPricingCalendarRequest), { success: 'Calendar saved', toastError: false, onSuccess: () => setEditing(null) });
  return (
    <>
      {editable && (
        <Button size="sm" variant="outline" className="mb-3" onClick={() => setEditing({ name: '', holidays: [], nonOperatingWeekdays: [7] })}>
          <PlusIcon /> {t('New calendar')}
        </Button>
      )}
      {calendars.length === 0 ? (
        <Empty icon={CalendarDaysIcon} title="No holiday calendars" description="A contract version can reference a calendar for holiday charges and non-operating days." />
      ) : (
        <ul className="divide-y rounded-lg border">
          {calendars.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="font-medium">{c.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {t('{{count}} holiday(s)', { count: c.holidays.length })}
                  {c.nonOperatingWeekdays.length ? ` · ${t('closed')} ${c.nonOperatingWeekdays.map((d) => t(WEEKDAYS[d - 1])).join(', ')}` : ''}
                </span>
              </span>
              {editable && (
                <Button size="sm" variant="ghost" onClick={() => setEditing({ name: c.name, holidays: c.holidays, nonOperatingWeekdays: c.nonOperatingWeekdays })}>
                  {t('Edit')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <SimpleDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} title="Holiday calendar" description="Saving with an existing name replaces that calendar." pending={save.isPending} error={save.error} onSubmit={() => editing?.name.trim() && !bad.length && save.mutate(undefined)}>
        {editing && (
          <div className="space-y-3">
            <Labeled label="Name" error={editing.name.trim() ? null : 'Required'}>{(id) => <Input id={id} value={editing.name} maxLength={80} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />}</Labeled>
            <Labeled label="Holidays (one date per line, YYYY-MM-DD)" error={bad.length ? t('Not a date: {{list}}', { list: bad.slice(0, 3).join(', ') }) : null}>
              {(id) => <Textarea id={id} rows={6} value={text} onChange={(e) => setText(e.target.value)} />}
            </Labeled>
            <fieldset>
              <legend className="text-xs font-medium text-muted-foreground">{t('Non-operating weekdays')}</legend>
              <div className="mt-1 flex flex-wrap gap-3">
                {WEEKDAYS.map((d, i) => (
                  <label key={d} className="flex items-center gap-1.5 text-sm">
                    <Checkbox checked={editing.nonOperatingWeekdays?.includes(i + 1) ?? false} onCheckedChange={(c) => setEditing({ ...editing, nonOperatingWeekdays: c ? [...(editing.nonOperatingWeekdays ?? []), i + 1].sort() : (editing.nonOperatingWeekdays ?? []).filter((x) => x !== i + 1) })} />
                    {t(d)}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        )}
      </SimpleDialog>
    </>
  );
}

/** Pricing settings (route /pricing/settings, menu pricing_contracts): supplier, tax profiles and rates, holiday calendars. */
export function PricingSettingsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const editable = can('pricing_contracts', 'approve');
  const supplier = useSupplier();
  const taxes = useTaxProfiles();
  const calendars = useCalendars();
  return (
    <PricingShell title={t('Pricing settings')} description={editable ? t('Your legal and tax details on invoices, tax profiles and holiday calendars.') : t('Read only: changes need the contract approval permission.')}>
      <Section title={t('Supplier (your company on invoices)')}>
        <QueryView query={supplier} rows={3}>
          {(s) => (
            <>
              {!s && <p className="mb-3 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-sm">{t('Not set up yet. Invoices cannot be issued until the supplier is saved.')}</p>}
              <SupplierForm key={s?.version ?? 0} supplier={s} editable={editable} />
            </>
          )}
        </QueryView>
      </Section>
      <Section title={t('Tax profiles')}>
        <QueryView query={taxes} rows={2}>
          {(list) => <TaxProfiles profiles={list} editable={editable} />}
        </QueryView>
      </Section>
      <Section title={t('Holiday calendars')}>
        <QueryView query={calendars} rows={2}>
          {(list) => <Calendars calendars={list} editable={editable} />}
        </QueryView>
      </Section>
    </PricingShell>
  );
}
