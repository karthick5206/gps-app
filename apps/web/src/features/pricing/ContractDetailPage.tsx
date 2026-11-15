import type { BranchDto, CreatePricingVersionRequest, PricingContractDto, PricingContractVersionDto, PricingPolicies, ReplacePricingComponentsRequest } from '@veetracer/shared';
import { validateComponents } from '@veetracer/shared';
import { CheckIcon, CopyPlusIcon, HistoryIcon, PauseIcon, PencilIcon, PlayIcon, SaveIcon, SendIcon, TimerOffIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import { HistorySheet } from '@/features/masters/HistorySheet';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { canDecide } from './access';
import { ComponentsEditor } from './ComponentsEditor';
import { componentsToRows, KIND_SPECS, rowsToComponents, validateRow, type ComponentRow } from './components';
import { ContractForm } from './ContractForm';
import { DedicatedVehicles } from './DedicatedVehicles';
import { P, useCalendars, useContract, usePricingMutation, useTaxProfiles } from './pricing-api';
import { PreviewPanel } from './PreviewPanel';
import { enumLabel, Facts, Labeled, PricingShell, QueryView, ReasonDialog, Section, Sel, SimpleDialog, StatusPill, todayYmd } from './ui';

/** Short "what changed" list of a version against the active one (approver's diff, doc 19 §6). */
function versionDiff(next: PricingContractVersionDto, base: PricingContractVersionDto | undefined): string[] {
  if (!base) return [];
  const key = (c: PricingContractVersionDto['components'][number]) => JSON.stringify({ p: c.params, s: c.scope ?? null, t: c.taxCode ?? null, c: c.covers ?? [] });
  const byKind = (v: PricingContractVersionDto) => {
    const m = new Map<string, string[]>();
    for (const c of v.components) m.set(c.kind, [...(m.get(c.kind) ?? []), key(c)]);
    return m;
  };
  const a = byKind(base);
  const b = byKind(next);
  const out: string[] = [];
  for (const [k, vals] of b) {
    if (!a.has(k)) out.push(`+ ${KIND_SPECS[k as keyof typeof KIND_SPECS]?.label ?? k}`);
    else if (JSON.stringify(a.get(k)) !== JSON.stringify(vals)) out.push(`~ ${KIND_SPECS[k as keyof typeof KIND_SPECS]?.label ?? k}`);
  }
  for (const k of a.keys()) if (!b.has(k)) out.push(`− ${KIND_SPECS[k as keyof typeof KIND_SPECS]?.label ?? k}`);
  if (JSON.stringify(next.policies ?? {}) !== JSON.stringify(base.policies ?? {})) out.push('~ Policies');
  if (next.validFrom !== base.validFrom || next.validTo !== base.validTo) out.push('~ Validity');
  return out;
}

function VersionPanel({ contract, version }: { contract: PricingContractDto; version: PricingContractVersionDto }) {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const calendars = useCalendars();
  const editable = version.status === 'DRAFT' && can('pricing_contracts', 'edit');
  const [rows, setRows] = useState<ComponentRow[]>(() => componentsToRows(version.components));
  const [policies, setPolicies] = useState<PricingPolicies>(version.policies ?? {});
  const [validFrom, setValidFrom] = useState(version.validFrom);
  const [validTo, setValidTo] = useState(version.validTo ?? '');
  const [dirty, setDirty] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [approving, setApproving] = useState(false);
  useEffect(() => {
    setRows(componentsToRows(version.components));
    setPolicies(version.policies ?? {});
    setValidFrom(version.validFrom);
    setValidTo(version.validTo ?? '');
    setDirty(false);
    setShowErrors(false);
  }, [version]);
  const base = `${P}/contracts/${contract.id}/versions/${version.id}`;
  const rowErrors = rows.some((r) => Object.keys(validateRow(r)).length > 0);
  const engineIssues = useMemo(() => {
    if (rowErrors) return [];
    try {
      return validateComponents(rowsToComponents(rows) as Parameters<typeof validateComponents>[0], policies);
    } catch {
      return [];
    }
  }, [rows, policies, rowErrors]);
  const save = usePricingMutation(() => api.put(`${base}/components`, { components: rowsToComponents(rows), policies, validFrom, validTo: validTo || null } satisfies ReplacePricingComponentsRequest), { success: 'Components saved', onSuccess: () => setDirty(false) });
  const submit = usePricingMutation(() => api.post(`${base}/submit`, {}), { success: 'Submitted for approval' });
  const approve = usePricingMutation((note: string) => api.post(`${base}/approve`, { note: note || null }), { success: 'Version approved and active', toastError: false, onSuccess: () => setApproving(false) });
  const reject = usePricingMutation((reason: string) => api.post(`${base}/reject`, { reason }), { success: 'Version rejected', toastError: false, onSuccess: () => setRejecting(false) });
  const decision = canDecide({ hasApprove: can('pricing_contracts', 'approve'), submittedById: version.submittedById, meId: me?.user.id });
  const active = contract.versions.find((v) => v.status === 'ACTIVE' && v.id !== version.id);
  const diff = version.status === 'PENDING_APPROVAL' ? versionDiff(version, active) : [];
  const change = (fn: () => void) => {
    fn();
    setDirty(true);
  };
  const trySave = () => {
    setShowErrors(true);
    if (!rowErrors) save.mutate(undefined);
  };
  const policyBool = (k: 'alsoChargeTrips' | 'chargeWithoutTrips' | 'tripOverrideNeedsApproval', label: string, hint: string, dflt: boolean) => (
    <label className="flex items-start gap-2 text-sm">
      <Checkbox className="mt-0.5" checked={(policies[k] as boolean | undefined) ?? dflt} disabled={!editable} onCheckedChange={(c) => change(() => setPolicies({ ...policies, [k]: !!c }))} />
      <span>
        {t(label)}
        <span className="block text-xs text-muted-foreground">{t(hint)}</span>
      </span>
    </label>
  );

  return (
    <div className="space-y-4">
      <Section
        title={
          <span className="flex flex-wrap items-center gap-2">
            {t('Version {{n}}', { n: version.versionNo })} <StatusPill status={version.status} />
          </span>
        }
        description={
          <>
            {version.submittedAt && `${t('Submitted')} ${formatDateTime(version.submittedAt)}. `}
            {version.approvedAt && `${t('Approved')} ${formatDateTime(version.approvedAt)}. `}
            {version.rejectReason && `${t('Rejected')}: ${version.rejectReason}`}
          </>
        }
        actions={
          <>
            {editable && (
              <>
                <Button size="sm" variant="outline" onClick={trySave} disabled={save.isPending || !dirty}>
                  <SaveIcon /> {t('Save')}
                </Button>
                <Button size="sm" onClick={() => submit.mutate(undefined)} disabled={submit.isPending || dirty || rows.length === 0} title={dirty ? t('Save the changes first') : undefined}>
                  <SendIcon /> {t('Submit for approval')}
                </Button>
              </>
            )}
            {version.status === 'PENDING_APPROVAL' && can('pricing_contracts', 'approve') && (
              <>
                <Button size="sm" variant="outline" onClick={() => setRejecting(true)} disabled={!decision.allowed}>
                  <XIcon /> {t('Reject')}
                </Button>
                <Button size="sm" onClick={() => setApproving(true)} disabled={!decision.allowed}>
                  <CheckIcon /> {t('Approve')}
                </Button>
              </>
            )}
          </>
        }
      >
        {version.status === 'PENDING_APPROVAL' && decision.ownSubmission && can('pricing_contracts', 'approve') && <p className="mb-3 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-sm">{t('You can’t approve your own submission. Another user with approval rights must decide.')}</p>}
        {version.status === 'PENDING_APPROVAL' && !can('pricing_contracts', 'approve') && <p className="mb-3 text-sm text-muted-foreground">{t('Waiting for a user with approval rights.')}</p>}
        {diff.length > 0 && (
          <div className="mb-3 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
            <p className="font-medium">{t('Changes against active version {{n}}', { n: active?.versionNo })}</p>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {diff.map((d) => (
                <li key={d}>
                  <Badge variant="outline">{d.slice(0, 2)}{t(d.slice(2))}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="mb-4 grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-4">
          <Labeled label="Valid from">{(id) => <Input id={id} type="date" value={validFrom} readOnly={!editable} onChange={(e) => change(() => setValidFrom(e.target.value))} />}</Labeled>
          <Labeled label="Valid until (exclusive)" hint="Empty = open-ended">
            {(id) => <Input id={id} type="date" value={validTo} readOnly={!editable} onChange={(e) => change(() => setValidTo(e.target.value))} />}
          </Labeled>
          <Labeled label="Holiday calendar">
            {(id) => <Sel id={id} value={policies.calendarId ?? ''} disabled={!editable} allLabel="None" onChange={(v) => change(() => setPolicies({ ...policies, calendarId: v || null }))} options={(calendars.data ?? []).map((c) => ({ value: c.id, label: c.name }))} />}
          </Labeled>
        </div>
        <div className="mb-4 grid gap-3 md:grid-cols-3">
          {policyBool('chargeWithoutTrips', 'Charge availability without trips', 'Bill the availability fee even in a period without any trip.', true)}
          {policyBool('alsoChargeTrips', 'Also charge trips on dedicated vehicles', 'Hybrid: trips are priced per trip too (only when no fee covers trips).', false)}
          {policyBool('tripOverrideNeedsApproval', 'Trip overrides need approval', 'A negotiated trip price waits for a second user.', false)}
        </div>
        <ComponentsEditor rows={rows} currency={contract.currency} showErrors={showErrors} onChange={editable ? (r) => change(() => setRows(r)) : undefined} />
        {showErrors && rowErrors && <FormError message={t('Some pricing components are invalid. Check the highlighted cards.')} />}
        {engineIssues.length > 0 && (
          <ul className="mt-3 space-y-1 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
            {engineIssues.map((i, k) => (
              <li key={k}>
                <span className="font-medium">{t(enumLabel(i.code))}</span>: {i.message}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <PreviewPanel contractId={contract.id} currency={contract.currency} versionId={version.id} components={editable ? rowsToComponents(rows) : undefined} policies={editable ? policies : undefined} />
      <ReasonDialog open={rejecting} onOpenChange={setRejecting} title="Reject version" pending={reject.isPending} error={reject.error} onSubmit={(r) => reject.mutate(r)} confirmLabel="Reject" destructive />
      <ReasonDialog open={approving} onOpenChange={setApproving} title="Approve version" description="The version becomes active from its start date and supersedes the current one from then." reasonLabel="Note" reasonRequired={false} pending={approve.isPending} error={approve.error} onSubmit={(r) => approve.mutate(r)} confirmLabel="Approve" />
    </div>
  );
}

/** Pricing → Company contracts → one contract (doc 19 §6 contract screen). */
export function ContractDetailPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const q = useContract(id);
  const taxProfiles = useTaxProfiles();
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: can('branches') });
  const [versionId, setVersionId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const [lifecycle, setLifecycle] = useState<'suspend' | 'resume' | 'expire' | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [newVersion, setNewVersion] = useState(false);
  const [nv, setNv] = useState({ validFrom: todayYmd(), validTo: '', copyFromVersionId: '' });
  const c = q.data;
  const life = usePricingMutation((reason: string) => api.post(`${P}/contracts/${c!.id}/${lifecycle}`, { reason, expectedVersion: c!.version }), { success: 'Contract updated', toastError: false, onSuccess: () => setLifecycle(null) });
  const del = usePricingMutation(() => api.delete(`${P}/contracts/${c!.id}`), { success: 'Contract deleted', onSuccess: () => navigate('/pricing/contracts') });
  const createVersion = usePricingMutation(
    () => api.post<PricingContractVersionDto>(`${P}/contracts/${c!.id}/versions`, { validFrom: nv.validFrom, validTo: nv.validTo || null, copyFromVersionId: nv.copyFromVersionId || null } satisfies CreatePricingVersionRequest),
    { success: 'Draft version created', toastError: false, onSuccess: (v) => (setNewVersion(false), setVersionId(v.id)) },
  );
  const versions = useMemo(() => [...(c?.versions ?? [])].sort((a, b) => b.versionNo - a.versionNo), [c?.versions]);
  const selected = versions.find((v) => v.id === versionId) ?? versions.find((v) => v.status === 'DRAFT' || v.status === 'PENDING_APPROVAL') ?? versions.find((v) => v.status === 'ACTIVE') ?? versions[0];
  const hasDraft = versions.some((v) => v.status === 'DRAFT' || v.status === 'PENDING_APPROVAL');
  const LIFE_TITLE = { suspend: 'Suspend contract', resume: 'Resume contract', expire: 'Expire contract' } as const;

  return (
    <QueryView query={q}>
      {(contract) => (
        <PricingShell
          title={contract.name}
          description={
            <span className="flex flex-wrap items-center gap-2">
              <StatusPill status={contract.status} /> {contract.customerName}
            </span>
          }
          actions={
            <>
              <Button size="sm" variant="outline" onClick={() => setHistory(true)}>
                <HistoryIcon /> {t('History')}
              </Button>
              {can('pricing_contracts', 'edit') && contract.status !== 'EXPIRED' && (
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                  <PencilIcon /> {t('Edit')}
                </Button>
              )}
              {can('pricing_contracts', 'approve') && contract.status === 'ACTIVE' && (
                <Button size="sm" variant="outline" onClick={() => setLifecycle('suspend')}>
                  <PauseIcon /> {t('Suspend')}
                </Button>
              )}
              {can('pricing_contracts', 'approve') && contract.status === 'SUSPENDED' && (
                <Button size="sm" variant="outline" onClick={() => setLifecycle('resume')}>
                  <PlayIcon /> {t('Resume')}
                </Button>
              )}
              {can('pricing_contracts', 'approve') && (contract.status === 'ACTIVE' || contract.status === 'SUSPENDED') && (
                <Button size="sm" variant="outline" onClick={() => setLifecycle('expire')}>
                  <TimerOffIcon /> {t('Expire')}
                </Button>
              )}
              {can('pricing_contracts', 'delete') && contract.status === 'DRAFT' && (
                <Button size="sm" variant="outline" onClick={() => setDeleting(true)}>
                  <Trash2Icon /> {t('Delete')}
                </Button>
              )}
            </>
          }
        >
          <Section title={t('Contract')}>
            <Facts
              items={[
                ['Customer', contract.customerCompanyId ? contract.customerName : `${contract.customerName} (${t(contract.isDefault ? 'Default contract' : 'Internal')})`],
                ['Reference', contract.reference ?? '—'],
                ['Currency', contract.currency],
                ['Billing frequency', t(enumLabel(contract.billingFrequency))],
                ['Payment terms', t('{{n}} days', { n: contract.paymentTermsDays })],
                ['Tax profile', taxProfiles.data?.find((p) => p.id === contract.taxProfileId)?.name ?? (contract.taxProfileId ? '…' : t('None'))],
                ['Branches', contract.branchIds.length ? contract.branchIds.map((b) => branches.options.find((o) => o.value === b)?.label ?? '…').join(', ') : t('All branches')],
                ['Billable distance from', t(enumLabel(contract.distanceSource))],
                ['When GPS is missing', t(enumLabel(contract.onMissingGps))],
                ['Vehicle rates permitted', contract.allowVehicleOverrides ? t('Yes') : t('No')],
                ['Trip price overrides permitted', contract.allowTripOverrides ? t('Yes') : t('No')],
                ['Rounding', t(enumLabel(contract.roundingMode))],
                ...(contract.suspendedReason ? ([['Suspended', `${contract.suspendedAt ? formatDateTime(contract.suspendedAt) : ''} · ${contract.suspendedReason}`]] as [string, string][]) : []),
              ]}
            />
          </Section>

          <div className="flex flex-wrap items-end gap-2">
            <div role="tablist" aria-label={t('Versions')} className="flex max-w-full flex-wrap gap-1 rounded-lg bg-muted p-1">
              {versions.map((v) => (
                <button
                  key={v.id}
                  role="tab"
                  type="button"
                  aria-selected={selected?.id === v.id}
                  onClick={() => setVersionId(v.id)}
                  className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-selected:bg-card aria-selected:text-foreground aria-selected:shadow-sm"
                >
                  v{v.versionNo} · {t(enumLabel(v.status))}
                </button>
              ))}
            </div>
            {can('pricing_contracts', 'edit') && !hasDraft && contract.status !== 'EXPIRED' && (
              <Button size="sm" variant="outline" onClick={() => setNewVersion(true)}>
                <CopyPlusIcon /> {t('New version (re-price)')}
              </Button>
            )}
          </div>
          {selected && <VersionPanel key={selected.id} contract={contract} version={selected} />}
          <DedicatedVehicles contract={contract} />

          {editing && <ContractForm open={editing} onOpenChange={setEditing} contract={contract} />}
          <HistorySheet endpoint={`${P}/contracts`} target={history ? { id: contract.id, label: contract.name } : null} onClose={() => setHistory(false)} />
          <ReasonDialog open={!!lifecycle} onOpenChange={(o) => !o && setLifecycle(null)} title={lifecycle ? LIFE_TITLE[lifecycle] : ''} description={lifecycle === 'expire' ? 'An expired contract no longer prices trips. This cannot be undone.' : lifecycle === 'suspend' ? 'Trips are not priced while the contract is suspended.' : undefined} destructive={lifecycle !== 'resume'} pending={life.isPending} error={life.error} onSubmit={(r) => life.mutate(r)} />
          <ConfirmDialog open={deleting} onOpenChange={setDeleting} title={t('Delete contract')} description={t('The draft contract and its versions are deleted.')} destructive pending={del.isPending} onConfirm={() => del.mutate(undefined)} confirmLabel={t('Delete')} />
          <SimpleDialog open={newVersion} onOpenChange={setNewVersion} title="New version" description="A draft copy of the chosen version. Change rates and validity, then submit it for approval." pending={createVersion.isPending} error={createVersion.error} submitLabel="Create draft" onSubmit={() => createVersion.mutate(undefined)}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Labeled label="Valid from">{(fid) => <Input id={fid} type="date" value={nv.validFrom} onChange={(e) => setNv({ ...nv, validFrom: e.target.value })} />}</Labeled>
              <Labeled label="Valid until (exclusive)">{(fid) => <Input id={fid} type="date" value={nv.validTo} onChange={(e) => setNv({ ...nv, validTo: e.target.value })} />}</Labeled>
              <Labeled label="Copy from" className="sm:col-span-2">
                {(fid) => <Sel id={fid} value={nv.copyFromVersionId} allLabel="Latest version" onChange={(v) => setNv({ ...nv, copyFromVersionId: v })} options={versions.map((v) => ({ value: v.id, label: `v${v.versionNo} · ${t(enumLabel(v.status))}` }))} />}
              </Labeled>
            </div>
          </SimpleDialog>
        </PricingShell>
      )}
    </QueryView>
  );
}
