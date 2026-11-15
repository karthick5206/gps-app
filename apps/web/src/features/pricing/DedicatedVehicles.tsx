import { DOWNTIME_KINDS, REPLACEMENT_BILLING, type BranchDto, type CreatePricingDowntimeRequest, type CreatePricingVehicleAssignmentRequest, type PricingContractDto, type PricingVehicleAssignmentDto, type TrackedObjectDto } from '@veetracer/shared';
import { CarIcon, PlusIcon, WrenchIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Combobox, type Option } from '@/components/ui/multi-select';
import { useAuth } from '@/features/auth/auth-context';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api } from '@/lib/api';
import { P, usePricingMutation, usePricingQuery } from './pricing-api';
import { Empty, enumLabel, Labeled, QueryView, ReasonDialog, ScrollTable, Section, Sel, SimpleDialog, StatusPill, Td, Th, todayYmd } from './ui';

export const objectOption = (o: TrackedObjectDto): Option => ({ value: o.id, label: o.name, description: o.plateNumber ?? undefined });
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Vehicle picker (server search on /objects). */
export function VehiclePicker({ id, value, onChange }: { id?: string; value: string | null; onChange: (v: string | null) => void }) {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const objects = useEntityOptions<TrackedObjectDto>('/objects', objectOption, { q, enabled: can('objects') });
  return <Combobox id={id} value={value} onChange={onChange} options={objects.options} loading={objects.loading} onSearch={setQ} />;
}

/** Dedicated vehicles of a contract (availability billing): assignment, replacement, operating hours, downtime. */
export function DedicatedVehicles({ contract }: { contract: PricingContractDto }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const editable = can('pricing_contracts', 'edit') && contract.status !== 'EXPIRED';
  const list = usePricingQuery<PricingVehicleAssignmentDto[]>(['vehicles', contract.id], `${P}/contracts/${contract.id}/vehicles`);
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: can('branches') });
  const branchName = (id: string | null) => (id ? (branches.options.find((b) => b.value === id)?.label ?? '—') : t('All'));
  const [adding, setAdding] = useState(false);
  const [downtimeFor, setDowntimeFor] = useState<PricingVehicleAssignmentDto | null>(null);
  const [ending, setEnding] = useState<PricingVehicleAssignmentDto | null>(null);
  const [form, setForm] = useState({ objectId: null as string | null, branchId: '', validFrom: todayYmd(), validTo: '', from: '', to: '', weekdays: [] as number[], replacesAssignmentId: '', replacementBilling: 'ORIGINAL' as (typeof REPLACEMENT_BILLING)[number] });
  const [dt, setDt] = useState({ fromDate: todayYmd(), toDate: todayYmd(), kind: 'BREAKDOWN' as (typeof DOWNTIME_KINDS)[number], billable: false });
  const add = usePricingMutation(
    () => {
      const body: CreatePricingVehicleAssignmentRequest = {
        objectId: form.objectId!,
        branchId: form.branchId || null,
        validFrom: form.validFrom,
        validTo: form.validTo || null,
        operatingHours: { ...(form.from ? { from: form.from } : {}), ...(form.to ? { to: form.to } : {}), ...(form.weekdays.length ? { weekdays: form.weekdays } : {}) },
        replacesAssignmentId: form.replacesAssignmentId || null,
        replacementBilling: form.replacementBilling,
      };
      return api.post(`${P}/contracts/${contract.id}/vehicles`, body);
    },
    { success: 'Vehicle added', toastError: false, onSuccess: () => setAdding(false) },
  );
  const addDowntime = usePricingMutation((reason: string) => api.post(`${P}/contracts/${contract.id}/vehicles/${downtimeFor!.id}/downtime`, { ...dt, reason } satisfies CreatePricingDowntimeRequest), { success: 'Downtime recorded', toastError: false, onSuccess: () => setDowntimeFor(null) });
  const end = usePricingMutation((_reason: string) => api.patch(`${P}/contracts/${contract.id}/vehicles/${ending!.id}`, { expectedVersion: ending!.version, status: 'ENDED', validTo: todayYmd() }), { success: 'Assignment ended', toastError: false, onSuccess: () => setEnding(null) });

  return (
    <Section
      title={t('Dedicated vehicles')}
      description={t('Vehicles billed by availability under this contract, with replacements and downtime.')}
      actions={
        editable && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <PlusIcon /> {t('Add vehicle')}
          </Button>
        )
      }
    >
      <QueryView query={list} rows={2}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty icon={CarIcon} title="No dedicated vehicles" description="Add vehicles when the contract bills availability (fixed fee per vehicle)." />
          ) : (
            <ScrollTable label={t('Dedicated vehicles')} minWidth={820}>
              <thead>
                <tr>
                  <Th>{t('Vehicle')}</Th>
                  <Th>{t('Branch')}</Th>
                  <Th>{t('Validity')}</Th>
                  <Th>{t('Operating hours')}</Th>
                  <Th>{t('Downtime')}</Th>
                  <Th>{t('Status')}</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <Td>
                      <span className="font-medium">{a.objectName}</span>
                      {a.replacesAssignmentId && <span className="block text-xs text-muted-foreground">{t('Replacement')} · {t(enumLabel(a.replacementBilling))}</span>}
                    </Td>
                    <Td>{branchName(a.branchId)}</Td>
                    <Td className="whitespace-nowrap">
                      {a.validFrom} – {a.validTo ?? t('open')}
                    </Td>
                    <Td className="text-xs">
                      {a.operatingHours.from || a.operatingHours.to ? `${a.operatingHours.from ?? '00:00'}–${a.operatingHours.to ?? '24:00'}` : t('Any time')}
                      {a.operatingHours.weekdays?.length ? ` · ${a.operatingHours.weekdays.map((d) => t(WEEKDAYS[d - 1])).join(', ')}` : ''}
                    </Td>
                    <Td className="text-xs">
                      {a.downtimes.length === 0
                        ? '—'
                        : a.downtimes.map((d) => (
                            <span key={d.id} className="block">
                              {d.fromDate}–{d.toDate} · {t(enumLabel(d.kind))}
                              {d.billable ? ` (${t('billable')})` : ''}
                            </span>
                          ))}
                    </Td>
                    <Td>
                      <StatusPill status={a.status} />
                    </Td>
                    <Td right>
                      {editable && a.status === 'ACTIVE' && (
                        <span className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setDowntimeFor(a)}>
                            <WrenchIcon /> {t('Downtime')}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEnding(a)}>
                            {t('End')}
                          </Button>
                        </span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </ScrollTable>
          )
        }
      </QueryView>

      <SimpleDialog open={adding} onOpenChange={setAdding} title="Add dedicated vehicle" pending={add.isPending} error={add.error} submitLabel="Add" onSubmit={() => form.objectId && add.mutate(undefined)}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Labeled label="Vehicle" className="sm:col-span-2">
            {(id) => <VehiclePicker id={id} value={form.objectId} onChange={(v) => setForm({ ...form, objectId: v })} />}
          </Labeled>
          {can('branches') && <Labeled label="Branch">{(id) => <Sel id={id} value={form.branchId} allLabel="None" onChange={(v) => setForm({ ...form, branchId: v })} options={branches.options} />}</Labeled>}
          <Labeled label="Valid from">{(id) => <Input id={id} type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />}</Labeled>
          <Labeled label="Valid until (exclusive)">{(id) => <Input id={id} type="date" value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} />}</Labeled>
          <Labeled label="Operating from">{(id) => <Input id={id} type="time" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />}</Labeled>
          <Labeled label="Operating to">{(id) => <Input id={id} type="time" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />}</Labeled>
          <fieldset className="sm:col-span-2">
            <legend className="text-xs font-medium text-muted-foreground">{t('Operating days (none = every day)')}</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {WEEKDAYS.map((d, i) => (
                <label key={d} className="flex items-center gap-1.5 text-sm">
                  <Checkbox checked={form.weekdays.includes(i + 1)} onCheckedChange={(c) => setForm({ ...form, weekdays: c ? [...form.weekdays, i + 1].sort() : form.weekdays.filter((x) => x !== i + 1) })} />
                  {t(d)}
                </label>
              ))}
            </div>
          </fieldset>
          <Labeled label="Replaces">
            {(id) => (
              <Sel id={id} value={form.replacesAssignmentId} allLabel="Not a replacement" onChange={(v) => setForm({ ...form, replacesAssignmentId: v })} options={(list.data ?? []).filter((a) => a.status === 'ACTIVE').map((a) => ({ value: a.id, label: a.objectName }))} />
            )}
          </Labeled>
          {form.replacesAssignmentId && (
            <Labeled label="Replacement billed">
              {(id) => <Sel id={id} value={form.replacementBilling} onChange={(v) => setForm({ ...form, replacementBilling: v as typeof form.replacementBilling })} options={REPLACEMENT_BILLING.map((r) => ({ value: r, label: r === 'ORIGINAL' ? t('As the original vehicle') : t('Separately') }))} />}
            </Labeled>
          )}
        </div>
        {!form.objectId && <p className="text-xs text-muted-foreground">{t('Choose a vehicle to add.')}</p>}
      </SimpleDialog>

      <ReasonDialog open={!!downtimeFor} onOpenChange={(o) => !o && setDowntimeFor(null)} title="Record downtime" description={downtimeFor?.objectName} pending={addDowntime.isPending} error={addDowntime.error} onSubmit={(r) => addDowntime.mutate(r)} confirmLabel="Save">
        <div className="grid gap-3 sm:grid-cols-2">
          <Labeled label="From">{(id) => <Input id={id} type="date" value={dt.fromDate} onChange={(e) => setDt({ ...dt, fromDate: e.target.value })} />}</Labeled>
          <Labeled label="To (inclusive)">{(id) => <Input id={id} type="date" value={dt.toDate} onChange={(e) => setDt({ ...dt, toDate: e.target.value })} />}</Labeled>
          <Labeled label="Kind">{(id) => <Sel id={id} value={dt.kind} onChange={(v) => setDt({ ...dt, kind: v as typeof dt.kind })} options={DOWNTIME_KINDS.map((k) => ({ value: k, label: t(enumLabel(k)) }))} />}</Labeled>
          <label className="flex items-center gap-2 self-end text-sm">
            <Checkbox checked={dt.billable} onCheckedChange={(c) => setDt({ ...dt, billable: !!c })} />
            {t('Still billable')}
          </label>
        </div>
      </ReasonDialog>

      <ReasonDialog open={!!ending} onOpenChange={(o) => !o && setEnding(null)} title="End assignment" description={t('{{vehicle}} stops being billed from today.', { vehicle: ending?.objectName ?? '' })} reasonRequired={false} reasonLabel="Note" pending={end.isPending} error={end.error} onSubmit={(r) => end.mutate(r)} confirmLabel="End assignment" destructive>
        <Badge variant="warning">{t('Closed periods are not changed.')}</Badge>
      </ReasonDialog>
    </Section>
  );
}
