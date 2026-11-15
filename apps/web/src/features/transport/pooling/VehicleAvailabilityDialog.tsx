import { VEHICLE_AVAILABILITY_KINDS, VEHICLE_AVAILABILITY_LIMITS, type VehicleAvailabilityKind } from '@veetracer/shared';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { formatClock, fromZonedWall, toZonedWall } from '@/features/planned-trips/trip-format';
import { getReportTimeZone } from '@/features/reports/report-time';
import { errorMessage } from '@/lib/api';
import { SimpleSelect } from '../dispatch/e3-ui';
import { newUuid } from '../dispatch/e3-format';
import { AVAILABILITY_KIND_LABEL, availabilityDraftOf, availabilityInputOf, type AvailabilityDraft } from './pooling-format';
import { poolingErrorText } from './pooling-ui';
import { useSaveVehicleAvailability, useVehicleAvailability } from './use-pooling';

/**
 * Vehicle availability (doc 20 §3.3): operating windows, downtime and reserved times, and the turnaround between two
 * trips. Saving replaces the windows that end after now (past windows stay as history). Trips that break a window are
 * refused at assignment / publish (VEHICLE_UNAVAILABLE / VEHICLE_TURNAROUND). Times in the company zone.
 */
export function VehicleAvailabilityDialog({ vehicle, onClose, canEdit }: { vehicle: { objectId: string; objectName: string } | null; onClose: () => void; canEdit: boolean }) {
  const { t } = useTranslation();
  const tz = getReportTimeZone();
  const q = useVehicleAvailability(vehicle?.objectId ?? null);
  const save = useSaveVehicleAvailability(vehicle?.objectId ?? '');
  const [draft, setDraft] = useState<AvailabilityDraft | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  useEffect(() => {
    if (q.data) setDraft(availabilityDraftOf(q.data, Date.now(), (ms) => toZonedWall(ms, tz)));
    setProblems([]);
  }, [q.data, tz]);
  useEffect(() => {
    if (!vehicle) {
      setDraft(null);
      save.reset();
    }
  }, [vehicle]); // eslint-disable-line react-hooks/exhaustive-deps

  const setRow = (key: string, patch: Partial<AvailabilityDraft['rows'][number]>) => setDraft((d) => (d ? { ...d, rows: d.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) } : d));
  const addRow = () => {
    const start = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
    setDraft((d) => (d ? { ...d, rows: [...d.rows, { key: newUuid(), kind: 'DOWNTIME', start: toZonedWall(start, tz), end: toZonedWall(start + 4 * 3_600_000, tz), reason: '' }] } : d));
  };
  const submit = () => {
    if (!draft || !vehicle) return;
    const r = availabilityInputOf(draft, (w) => fromZonedWall(w, tz), new Date().toISOString(), t);
    if (!r.ok) {
      setProblems(r.errors);
      return;
    }
    setProblems([]);
    save.mutate(r.value, { onSuccess: () => toast.success(t('Availability saved for {{name}}', { name: vehicle.objectName })) });
  };
  const data = q.data;
  return (
    <Dialog open={!!vehicle} onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('Availability · {{name}}', { name: vehicle?.objectName ?? '' })}</DialogTitle>
          <DialogDescription>{t('Operating windows, downtime and reserved times. When a day has operating windows, trips must lie inside one. Times in {{zone}}.', { zone: tz ?? '' })}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          {q.isError && <FormError message={errorMessage(q.error)} />}
          {!draft || !data ? (
            !q.isError && <Skeleton className="h-48 w-full" />
          ) : (
            <>
              {data.maintenanceSince && <p className="rounded-md border border-warning/40 bg-warning-soft p-2 text-sm text-warning-fg">{t('Under maintenance since {{when}}: the vehicle is unavailable until maintenance ends.', { when: formatClock(data.maintenanceSince, tz) })}</p>}
              <Field label={t('Turnaround between trips (minutes)')} htmlFor="va-turn" hint={t('Empty = not enforced at publish; planners use 2 minutes.')} className="sm:w-72">
                <Input id="va-turn" type="number" min={0} max={VEHICLE_AVAILABILITY_LIMITS.turnaroundMaxS / 60} value={draft.turnaroundMin} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, turnaroundMin: e.target.value })} className="h-9" />
              </Field>
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">{t('Windows')}</h3>
                  {canEdit && (
                    <Button size="sm" variant="outline" onClick={addRow} disabled={draft.rows.length >= VEHICLE_AVAILABILITY_LIMITS.maxWindows}>
                      <PlusIcon /> {t('Add window')}
                    </Button>
                  )}
                </div>
                {draft.rows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('No upcoming windows: the vehicle may run any time it is free.')}</p>
                ) : (
                  <ul className="grid gap-2">
                    {draft.rows.map((r, i) => (
                      <li key={r.key} className="grid gap-2 rounded-lg border p-2 sm:grid-cols-[10rem_1fr_1fr_1fr_auto] sm:items-end">
                        <Field label={t('Kind')} htmlFor={`va-k-${i}`}>
                          <SimpleSelect id={`va-k-${i}`} value={r.kind} disabled={!canEdit} onChange={(v) => setRow(r.key, { kind: v as VehicleAvailabilityKind })} options={VEHICLE_AVAILABILITY_KINDS.map((k) => ({ value: k, label: t(AVAILABILITY_KIND_LABEL[k]) }))} />
                        </Field>
                        <Field label={t('From')} htmlFor={`va-s-${i}`}>
                          <Input id={`va-s-${i}`} type="datetime-local" value={r.start} disabled={!canEdit} onChange={(e) => setRow(r.key, { start: e.target.value })} className="h-9" />
                        </Field>
                        <Field label={t('To')} htmlFor={`va-e-${i}`}>
                          <Input id={`va-e-${i}`} type="datetime-local" value={r.end} disabled={!canEdit} onChange={(e) => setRow(r.key, { end: e.target.value })} className="h-9" />
                        </Field>
                        <Field label={t('Reason')} htmlFor={`va-r-${i}`}>
                          <Input id={`va-r-${i}`} value={r.reason} maxLength={VEHICLE_AVAILABILITY_LIMITS.reasonMax} disabled={!canEdit} onChange={(e) => setRow(r.key, { reason: e.target.value })} className="h-9" />
                        </Field>
                        {canEdit && (
                          <Button size="icon-sm" variant="ghost" aria-label={t('Remove window {{n}}', { n: i + 1 })} onClick={() => setDraft({ ...draft, rows: draft.rows.filter((x) => x.key !== r.key) })}>
                            <Trash2Icon />
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {data.busy.length > 0 && (
                <div className="grid gap-1">
                  <h3 className="text-sm font-semibold">{t('Planned trips (next 7 days)')}</h3>
                  <ul className="flex flex-wrap gap-1.5">
                    {data.busy.map((b) => (
                      <li key={b.plannedTripId}>
                        <Badge variant="outline">
                          {formatClock(b.plannedStart, tz)}–{formatClock(b.plannedEnd, tz)} · {t(b.status)}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {problems.length > 0 && (
                <ul role="alert" className="list-disc ps-5 text-sm text-destructive-fg">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              {save.isError && <FormError message={poolingErrorText(save.error, t)} />}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            {canEdit ? t('Cancel') : t('Close')}
          </Button>
          {canEdit && (
            <Button onClick={submit} disabled={!draft || save.isPending}>
              {save.isPending && <Spinner />} {t('Save availability')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
