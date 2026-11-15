import type { CreatePricingVehicleRateRequest, PricingVehicleRateDto, UpdatePricingVehicleRateRequest } from '@veetracer/shared';
import { CarIcon, CheckIcon, PencilIcon, PlusIcon, SendIcon, ShieldAlertIcon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import { api } from '@/lib/api';
import { canDecide } from './access';
import { ComponentsEditor } from './ComponentsEditor';
import { componentsToRows, KIND_SPECS, rowsToComponents, validateRow, type ComponentRow } from './components';
import { VehiclePicker } from './DedicatedVehicles';
import { PRICING_ERROR_MESSAGES } from './errors';
import { P, useContractOptions, usePricingMutation, usePricingQuery } from './pricing-api';
import { Empty, FilterBar, Labeled, QueryView, ReasonDialog, ScrollTable, Sel, SimpleDialog, StatusPill, Td, Th, todayYmd, PricingShell } from './ui';

function RateDialog({ open, onOpenChange, contractId, currency, rate }: { open: boolean; onOpenChange: (o: boolean) => void; contractId: string; currency: string; rate: PricingVehicleRateDto | null }) {
  const { t } = useTranslation();
  const [objectId, setObjectId] = useState<string | null>(rate?.objectId ?? null);
  const [validFrom, setValidFrom] = useState(rate?.validFrom ?? todayYmd());
  const [validTo, setValidTo] = useState(rate?.validTo ?? '');
  const [reason, setReason] = useState(rate?.reason ?? '');
  const [rows, setRows] = useState<ComponentRow[]>(() => componentsToRows(rate?.componentOverrides ?? []));
  const [showErrors, setShowErrors] = useState(false);
  useEffect(() => setShowErrors(false), [open]);
  const save = usePricingMutation(
    () => {
      const componentOverrides = rowsToComponents(rows);
      if (rate) return api.patch(`${P}/contracts/${contractId}/vehicle-rates/${rate.id}`, { expectedVersion: rate.version, validFrom, validTo: validTo || null, componentOverrides, reason: reason || null } satisfies UpdatePricingVehicleRateRequest);
      return api.post(`${P}/contracts/${contractId}/vehicle-rates`, { objectId: objectId!, validFrom, validTo: validTo || null, componentOverrides, reason: reason || null } satisfies CreatePricingVehicleRateRequest);
    },
    { success: rate ? 'Vehicle rate updated' : 'Vehicle rate created', toastError: false, onSuccess: () => onOpenChange(false) },
  );
  const invalid = !objectId || rows.length === 0 || rows.some((r) => Object.keys(validateRow(r)).length > 0);
  return (
    <SimpleDialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={rate ? 'Edit vehicle rate' : 'New vehicle rate'}
      description="These components replace the contract’s components of the same kind for this vehicle. A second user approves the rate before it applies."
      pending={save.isPending}
      error={save.error}
      onSubmit={() => {
        setShowErrors(true);
        if (!invalid) save.mutate(undefined);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Labeled label="Vehicle" className="sm:col-span-2" error={showErrors && !objectId ? 'Required' : null}>
          {(id) => (rate ? <Input id={id} value={rate.objectName} readOnly /> : <VehiclePicker id={id} value={objectId} onChange={setObjectId} />)}
        </Labeled>
        <Labeled label="Valid from">{(id) => <Input id={id} type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />}</Labeled>
        <Labeled label="Valid until (exclusive)">{(id) => <Input id={id} type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />}</Labeled>
        <Labeled label="Reason" className="sm:col-span-2">{(id) => <Input id={id} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}</Labeled>
      </div>
      <ComponentsEditor rows={rows} onChange={setRows} currency={currency} showErrors={showErrors} />
      {showErrors && rows.length === 0 && <p className="text-sm text-destructive">{t('Add at least one component.')}</p>}
    </SimpleDialog>
  );
}

/** Pricing → Vehicle rates (menu pricing_vehicle_rates): vehicle-level overrides of one contract (precedence 2). */
export function VehicleRatesPage() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const [params, setParams] = useSearchParams();
  const { contracts, loading } = useContractOptions();
  const contractId = params.get('contract') ?? contracts[0]?.id ?? '';
  const contract = contracts.find((c) => c.id === contractId);
  const detail = usePricingQuery<{ allowVehicleOverrides: boolean; currency: string; status: string }>(['contract', contractId], `${P}/contracts/${contractId}`, undefined, !!contractId);
  const list = usePricingQuery<PricingVehicleRateDto[]>(['vehicle-rates', contractId], `${P}/contracts/${contractId}/vehicle-rates`, undefined, !!contractId);
  const [editing, setEditing] = useState<PricingVehicleRateDto | 'new' | null>(null);
  const [rejecting, setRejecting] = useState<PricingVehicleRateDto | null>(null);
  const permitted = detail.data?.allowVehicleOverrides ?? false;
  const currency = detail.data?.currency ?? contract?.currency ?? 'INR';
  const act = usePricingMutation(({ rate, action }: { rate: PricingVehicleRateDto; action: 'submit' | 'approve' }) => api.post(`${P}/contracts/${contractId}/vehicle-rates/${rate.id}/${action}`, {}), { success: 'Vehicle rate updated' });
  const reject = usePricingMutation((reason: string) => api.post(`${P}/contracts/${contractId}/vehicle-rates/${rejecting!.id}/reject`, { reason }), { success: 'Vehicle rate rejected', toastError: false, onSuccess: () => setRejecting(null) });
  return (
    <PricingShell
      title={t('Vehicle rates')}
      description={t('Rates for one vehicle that replace the contract’s components of the same kind (only when the contract permits it).')}
      actions={
        can('pricing_vehicle_rates', 'create') &&
        contractId && (
          <Button size="sm" onClick={() => setEditing('new')} disabled={!permitted} title={permitted ? undefined : t(PRICING_ERROR_MESSAGES.VEHICLE_OVERRIDE_NOT_PERMITTED!)}>
            <PlusIcon /> {t('New vehicle rate')}
          </Button>
        )
      }
    >
      <FilterBar>
        <Labeled label="Contract">
          {(id) => <Sel id={id} value={contractId} disabled={loading} onChange={(v) => setParams({ contract: v }, { replace: true })} options={contracts.map((c) => ({ value: c.id, label: `${c.name} · ${c.customerName}` }))} allLabel={contracts.length ? undefined : 'No contracts'} />}
        </Labeled>
      </FilterBar>
      {contractId && detail.data && (
        <div className={permitted ? 'rounded-lg border bg-success-soft px-3 py-2 text-sm text-success-fg' : 'flex items-start gap-2 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-sm'}>
          {permitted ? (
            t('This contract permits vehicle-level rates.')
          ) : (
            <>
              <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-warning-fg" aria-hidden />
              <span>
                {t('Vehicle rates are not permitted on this contract (VEHICLE_OVERRIDE_NOT_PERMITTED). Trips on every vehicle use the contract components.')}{' '}
                {can('pricing_contracts') && (
                  <Link className="font-medium text-primary hover:underline" to={`/pricing/contracts/${contractId}`}>
                    {t('Open the contract')}
                  </Link>
                )}
              </span>
            </>
          )}
        </div>
      )}
      {!contractId ? (
        !loading && <Empty icon={CarIcon} title="No contracts yet" description="Vehicle rates belong to a contract. Create a contract first." />
      ) : (
        <QueryView query={list}>
          {(rows) =>
            rows.length === 0 ? (
              <Empty icon={CarIcon} title="No vehicle rates" description="All vehicles use the contract components." />
            ) : (
              <ScrollTable label={t('Vehicle rates')} minWidth={820}>
                <thead>
                  <tr>
                    <Th>{t('Vehicle')}</Th>
                    <Th>{t('Components')}</Th>
                    <Th>{t('Validity')}</Th>
                    <Th>{t('Status')}</Th>
                    <Th>{t('Reason')}</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const decision = canDecide({ hasApprove: can('pricing_vehicle_rates', 'approve'), submittedById: r.submittedById, meId: me?.user.id });
                    return (
                      <tr key={r.id}>
                        <Td className="font-medium">{r.objectName}</Td>
                        <Td className="text-xs">{r.componentOverrides.map((c) => t(KIND_SPECS[c.kind]?.label ?? c.kind)).join(', ')}</Td>
                        <Td className="whitespace-nowrap">
                          {r.validFrom} – {r.validTo ?? t('open')}
                        </Td>
                        <Td>
                          <StatusPill status={r.status} />
                        </Td>
                        <Td className="max-w-56 text-xs">{r.reason ?? '—'}</Td>
                        <Td right>
                          <span className="flex flex-wrap justify-end gap-1">
                            {r.status === 'DRAFT' && can('pricing_vehicle_rates', 'edit') && (
                              <>
                                <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                                  <PencilIcon /> {t('Edit')}
                                </Button>
                                <Button size="sm" variant="ghost" disabled={!permitted} onClick={() => act.mutate({ rate: r, action: 'submit' })}>
                                  <SendIcon /> {t('Submit')}
                                </Button>
                              </>
                            )}
                            {r.status === 'PENDING_APPROVAL' && can('pricing_vehicle_rates', 'approve') && (
                              <>
                                <Button size="sm" variant="ghost" disabled={!decision.allowed} title={decision.ownSubmission ? t('You can’t approve your own submission.') : undefined} onClick={() => act.mutate({ rate: r, action: 'approve' })}>
                                  <CheckIcon /> {t('Approve')}
                                </Button>
                                <Button size="sm" variant="ghost" disabled={!decision.allowed} onClick={() => setRejecting(r)}>
                                  <XIcon /> {t('Reject')}
                                </Button>
                              </>
                            )}
                            {r.status === 'PENDING_APPROVAL' && decision.ownSubmission && can('pricing_vehicle_rates', 'approve') && <span className="text-xs text-muted-foreground">{t('You can’t approve your own submission.')}</span>}
                          </span>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </ScrollTable>
            )
          }
        </QueryView>
      )}
      {editing && <RateDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} contractId={contractId} currency={currency} rate={editing === 'new' ? null : editing} />}
      <ReasonDialog open={!!rejecting} onOpenChange={(o) => !o && setRejecting(null)} title="Reject vehicle rate" pending={reject.isPending} error={reject.error} onSubmit={(r) => reject.mutate(r)} confirmLabel="Reject" destructive />
    </PricingShell>
  );
}
