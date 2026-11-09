import { useMutation, useQuery } from '@tanstack/react-query';
import {
  DEVICE_CONDITIONS,
  INVENTORY_STATUS_LABELS,
  INVENTORY_STATUSES,
  INVENTORY_TRANSITIONS,
  REASON_REQUIRED_STATUSES,
  REPLACED_UNIT_STATUSES,
  statusHoldsLocation,
  type DeviceStockDto,
  type InventoryStatus,
  type ReplaceDeviceResult,
  type StockLocationDto,
} from '@veetracer/shared';
import { InfoIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { FormDialog } from '@/features/masters/FormDialog';
import { useEntityOptions } from '@/features/masters/use-options';
import { api, errorMessage } from '@/lib/api';
import { rupeesToPaise } from './inventory-format';
import { locationOption, PlainSelect, StockStatusBadge, useInvalidateInventory } from './shared';

interface DialogProps {
  row: DeviceStockDto | null;
  onOpenChange: (open: boolean) => void;
}

function useStockMutation<B>(row: DeviceStockDto | null, action: string, done: () => void, success: string) {
  const { t } = useTranslation();
  const invalidate = useInvalidateInventory();
  return useMutation({
    mutationFn: (body: B) => api.post<DeviceStockDto>(`/inventory/stock/${row!.deviceId}/${action}`, body),
    onSuccess: () => {
      toast.success(t(success, { imei: row?.uniqueId }));
      invalidate();
      done();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-2 rounded-lg border border-info/30 bg-info-soft px-3 py-2 text-xs text-info-fg">
      <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/** Status change through the transition table (faulty / repair / returned / retired need a reason where required). */
export function StatusDialog({ row, onOpenChange }: DialogProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<InventoryStatus | ''>('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [locationId, setLocationId] = useState('');
  const locations = useEntityOptions<StockLocationDto>('/inventory/locations', locationOption, { enabled: !!row });
  useEffect(() => {
    setStatus('');
    setReason('');
    setReference('');
    setLocationId('');
  }, [row]);
  const save = useStockMutation<object>(row, 'status', () => onOpenChange(false), 'Status of {{imei}} updated');
  if (!row) return null;
  const allowed = INVENTORY_TRANSITIONS[row.status];
  const needsReason = !!status && REASON_REQUIRED_STATUSES.includes(status);
  return (
    <FormDialog
      open={!!row}
      onOpenChange={onOpenChange}
      title="Change stock status"
      description={t('Device {{imei}}', { imei: row.uniqueId })}
      pending={save.isPending}
      error={save.error}
      submitLabel="Change status"
      onSubmit={(e) => {
        e.preventDefault();
        if (!status) return;
        save.mutate({ status, reason: reason.trim() || undefined, reference: reference.trim() || undefined, toLocationId: locationId || undefined });
      }}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('Current')}</span>
        <StockStatusBadge status={row.status} />
      </div>
      {allowed.length === 0 ? (
        <Note>{t('Retired is final. Use Adjust (with a reason) to correct it.')}</Note>
      ) : (
        <PlainSelect id="st-status" label="New status" required value={status} onChange={(v) => setStatus(v as InventoryStatus)} options={allowed.map((s) => ({ value: s, label: INVENTORY_STATUS_LABELS[s] }))} />
      )}
      {status && statusHoldsLocation(status) && (
        <PlainSelect id="st-loc" label="Now at location" value={locationId} onChange={setLocationId} options={locations.options} allowEmpty="Unchanged" />
      )}
      <Field label={t('Reason')} htmlFor="st-reason" required={needsReason} hint={needsReason ? undefined : t('Optional')}>
        <Textarea id="st-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder={t('e.g. No GPS fix after power surge')} />
      </Field>
      <Field label={t('Reference')} htmlFor="st-ref" hint={t('RMA no., ticket or courier AWB')}>
        <Input id="st-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
      </Field>
      {(status === 'ASSIGNED' || status === 'ACTIVE') && <Note>{t('Assigned / Active must match the real customer and vehicle assignment, which stays in Device Inventory and the vehicle form.')}</Note>}
    </FormDialog>
  );
}

/** Move between stock locations and / or partner holder (never changes the customer). */
export function TransferDialog({ row, onOpenChange }: DialogProps) {
  const { t } = useTranslation();
  const [locationId, setLocationId] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const locations = useEntityOptions<StockLocationDto>('/inventory/locations', locationOption, { enabled: !!row });
  useEffect(() => {
    setLocationId('');
    setReason('');
    setReference('');
  }, [row]);
  const save = useStockMutation<object>(row, 'transfer', () => onOpenChange(false), '{{imei}} transferred');
  if (!row) return null;
  const atCustomer = !statusHoldsLocation(row.status);
  return (
    <FormDialog
      open={!!row}
      onOpenChange={onOpenChange}
      title="Transfer between locations"
      description={t('Device {{imei}}', { imei: row.uniqueId })}
      pending={save.isPending}
      error={save.error}
      submitLabel="Transfer"
      onSubmit={(e) => {
        e.preventDefault();
        if (!locationId) return;
        save.mutate({ toLocationId: locationId, reason: reason.trim() || undefined, reference: reference.trim() || undefined });
      }}
    >
      {atCustomer ? (
        <Note>{t('This device is at a customer. Move it between companies in Device Inventory; inventory only records it.')}</Note>
      ) : (
        <>
          <InfoLine label="From" value={row.location ? `${row.location.code} · ${row.location.name}` : '—'} />
          <PlainSelect id="tr-loc" label="To location" required value={locationId} onChange={setLocationId} options={locations.options.filter((o) => o.value !== row.location?.id)} />
          <Field label={t('Reason')} htmlFor="tr-reason" hint={t('Optional')}>
            <Input id="tr-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
          <Field label={t('Reference')} htmlFor="tr-ref" hint={t('Courier AWB or challan no.')}>
            <Input id="tr-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
          </Field>
        </>
      )}
    </FormDialog>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation();
  return (
    <p className="text-sm">
      <span className="text-muted-foreground">{t(label)}: </span>
      <span className="font-medium">{value}</span>
    </p>
  );
}

/** Correction with a mandatory reason (field diff recorded on the movement). */
export function AdjustDialog({ row, onOpenChange }: DialogProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState('');
  const [serial, setSerial] = useState('');
  const [cost, setCost] = useState('');
  const [warranty, setWarranty] = useState('');
  const [condition, setCondition] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(() => {
    setReason('');
    setStatus('');
    setSerial(row?.serialNumber ?? '');
    setCost(row?.unitCostPaise != null ? String(row.unitCostPaise / 100) : '');
    setWarranty(row?.warrantyUntil ?? '');
    setCondition(row?.condition ?? '');
    setLocalError(null);
  }, [row]);
  const save = useStockMutation<object>(row, 'adjust', () => onOpenChange(false), '{{imei}} adjusted');
  if (!row) return null;
  return (
    <FormDialog
      open={!!row}
      onOpenChange={onOpenChange}
      title="Adjust stock record"
      description={t('Corrections are recorded with your reason and the before / after values.')}
      pending={save.isPending}
      error={localError ? new Error(localError) : save.error}
      submitLabel="Save adjustment"
      wide
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim().length < 3) return setLocalError(t('A reason of at least 3 characters is required'));
        const paise = rupeesToPaise(cost);
        if (paise !== null && Number.isNaN(paise)) return setLocalError(t('Unit cost must be an amount in rupees'));
        setLocalError(null);
        const body: Record<string, unknown> = { reason: reason.trim() };
        if (status) body.status = status;
        if ((serial.trim() || null) !== row.serialNumber) body.serialNumber = serial.trim() || null;
        if (paise !== row.unitCostPaise) body.unitCostPaise = paise;
        if ((warranty || null) !== row.warrantyUntil) body.warrantyUntil = warranty || null;
        if ((condition || null) !== row.condition) body.condition = condition || null;
        save.mutate(body);
      }}
    >
      <Field label={t('Reason')} htmlFor="ad-reason" required>
        <Textarea id="ad-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder={t('e.g. Physical count found serial on label')} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <PlainSelect id="ad-status" label="Status" value={status} onChange={setStatus} allowEmpty={`Unchanged (${INVENTORY_STATUS_LABELS[row.status]})`} options={INVENTORY_STATUSES.filter((s) => s !== row.status).map((s) => ({ value: s, label: INVENTORY_STATUS_LABELS[s] }))} hint="May skip the transition table, never the assignment rules." />
        <Field label={t('Serial no.')} htmlFor="ad-serial">
          <Input id="ad-serial" value={serial} onChange={(e) => setSerial(e.target.value)} maxLength={60} />
        </Field>
        <Field label={t('Unit cost (₹)')} htmlFor="ad-cost">
          <Input id="ad-cost" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
        </Field>
        <Field label={t('Warranty until')} htmlFor="ad-warranty">
          <Input id="ad-warranty" type="date" value={warranty} onChange={(e) => setWarranty(e.target.value)} />
        </Field>
        <PlainSelect id="ad-cond" label="Condition" value={condition} onChange={setCondition} allowEmpty="Not recorded" options={DEVICE_CONDITIONS.map((c) => ({ value: c, label: c.charAt(0) + c.slice(1).toLowerCase() }))} />
      </div>
    </FormDialog>
  );
}

interface Candidate {
  id: string;
  uniqueId: string;
  modelName: string;
  stockStatus: InventoryStatus | null;
}

/**
 * Replace the faulty unit on a vehicle. The fitting runs through the existing vehicle assignment flow; licence seats
 * are not moved (each device keeps the seat the existing rules gave it).
 */
export function ReplaceDialog({ row, onOpenChange }: DialogProps) {
  const { t } = useTranslation();
  const invalidate = useInvalidateInventory();
  const [newDeviceId, setNewDeviceId] = useState('');
  const [oldStatus, setOldStatus] = useState<string>('FAULTY');
  const [locationId, setLocationId] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const objectId = row?.object?.id ?? null;
  const candidates = useQuery({
    queryKey: ['inventory', 'replace-candidates', objectId],
    queryFn: () => api.get<Candidate[]>('/inventory/replace/candidates', { objectId }),
    enabled: !!objectId,
  });
  const locations = useEntityOptions<StockLocationDto>('/inventory/locations', locationOption, { enabled: !!row });
  useEffect(() => {
    setNewDeviceId('');
    setOldStatus('FAULTY');
    setLocationId('');
    setReason('');
    setReference('');
  }, [row]);
  const save = useMutation({
    mutationFn: (body: object) => api.post<ReplaceDeviceResult>('/inventory/replace', body),
    onSuccess: (r) => {
      toast.success(t('{{new}} now fitted to {{vehicle}}; {{old}} recorded as {{status}}', { new: r.newDevice.uniqueId, vehicle: r.objectName, old: r.oldDevice.uniqueId, status: t(INVENTORY_STATUS_LABELS[(r.oldDevice.status ?? 'FAULTY') as InventoryStatus]).toLowerCase() }));
      invalidate();
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!row) return null;
  return (
    <FormDialog
      open={!!row}
      onOpenChange={onOpenChange}
      title="Replace device on vehicle"
      description={t('{{imei}} on {{vehicle}} ({{company}})', { imei: row.uniqueId, vehicle: row.object?.name ?? '—', company: row.company?.name ?? '—' })}
      pending={save.isPending}
      error={save.error}
      submitLabel="Replace"
      wide
      onSubmit={(e) => {
        e.preventDefault();
        if (!objectId || !newDeviceId || reason.trim().length < 3) return;
        save.mutate({ objectId, newDeviceId, oldStatus, returnLocationId: locationId || undefined, reason: reason.trim(), reference: reference.trim() || undefined });
      }}
    >
      {!objectId ? (
        <Note>{t('This device is not fitted to a vehicle.')}</Note>
      ) : (
        <>
          <PlainSelect
            id="rp-new"
            label="Replacement device"
            required
            value={newDeviceId}
            onChange={setNewDeviceId}
            placeholder={candidates.isPending ? 'Loading…' : candidates.data?.length ? 'Select…' : 'No spare device in this customer account'}
            options={(candidates.data ?? []).map((c) => ({ value: c.id, label: `${c.uniqueId} · ${c.modelName}${c.stockStatus ? ` · ${INVENTORY_STATUS_LABELS[c.stockStatus]}` : ''}` }))}
            hint="Working devices already in this customer's account and not fitted elsewhere."
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <PlainSelect id="rp-old" label="Removed unit becomes" required value={oldStatus} onChange={setOldStatus} options={REPLACED_UNIT_STATUSES.map((s) => ({ value: s, label: INVENTORY_STATUS_LABELS[s] }))} />
            <PlainSelect id="rp-loc" label="Removed unit goes to" value={locationId} onChange={setLocationId} options={locations.options} allowEmpty="Unchanged" />
          </div>
          <Field label={t('Reason')} htmlFor="rp-reason" required>
            <Textarea id="rp-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder={t('e.g. No GPS fix after power surge')} />
          </Field>
          <Field label={t('Reference')} htmlFor="rp-ref" hint={t('Service ticket or RMA no.')}>
            <Input id="rp-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
          </Field>
          <Note>
            {t(
              "The new unit is fitted through the vehicle form's existing assignment. Licence seats do not move: both devices keep the seat the existing rules gave them. To put a spare into this customer's account (which takes a seat under the existing rules), use Device Inventory first.",
            )}
          </Note>
        </>
      )}
    </FormDialog>
  );
}
