import type { CompanyDto, PoiDto, TransportAgreementDto, TransportAgreementSide, TransportDataProfile, TransportGrant } from '@veetracer/shared';
import { TRANSPORT_DATA_PROFILES } from '@veetracer/shared';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Combobox, MultiSelect, type Option } from '@/components/ui/multi-select';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { useEntityOptions } from '@/features/masters/use-options';
import { getReportTimeZone, reportZoneLabel, todayInZone } from '@/features/reports/report-time';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  DATA_PROFILE_META,
  dayStartIso,
  draftFromAgreement,
  emptyDraft,
  GRANT_META,
  isWriteGrant,
  lastDayToValidTo,
  orderedGrants,
  validateAgreementDraft,
  type AgreementDraft,
  type DraftErrors,
} from './agreement-format';
import { AgreementError } from './agreement-ui';
import { agreementPath, useAgreementMutation, useInvalidateAgreements } from './use-agreements';

const businessCompany = (c: CompanyDto): Option => ({ value: c.id, label: c.name });
const poiOption = (p: PoiDto): Option => ({ value: p.id, label: p.name, description: p.branchName ?? undefined });

/** Grant checkboxes, view grants and change grants in two labelled groups. */
function GrantPicker({ value, onChange, invalid }: { value: TransportGrant[]; onChange: (v: TransportGrant[]) => void; invalid?: boolean }) {
  const { t } = useTranslation();
  const set = new Set(value);
  const toggle = (g: TransportGrant, on: boolean) => onChange(orderedGrants(on ? [...value, g] : value.filter((x) => x !== g)));
  const groups: { title: string; items: TransportGrant[] }[] = [
    { title: 'See', items: orderedGrants().filter((g) => !isWriteGrant(g)) },
    { title: 'Make changes', items: orderedGrants().filter(isWriteGrant) },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2" aria-invalid={invalid || undefined}>
      {groups.map((grp) => (
        <div key={grp.title} className="space-y-2">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{t(grp.title)}</p>
          {grp.items.map((g) => {
            const id = `grant-${g}`;
            return (
              <div key={g} className="flex items-start gap-2.5">
                <Checkbox id={id} checked={set.has(g)} onCheckedChange={(v) => toggle(g, !!v)} className="mt-0.5" aria-describedby={`${id}-desc`} />
                <label htmlFor={id} className="min-w-0 cursor-pointer text-sm leading-5">
                  <span className="font-medium">{t(GRANT_META[g].label)}</span>
                  <span id={`${id}-desc`} className="block text-xs text-muted-foreground">
                    {t(GRANT_META[g].description)}
                  </span>
                </label>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Radio cards (data profile, our side). Native radios: arrow keys move between them. */
function RadioCards<V extends string>({ name, value, onChange, options, legend }: { name: string; value: V; onChange: (v: V) => void; options: { value: V; label: string; description?: string }[]; legend: string }) {
  const { t } = useTranslation();
  return (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1.5 text-sm leading-none font-medium">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              'flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
              value === o.value ? 'border-primary bg-primary/5' : 'hover:bg-accent/50',
            )}
          >
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="mt-0.5 size-4 accent-[var(--primary)]" />
            <span className="min-w-0">
              <span className="font-medium">{t(o.label)}</span>
              {o.description && <span className="block text-xs text-muted-foreground">{t(o.description)}</span>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Create a DRAFT agreement, or edit one (DRAFT only; the server refuses other statuses). Validation mirrors the server
 * (`validateAgreementDraft`); edits send `expectedVersion`, so a concurrent change shows the reload message.
 *
 * Parties: the Super Admin picks both business companies; a company user picks its own side and enters the partner's
 * company ID (E1a has no company directory for tenants — the partner finds its ID under Transport settings).
 */
export function AgreementFormDialog({ record, open, onOpenChange }: { record: TransportAgreementDto | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const { me, can } = useAuth();
  const navigate = useNavigate();
  const tz = getReportTimeZone();
  const zone = reportZoneLabel();
  const mutation = useAgreementMutation();
  const invalidate = useInvalidateAgreements();
  const companyId = me?.company.id ?? '';
  const platformPicker = can('sa_companies');

  const [draft, setDraft] = useState<AgreementDraft>(() => emptyDraft(todayInZone(tz)));
  const [ourSide, setOurSide] = useState<TransportAgreementSide>('CUSTOMER');
  const [partnerId, setPartnerId] = useState('');
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!open) return;
    mutation.reset();
    setTried(false);
    setPartnerId('');
    setOurSide('CUSTOMER');
    setDraft(record ? draftFromAgreement(record, tz) : emptyDraft(todayInZone(tz)));
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, record?.id]);

  const companies = useEntityOptions<CompanyDto>('/admin/companies', businessCompany, { enabled: open && !record && platformPicker, params: { status: undefined, sort: 'name', order: 'asc' } });
  const companyOptions = useMemo(() => companies.rows.filter((c) => c.accountType === 'BUSINESS' && c.status === 'ACTIVE').map(businessCompany), [companies.rows]);

  // Sites are the customer's places: only the customer company (with Places access) can list them.
  const customerId = record ? record.customerCompanyId : platformPicker ? draft.customerCompanyId : ourSide === 'CUSTOMER' ? companyId : '';
  const canPickSites = !!customerId && customerId === companyId && can('pois');
  const pois = useEntityOptions<PoiDto>('/pois', poiOption, { enabled: open && canPickSites });

  // Effective parties for validation.
  const parties: AgreementDraft = platformPicker || record
    ? draft
    : { ...draft, providerCompanyId: ourSide === 'PROVIDER' ? companyId : partnerId.trim(), customerCompanyId: ourSide === 'CUSTOMER' ? companyId : partnerId.trim() };
  const errors: DraftErrors = validateAgreementDraft(parties, { create: !record, companyId, isSuperAdmin: !!me?.user.isSuperAdmin });
  const shown = (k: keyof DraftErrors) => (tried && errors[k] ? t(errors[k]!) : undefined);
  // In the tenant flow the partner field carries the party errors.
  const partnerError = shown(ourSide === 'CUSTOMER' ? 'providerCompanyId' : 'customerCompanyId') ?? shown('customerCompanyId');

  const set = <K extends keyof AgreementDraft>(k: K, v: AgreementDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const submit = () => {
    setTried(true);
    if (Object.keys(errors).length) return;
    const validFrom = dayStartIso(draft.validFrom, tz)!;
    const validTo = draft.lastDay ? lastDayToValidTo(draft.lastDay, tz) : null;
    if (record) {
      mutation.mutate(
        {
          kind: 'update',
          id: record.id,
          input: { validFrom, validTo, grants: draft.grants, dataProfile: draft.dataProfile, ...(canPickSites ? { siteIds: draft.siteIds } : {}), expectedVersion: record.version },
        },
        {
          onSuccess: () => {
            toast.success(t('Draft saved'));
            onOpenChange(false);
          },
        },
      );
    } else {
      mutation.mutate(
        {
          kind: 'create',
          input: {
            providerCompanyId: parties.providerCompanyId,
            customerCompanyId: parties.customerCompanyId,
            validFrom,
            validTo,
            grants: draft.grants,
            dataProfile: draft.dataProfile,
            ...(canPickSites ? { siteIds: draft.siteIds } : {}),
          },
        },
        {
          onSuccess: (row) => {
            toast.success(t('Draft agreement created'));
            onOpenChange(false);
            navigate(agreementPath(row.id));
          },
        },
      );
    }
  };

  const duplicate = mutation.error instanceof ApiError && mutation.error.code === 'AGREEMENT_DUPLICATE';
  const notFound = mutation.error instanceof ApiError && mutation.error.status === 404 && !record;

  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{record ? t('Edit draft agreement') : t('New agreement')}</DialogTitle>
          <DialogDescription>
            {record
              ? t('{{provider}} → {{customer}}. Only drafts can be changed.', { provider: record.providerCompanyName, customer: record.customerCompanyName })
              : t('Starts as a draft. Nothing applies until both companies approve it.')}
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogBody className="grid gap-5">
            {!record && platformPicker && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('Transport provider')} htmlFor="agr-provider" required error={shown('providerCompanyId')}>
                  <Combobox
                    id="agr-provider"
                    value={draft.providerCompanyId || null}
                    onChange={(v) => set('providerCompanyId', v ?? '')}
                    options={companyOptions}
                    loading={companies.loading}
                    placeholder={t('Select a company…')}
                    searchPlaceholder={t('Search companies…')}
                    emptyText={t('No companies found')}
                    invalid={!!shown('providerCompanyId')}
                  />
                </Field>
                <Field label={t('Customer (corporate)')} htmlFor="agr-customer" required error={shown('customerCompanyId')}>
                  <Combobox
                    id="agr-customer"
                    value={draft.customerCompanyId || null}
                    onChange={(v) => setDraft((d) => ({ ...d, customerCompanyId: v ?? '', siteIds: [] }))}
                    options={companyOptions}
                    loading={companies.loading}
                    placeholder={t('Select a company…')}
                    searchPlaceholder={t('Search companies…')}
                    emptyText={t('No companies found')}
                    invalid={!!shown('customerCompanyId')}
                  />
                </Field>
              </div>
            )}

            {!record && !platformPicker && (
              <div className="grid gap-4">
                <RadioCards
                  name="agr-side"
                  legend={t('Your company is the')}
                  value={ourSide}
                  onChange={(v) => {
                    setOurSide(v);
                    set('siteIds', []);
                  }}
                  options={[
                    { value: 'CUSTOMER', label: 'Customer', description: 'Your employees ride; a transport provider serves you.' },
                    { value: 'PROVIDER', label: 'Provider', description: 'You run vehicles and drivers for this customer.' },
                  ]}
                />
                <Field
                  label={ourSide === 'CUSTOMER' ? t('Provider company ID') : t('Customer company ID')}
                  htmlFor="agr-partner"
                  required
                  error={partnerError}
                  hint={t('Ask the other company for it: they find it under Employee transport → Transport settings.')}
                >
                  <Input id="agr-partner" value={partnerId} onChange={(e) => setPartnerId(e.target.value)} autoComplete="off" spellCheck={false} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" className="font-mono text-xs sm:text-sm" aria-invalid={!!partnerError || undefined} />
                </Field>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={zone ? t('First day ({{zone}})', { zone }) : t('First day')} htmlFor="agr-from" required error={shown('validFrom')}>
                <Input id="agr-from" type="date" value={draft.validFrom} onChange={(e) => set('validFrom', e.target.value)} aria-invalid={!!shown('validFrom') || undefined} />
              </Field>
              <Field label={t('Last day')} htmlFor="agr-to" error={shown('lastDay')} hint={t('Leave empty for no end date.')}>
                <Input id="agr-to" type="date" min={draft.validFrom || undefined} value={draft.lastDay} onChange={(e) => set('lastDay', e.target.value)} aria-invalid={!!shown('lastDay') || undefined} />
              </Field>
            </div>

            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm leading-none font-medium">{t('What the provider may do')}</legend>
              <p className="text-xs text-muted-foreground">{t('Choose at least one before proposing. Every grant is limited to the sites below.')}</p>
              <GrantPicker value={draft.grants} onChange={(v) => set('grants', v)} invalid={!!shown('grants')} />
              {shown('grants') && (
                <p role="alert" className="text-xs text-destructive">
                  {shown('grants')}
                </p>
              )}
            </fieldset>

            <Field
              label={t('Sites')}
              htmlFor="agr-sites"
              error={shown('siteIds')}
              hint={
                canPickSites
                  ? t('Your offices or sites the agreement covers. Leave empty for all of them.')
                  : customerId === companyId && !can('pois')
                    ? t('You need access to Places to choose sites. Without a choice the agreement covers all sites.')
                    : t('Only the customer company can choose its sites. Empty means all customer sites.')
              }
            >
              {canPickSites ? (
                <MultiSelect
                  id="agr-sites"
                  value={draft.siteIds}
                  onChange={(v) => set('siteIds', v)}
                  options={pois.options}
                  loading={pois.loading}
                  placeholder={t('All sites')}
                  searchPlaceholder={t('Search places…')}
                  emptyText={t('No places found')}
                />
              ) : (
                <Input id="agr-sites" readOnly value={draft.siteIds.length ? t('{{n}} site(s)', { n: draft.siteIds.length }) : t('All sites')} />
              )}
            </Field>

            <RadioCards<TransportDataProfile>
              name="agr-profile"
              legend={t('Passenger data shared')}
              value={draft.dataProfile}
              onChange={(v) => set('dataProfile', v)}
              options={TRANSPORT_DATA_PROFILES.map((p) => ({ value: p, label: DATA_PROFILE_META[p].label, description: DATA_PROFILE_META[p].description }))}
            />

            {duplicate ? (
              <AgreementError error={new Error(t('These two companies already have an open agreement. Open it from the list, or end it before creating a new one.'))} />
            ) : notFound ? (
              <AgreementError error={new Error(t('No business company with that ID was found. Check the ID with the other company.'))} />
            ) : (
              <AgreementError
                error={mutation.error}
                onReload={() => {
                  invalidate();
                  onOpenChange(false);
                }}
              />
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Spinner />}
              {record ? t('Save draft') : t('Create draft')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
