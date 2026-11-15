import { zodResolver } from '@hookform/resolvers/zod';
import {
  BILLING_FREQUENCIES,
  CURRENCY_EXPONENTS,
  DISTANCE_SOURCES,
  MISSING_GPS_POLICIES,
  ROUNDING_MODES,
  type BranchDto,
  type CreatePricingContractRequest,
  type PricingContractDto,
  type TransportAgreementDto,
  type UpdatePricingContractRequest,
} from '@veetracer/shared';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { z } from 'zod';
import type { Option } from '@/components/ui/multi-select';
import { useAuth } from '@/features/auth/auth-context';
import { FormDialog } from '@/features/masters/FormDialog';
import { ComboboxField, MultiSelectField, SelectField, SwitchField, TextField } from '@/features/masters/form-fields';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api } from '@/lib/api';
import { MODEL_PRESETS, PRESET_LABEL, presetRows, rowsToComponents, type ModelPreset } from './components';
import { pricingErrorMessage } from './errors';
import { P, usePricingMutation, useTaxProfiles } from './pricing-api';
import { enumLabel, todayYmd } from './ui';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const schema = z
  .object({
    name: z.string().trim().min(1, 'Required').max(160),
    reference: z.string().trim().max(80),
    customerKind: z.enum(['INTERNAL', 'AGREEMENT']),
    agreementId: z.string().nullable(),
    customerName: z.string().trim().max(160),
    currency: z.string().min(3, 'Required'),
    billingFrequency: z.enum(BILLING_FREQUENCIES),
    paymentTermsDays: z.string().regex(/^\d{1,3}$/, 'Enter a whole number').refine((v) => Number(v) <= 365, '0–365 days'),
    taxProfileId: z.string().nullable(),
    branchIds: z.array(z.string()),
    isDefault: z.boolean(),
    coversInternal: z.boolean(),
    coversExternal: z.boolean(),
    allowVehicleOverrides: z.boolean(),
    allowTripOverrides: z.boolean(),
    distanceSource: z.enum(DISTANCE_SOURCES),
    onMissingGps: z.enum(MISSING_GPS_POLICIES),
    roundingMode: z.enum(ROUNDING_MODES),
    validFrom: z.string(),
    validTo: z.string(),
    preset: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.customerKind === 'AGREEMENT' && !v.agreementId) ctx.addIssue({ code: 'custom', path: ['agreementId'], message: 'Choose the agreement' });
    if (v.customerKind === 'INTERNAL' && !v.customerName) ctx.addIssue({ code: 'custom', path: ['customerName'], message: 'Name the internal client or branch billed' });
    if (!DAY.test(v.validFrom)) ctx.addIssue({ code: 'custom', path: ['validFrom'], message: 'Required' });
    if (v.validTo && (!DAY.test(v.validTo) || v.validTo <= v.validFrom)) ctx.addIssue({ code: 'custom', path: ['validTo'], message: 'Must be after the start date' });
  });
type Values = z.infer<typeof schema>;

const agreementOption = (a: TransportAgreementDto): Option => ({ value: a.id, label: a.customerCompanyName, description: a.status });
const opts = (list: readonly string[]): Option[] => list.map((v) => ({ value: v, label: enumLabel(v) }));
const DISTANCE_LABEL: Record<string, string> = { GPS: 'GPS distance', PLANNED: 'Planned distance', AGREED: 'Agreed distance', MANUAL_APPROVED: 'Manual (approved)' };
const MISSING_LABEL: Record<string, string> = { REVIEW: 'Send to review', USE_PLANNED: 'Use planned distance', USE_AGREED: 'Use agreed distance' };

/** Create a contract (version 1, optionally prefilled from a model preset) or edit the header of an existing one. */
export function ContractForm({ open, onOpenChange, contract }: { open: boolean; onOpenChange: (o: boolean) => void; contract?: PricingContractDto }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const draft = !contract || contract.status === 'DRAFT';
  const taxProfiles = useTaxProfiles(open);
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: open && can('branches') });
  const agreements = useEntityOptions<TransportAgreementDto>('/transport/agreements', agreementOption, { enabled: open && !contract && can('etms_partners') });
  const [serverError, setServerError] = useState<unknown>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: contract?.name ?? '',
      reference: contract?.reference ?? '',
      customerKind: contract?.customerCompanyId ? 'AGREEMENT' : 'INTERNAL',
      agreementId: contract?.agreementId ?? null,
      customerName: contract?.customerName ?? '',
      currency: contract?.currency ?? 'INR',
      billingFrequency: contract?.billingFrequency ?? 'MONTHLY',
      paymentTermsDays: String(contract?.paymentTermsDays ?? 30),
      taxProfileId: contract?.taxProfileId ?? null,
      branchIds: contract?.branchIds ?? [],
      isDefault: contract?.isDefault ?? false,
      coversInternal: contract?.defaultCovers.includes('INTERNAL') ?? false,
      coversExternal: contract?.defaultCovers.includes('EXTERNAL') ?? false,
      allowVehicleOverrides: contract?.allowVehicleOverrides ?? false,
      allowTripOverrides: contract?.allowTripOverrides ?? false,
      distanceSource: contract?.distanceSource ?? 'GPS',
      onMissingGps: contract?.onMissingGps ?? 'REVIEW',
      roundingMode: contract?.roundingMode ?? 'HALF_UP',
      validFrom: todayYmd(),
      validTo: '',
      preset: 'DISTANCE',
    },
  });
  const kind = form.watch('customerKind');
  const isDefault = form.watch('isDefault');
  const currencies = useMemo(() => Object.keys(CURRENCY_EXPONENTS).sort().map((c) => ({ value: c, label: c })), []);
  const taxOptions = useMemo(() => (taxProfiles.data ?? []).map((p) => ({ value: p.id, label: p.name, description: enumLabel(p.regime) })), [taxProfiles.data]);

  const save = usePricingMutation(
    (v: Values) => {
      const header = {
        reference: v.reference || null,
        paymentTermsDays: Number(v.paymentTermsDays),
        taxProfileId: v.taxProfileId,
        branchIds: v.branchIds,
        isDefault: v.isDefault,
        defaultCovers: v.isDefault ? ([v.coversInternal && 'INTERNAL', v.coversExternal && 'EXTERNAL'].filter(Boolean) as ('INTERNAL' | 'EXTERNAL')[]) : [],
        allowVehicleOverrides: v.allowVehicleOverrides,
        allowTripOverrides: v.allowTripOverrides,
        distanceSource: v.distanceSource,
        onMissingGps: v.onMissingGps,
        roundingMode: v.roundingMode,
      };
      if (contract) {
        // After approval only tax profile, payment terms and branches may change (server rule); send just those.
        const body: UpdatePricingContractRequest = draft
          ? { expectedVersion: contract.version, name: v.name, currency: v.currency, billingFrequency: v.billingFrequency, customerName: v.customerKind === 'INTERNAL' ? v.customerName : undefined, ...header }
          : { expectedVersion: contract.version, taxProfileId: header.taxProfileId, paymentTermsDays: header.paymentTermsDays, branchIds: header.branchIds };
        return api.patch<PricingContractDto>(`${P}/contracts/${contract.id}`, body);
      }
      const agreement = agreements.rows.find((a) => a.id === v.agreementId);
      const body: CreatePricingContractRequest = {
        name: v.name,
        currency: v.currency,
        billingFrequency: v.billingFrequency,
        ...header,
        customerCompanyId: v.customerKind === 'AGREEMENT' ? (agreement?.customerCompanyId ?? null) : null,
        agreementId: v.customerKind === 'AGREEMENT' ? v.agreementId : null,
        customerName: v.customerKind === 'INTERNAL' ? v.customerName : null,
        validFrom: v.validFrom,
        validTo: v.validTo || null,
        components: v.preset ? rowsToComponents(presetRows(v.preset as ModelPreset)) : [],
      };
      return api.post<PricingContractDto>(`${P}/contracts`, body);
    },
    {
      success: contract ? 'Contract updated' : 'Contract created',
      toastError: false,
      onSuccess: (c) => {
        onOpenChange(false);
        if (!contract) navigate(`/pricing/contracts/${c.id}`);
      },
    },
  );
  const submit = form.handleSubmit((v) => {
    setServerError(null);
    save.mutate(v, { onError: (e) => setServerError(e) });
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={contract ? 'Edit contract' : 'New company contract'}
      description={contract ? (draft ? undefined : 'After approval only the tax profile, payment terms and branches can change. Re-price with a new version.') : 'Creates a draft contract with version 1. Prices apply only after a second user approves it.'}
      wide
      pending={save.isPending}
      error={serverError ? new Error(pricingErrorMessage(serverError, t)) : null}
      onSubmit={submit}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField form={form} name="name" label="Contract name" required disabled={!draft} className="sm:col-span-2" />
        <TextField form={form} name="reference" label="Reference / PO" disabled={!draft} />
        {!contract && (
          <SelectField
            form={form}
            name="customerKind"
            label="Bills"
            required
            options={[
              { value: 'INTERNAL', label: 'Internal client / branch (charge-back)' },
              ...(can('etms_partners') ? [{ value: 'AGREEMENT', label: 'Customer company (transport agreement)' }] : []),
            ]}
          />
        )}
        {kind === 'AGREEMENT' && !contract ? (
          <ComboboxField form={form} name="agreementId" label="Transport agreement" required options={agreements.options} loading={agreements.loading} className="sm:col-span-2" />
        ) : (
          <TextField form={form} name="customerName" label="Customer name" required={kind === 'INTERNAL'} disabled={!draft || !!contract?.customerCompanyId} hint="The internal client or branch the invoices are addressed to." className="sm:col-span-2" />
        )}
        <ComboboxField form={form} name="currency" label="Currency" required options={currencies} disabled={!draft} />
        <SelectField form={form} name="billingFrequency" label="Billing frequency" required options={opts(BILLING_FREQUENCIES)} />
        <TextField form={form} name="paymentTermsDays" label="Payment terms (days)" required type="number" />
        <ComboboxField form={form} name="taxProfileId" label="Tax profile" options={taxOptions} loading={taxProfiles.isPending} hint="Set tax profiles in Pricing settings. Without one, invoices cannot carry tax." />
        {can('branches') && <MultiSelectField form={form} name="branchIds" label="Branches" options={branches.options} loading={branches.loading} hint="Empty = every branch (needs a company-wide user)." className="sm:col-span-2" />}
        {!contract && (
          <>
            <TextField form={form} name="validFrom" label="Valid from" type="date" required />
            <TextField form={form} name="validTo" label="Valid until (exclusive)" type="date" hint="Empty = open-ended." />
            <SelectField form={form} name="preset" label="Start from pricing model" options={MODEL_PRESETS.map((p) => ({ value: p, label: PRESET_LABEL[p] }))} hint="Prefills the components of version 1; edit the rates on the contract screen." className="sm:col-span-2" />
          </>
        )}
      </div>
      <fieldset className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2" disabled={!draft}>
        <legend className="px-1 text-sm font-semibold">{t('Policies')}</legend>
        <SelectField form={form} name="distanceSource" label="Billable distance from" options={DISTANCE_SOURCES.map((v) => ({ value: v, label: DISTANCE_LABEL[v] }))} />
        <SelectField form={form} name="onMissingGps" label="When GPS is missing" options={MISSING_GPS_POLICIES.map((v) => ({ value: v, label: MISSING_LABEL[v] }))} />
        <SelectField form={form} name="roundingMode" label="Rounding" options={ROUNDING_MODES.map((v) => ({ value: v, label: v === 'HALF_UP' ? 'Half up' : 'Half even (banker’s)' }))} />
        <SwitchField form={form} name="allowVehicleOverrides" label="Vehicle rates permitted" hint="Allows vehicle-level rates (Vehicle rates menu) that replace the contract components for one vehicle." className="sm:col-span-2" />
        <SwitchField form={form} name="allowTripOverrides" label="Trip price overrides permitted" hint="Allows a negotiated price for a single trip (with a reason)." className="sm:col-span-2" />
        {!form.watch('customerKind') || kind === 'INTERNAL' ? (
          <SwitchField form={form} name="isDefault" label="Default contract" hint="Prices trips that no customer contract covers." className="sm:col-span-2" />
        ) : null}
        {isDefault && (
          <>
            <SwitchField form={form} name="coversInternal" label="Covers internal trips" />
            <SwitchField form={form} name="coversExternal" label="Covers external customers" />
          </>
        )}
      </fieldset>
    </FormDialog>
  );
}
