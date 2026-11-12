import type { TransportAgreementDto, TransportFleetAllocationDto } from '@veetracer/shared';
import { PlusIcon, XCircleIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/multi-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { formatReportTime } from '@/features/reports/report-time';
import { ApiError, errorMessage } from '@/lib/api';
import { ALLOCATION_STATE_LABEL, allocationInput, allocationLabel, allocationState, fleetErrorText, sortAllocations } from './fleet-format';
import { useFleetAllocations, useFleetMutation, useFleetOptions } from './use-fleet';

const STATE_VARIANT = { active: 'success', scheduled: 'info', ended: 'muted', inactive: 'warning' } as const;

function fleetError(err: unknown, t: (k: string) => string): string {
  const friendly = err instanceof ApiError ? fleetErrorText(err.code) : null;
  return friendly ? t(friendly) : errorMessage(err);
}

function AllocateDialog({ agreementId, open, onOpenChange }: { agreementId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const [vehicleQ, setVehicleQ] = useState('');
  const [driverQ, setDriverQ] = useState('');
  const vehicles = useFleetOptions(agreementId, vehicleQ, open);
  const drivers = useFleetOptions(agreementId, driverQ, open);
  const [form, setForm] = useState({ objectId: null as string | null, driverId: null as string | null, validFrom: '', validTo: '', note: '' });
  const [error, setError] = useState<string | null>(null);
  const mutation = useFleetMutation(agreementId);

  const submit = () => {
    const parsed = allocationInput(form);
    if (!parsed.ok) return setError(t(parsed.error));
    setError(null);
    mutation.mutate(
      { kind: 'create', input: parsed.input },
      {
        onSuccess: () => onOpenChange(false),
        onError: (e) => setError(fleetError(e, t)),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Allocate vehicle / driver')}</DialogTitle>
          <DialogDescription>{t('Set one of your vehicles and / or drivers aside for this customer. The same vehicle may also serve other customers under their own agreements.')}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogBody className="grid gap-3 sm:grid-cols-2">
            <Field label={t('Vehicle')} htmlFor="fa-vehicle" className="sm:col-span-2">
              <Combobox
                id="fa-vehicle"
                value={form.objectId}
                onChange={(v) => setForm((f) => ({ ...f, objectId: v }))}
                options={(vehicles.data?.vehicles ?? []).map((v) => ({ value: v.id, label: v.name, description: v.plateNumber ?? undefined }))}
                loading={vehicles.isFetching}
                onSearch={setVehicleQ}
                placeholder={t('Choose a vehicle')}
              />
            </Field>
            <Field label={t('Driver')} htmlFor="fa-driver" className="sm:col-span-2">
              <Combobox
                id="fa-driver"
                value={form.driverId}
                onChange={(v) => setForm((f) => ({ ...f, driverId: v }))}
                options={(drivers.data?.drivers ?? []).map((d) => ({ value: d.id, label: d.name }))}
                loading={drivers.isFetching}
                onSearch={setDriverQ}
                placeholder={t('Choose a driver')}
              />
            </Field>
            <Field label={t('Valid from')} htmlFor="fa-from" hint={t('Empty = now')}>
              <Input id="fa-from" type="datetime-local" value={form.validFrom} onChange={(e) => setForm((f) => ({ ...f, validFrom: e.target.value }))} />
            </Field>
            <Field label={t('Valid to')} htmlFor="fa-to" hint={t('Empty = open-ended')}>
              <Input id="fa-to" type="datetime-local" value={form.validTo} onChange={(e) => setForm((f) => ({ ...f, validTo: e.target.value }))} />
            </Field>
            <Field label={t('Note')} htmlFor="fa-note" className="sm:col-span-2">
              <Input id="fa-note" value={form.note} maxLength={200} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
            </Field>
            <div className="sm:col-span-2">
              <FormError message={error} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Spinner />}
              {t('Allocate')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Vehicles and drivers the provider set aside for this customer (ETMS E1b, doc 15 §10). The provider's admins allocate
 * and end; the customer sees the list read-only. Ending the agreement closes every open allocation.
 */
export function FleetAllocations({ a }: { a: TransportAgreementDto }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const q = useFleetAllocations(a.id);
  const end = useFleetMutation(a.id);
  const [allocating, setAllocating] = useState(false);
  const [ending, setEnding] = useState<TransportFleetAllocationDto | null>(null);
  const [endError, setEndError] = useState<string | null>(null);
  const rows = useMemo(() => sortAllocations(q.data ?? []), [q.data]);
  const canAllocate = a.side === 'PROVIDER' && a.status !== 'ENDED' && can('etms_partners', 'edit');

  return (
    <div className="grid gap-3">
      {q.isPending ? (
        <Skeleton className="h-12 w-full" />
      ) : q.isError ? (
        <FormError message={errorMessage(q.error)} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{a.side === 'CUSTOMER' ? t('The provider has not allocated vehicles or drivers to you yet.') : t('No vehicles or drivers allocated yet.')}</p>
      ) : (
        <ul className="grid gap-2">
          {rows.map((r) => {
            const state = allocationState(r);
            return (
              <li key={r.id} className="flex flex-wrap items-start gap-2 rounded-lg border p-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium break-words">{allocationLabel(r) || t('Deleted vehicle / driver')}</p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {r.validTo ? t('{{from}} to {{to}}', { from: formatReportTime(r.validFrom), to: formatReportTime(r.validTo) }) : t('From {{from}}, open-ended', { from: formatReportTime(r.validFrom) })}
                  </p>
                  {r.note && <p className="text-xs break-words">{r.note}</p>}
                </div>
                <Badge variant={STATE_VARIANT[state]}>{t(ALLOCATION_STATE_LABEL[state])}</Badge>
                {r.canEnd && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEndError(null);
                      setEnding(r);
                    }}
                  >
                    <XCircleIcon /> {t('End allocation')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canAllocate && (
        <div>
          <Button variant="outline" size="sm" onClick={() => setAllocating(true)}>
            <PlusIcon /> {t('Allocate vehicle / driver')}
          </Button>
        </div>
      )}
      <FormError message={endError} />
      {allocating && <AllocateDialog agreementId={a.id} open onOpenChange={setAllocating} />}
      <ConfirmDialog
        open={!!ending}
        onOpenChange={(o) => !o && setEnding(null)}
        title={t('End allocation?')}
        description={ending ? t('{{name}} stops being allocated to this customer now.', { name: allocationLabel(ending) }) : ''}
        confirmLabel={t('End allocation')}
        destructive
        pending={end.isPending}
        onConfirm={() =>
          ending &&
          end.mutate(
            { kind: 'end', allocationId: ending.id },
            {
              onSuccess: () => setEnding(null),
              onError: (e) => {
                setEnding(null);
                setEndError(fleetError(e, t));
              },
            },
          )
        }
      />
    </div>
  );
}
