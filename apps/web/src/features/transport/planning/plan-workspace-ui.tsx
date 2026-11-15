import type { DriverDto } from '@veetracer/shared';
import { CircleAlertIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/multi-select';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { addableBookings, type RouteIssues } from './plan-workspace';
import { plannerErrorText, stopLabel, VIOLATION_LABEL, type PlannerPlan } from './planner-format';
import { plannerErrorMessage, usePlanBookingQueue, useReview } from './use-planner';

/** Driver of a route (drivers list when the role may see drivers; PATCH assignment driverId). */
export function DriverPicker({ id, driverId, driverName, disabled, onChange }: { id: string; driverId: string | null; driverName: string | null; disabled?: boolean; onChange: (driverId: string | null, label: string) => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const drivers = useEntityOptions<DriverDto>('/drivers', named, { q, enabled: can('drivers') });
  if (!can('drivers')) return driverName ? <p className="text-xs text-muted-foreground">{t('Driver: {{name}}', { name: driverName })}</p> : null;
  const options = driverId && !drivers.options.some((o) => o.value === driverId) ? [{ value: driverId, label: driverName ?? driverId }, ...drivers.options] : drivers.options;
  return (
    <div className="grid min-w-0 gap-0.5 text-xs sm:max-w-xs">
      <label htmlFor={id} className="text-muted-foreground">
        {t('Driver')}
      </label>
      <Combobox
        id={id}
        value={driverId}
        disabled={disabled}
        onChange={(v) => onChange(v, v ? (options.find((o) => o.value === v)?.label ?? '') : '')}
        options={options}
        loading={drivers.loading}
        onSearch={setQ}
        placeholder={t('No driver')}
        searchPlaceholder={t('Search drivers…')}
        emptyText={t('No drivers found')}
      />
    </div>
  );
}

/** Blocking errors and warnings of one route after the last edit (text, never colour alone). */
export function RouteIssuesView({ issues }: { issues: RouteIssues | undefined }) {
  const { t } = useTranslation();
  if (!issues || (!issues.errors.length && !issues.warnings.length)) return null;
  const errText = (e: RouteIssues['errors'][number]) => {
    if (e.code === 'OVER_CAPACITY') return t(VIOLATION_LABEL.over_capacity);
    if (e.code === 'UNREACHABLE') return t(VIOLATION_LABEL.unreachable);
    const own = plannerErrorText(e.code);
    return own ? t(own) : e.message || e.code;
  };
  return (
    <div className="grid gap-1 text-xs" role="status">
      {issues.errors.map((e) => (
        <p key={e.code} className="flex items-start gap-1 font-medium text-destructive-fg">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t('Blocks publishing: {{what}}', { what: errText(e) })}
        </p>
      ))}
      {issues.warnings.map((w) => (
        <p key={w.kind} className="flex items-start gap-1 text-warning-fg">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t('Warning: {{what}} ({{n}})', { what: t(VIOLATION_LABEL[w.kind] ?? w.kind), n: w.n })}
        </p>
      ))}
    </div>
  );
}

/** "Add booking": open bookings of the plan's day / direction / shift from the dispatch board queue, with a search. */
export function AddBookingDialog({ plan, open, onClose, onAdd, pending }: { plan: PlannerPlan; open: boolean; onClose: () => void; onAdd: (bookingId: string) => void; pending: boolean }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const queue = usePlanBookingQueue(plan.planDate, plan.direction ?? 'IN', open);
  const list = addableBookings(plan, queue.data ?? [], q).slice(0, 50);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Add booking')}</DialogTitle>
          <DialogDescription>{t('Open bookings of this plan’s date, direction and shift. The booking is added without a route; then move it to one.')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-3">
          <Field label={t('Search passenger or employee code')} htmlFor="add-booking-q">
            <Input id="add-booking-q" value={q} onChange={(e) => setQ(e.target.value)} className="h-9" autoComplete="off" />
          </Field>
          {queue.isPending ? (
            <Spinner />
          ) : queue.isError ? (
            <p role="alert" className="text-sm text-destructive-fg">
              {plannerErrorMessage(queue.error, t)}
            </p>
          ) : list.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('No open booking can be added to this plan.')}</p>
          ) : (
            <ul className="grid max-h-80 gap-1 overflow-y-auto" aria-label={t('Bookings')}>
              {list.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="break-words font-medium">{b.passenger.displayName}</span>
                    <span className="text-xs text-muted-foreground">
                      {b.passenger.employeeCode}
                      {b.shiftName ? ` · ${b.shiftName}` : ''}
                      {b.passengerCount > 1 ? ` · ${t('{{n}} seats', { n: b.passengerCount })}` : ''}
                    </span>
                  </span>
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => onAdd(b.id)}>
                    <PlusIcon /> {t('Add')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Back')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Show changes": manual changes since the last optimised version (GET review's manualChanges; ids → labels). */
export function ChangesPanel({ plan }: { plan: PlannerPlan }) {
  const { t } = useTranslation();
  const review = useReview(plan.id, null);
  const stop = (id: string) => {
    const s = plan.stops.find((x) => x.id === id);
    return s ? stopLabel(s, t) : t('Removed stop');
  };
  const routeName = (aid: string) => {
    const i = plan.assignments.findIndex((a) => a.id === aid);
    return t('Route {{n}} · {{vehicle}}', { n: i + 1, vehicle: plan.assignments[i]?.vehicleLabel ?? '' });
  };
  if (review.isPending) return <Spinner />;
  if (review.isError) return <p role="alert" className="text-sm text-destructive-fg">{plannerErrorMessage(review.error, t)}</p>;
  const m = review.data.manualChanges;
  const routes = m.routes.filter((r) => r.addedStopIds.length || r.removedStopIds.length || r.reordered || r.vehicleChanged || r.driverChanged);
  return (
    <div className="grid gap-2 text-sm">
      <p className="text-muted-foreground">{m.baselineVersion ? t('Changes since version {{v}} (last optimised).', { v: m.baselineVersion }) : t('No optimised version to compare with yet.')}</p>
      {m.baselineVersion && routes.length === 0 && <p>{t('No manual changes.')}</p>}
      <ul className="grid gap-2">
        {routes.map((r) => (
          <li key={r.assignmentId} className="grid gap-1 rounded-md border p-2">
            <span className="font-medium">{routeName(r.assignmentId)}</span>
            <span className="flex flex-wrap gap-1">
              {r.reordered && <Badge variant="outline">{t('Order changed')}</Badge>}
              {r.vehicleChanged && <Badge variant="outline">{t('Vehicle changed')}</Badge>}
              {r.driverChanged && <Badge variant="outline">{t('Driver changed')}</Badge>}
            </span>
            {r.addedStopIds.length > 0 && <span className="text-xs">{t('Added: {{list}}', { list: r.addedStopIds.map(stop).join(', ') })}</span>}
            {r.removedStopIds.length > 0 && <span className="text-xs">{t('Removed: {{list}}', { list: r.removedStopIds.map(stop).join(', ') })}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export const WORKSPACE_UI_STRINGS = [
  'Blocks publishing: {{what}}',
  'Warning: {{what}} ({{n}})',
  'Add booking',
  'Open bookings of this plan’s date, direction and shift. The booking is added without a route; then move it to one.',
  'Search passenger or employee code',
  'No open booking can be added to this plan.',
  'Changes since version {{v}} (last optimised).',
  'No optimised version to compare with yet.',
  'No manual changes.',
  'Order changed',
  'Vehicle changed',
  'Driver changed',
  'Added: {{list}}',
  'Removed: {{list}}',
  'Removed stop',
] as const;
