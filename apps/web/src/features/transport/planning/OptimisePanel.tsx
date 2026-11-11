import type { RoutingCapabilities, TransportDirection } from '@veetracer/shared';
import { PlayIcon, RouteOffIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MultiSelect } from '@/components/ui/multi-select';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { DIRECTION_LABEL, shiftTimesLabel } from '../dispatch/e3-format';
import { SimpleSelect } from '../dispatch/e3-ui';
import { capabilityView, completeWeights, planBranchChoice, planSeeds, skippedSummary, timeLimitOptions, type ShiftChoice, type WeightDraft } from './planner-format';
import { JobProgress, WeightsEditor } from './planner-ui';
import { createKeyStore, newKey, plannerErrorMessage, plannerErrorOf, useActiveShifts, usePlannerVehicles, useStartOptimise, type StartedPlan } from './use-planner';

export interface OptimiseState {
  day: string;
  direction: TransportDirection;
  siteIds: string[];
  shiftIds: string[];
  vehicleIds: string[];
  weights: WeightDraft;
  timeLimitS: number;
  /** T2-D5: the branch chosen by a branch-scoped user with several branches. */
  branchId: string | null;
}

/** Bookings the new plan left out, per reason: they stay in the dispatch queue (T2 E2E). */
function SkippedBookings({ skipped }: { skipped: { bookingId: string; reason: string }[] | undefined }) {
  const { t } = useTranslation();
  const rows = skippedSummary(skipped);
  if (!rows.length) return null;
  return (
    <div role="status" className="grid gap-0.5 rounded-md bg-muted p-2 text-xs">
      <span className="font-medium">{t('{{n}} booking(s) not included in this plan; they stay in the dispatch queue:', { n: rows.reduce((n, r) => n + r.n, 0) })}</span>
      <ul className="list-disc ps-4">
        {rows.map((r) => (
          <li key={r.reason}>
            {t(r.label)}: <span className="tabular-nums">{r.n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Optimise (07 §5 input): service date, direction, sites, shifts, vehicles and explicit weights → one plan per shift,
 * each run as its own job with progress and cancel. Disabled with the reason when routing / the optimiser is down;
 * nothing is estimated in the browser meanwhile.
 */
export function OptimisePanel({ caps, state, setState, started, setStarted, canPlan, tz }: { caps: RoutingCapabilities | undefined; state: OptimiseState; setState: (fn: (s: OptimiseState) => OptimiseState) => void; started: StartedPlan[]; setStarted: (s: StartedPlan[]) => void; canPlan: boolean; tz: string | undefined }) {
  const { t } = useTranslation();
  const shifts = useActiveShifts();
  const fleet = usePlannerVehicles(state.day, state.direction);
  // Idempotency-Keys per action: a retry of the same form replays on the server (no second plan / job).
  const [keys] = useState(() => createKeyStore(newKey));
  const start = useStartOptimise(keys);
  const [touched, setTouched] = useState(false);
  const health = capabilityView(caps);

  const shiftChoices: ShiftChoice[] = useMemo(() => (shifts.data ?? []).map((s) => ({ id: s.id, name: s.name, siteId: s.site?.id ?? null, siteName: s.site?.name ?? null, startMin: s.startMin, endMin: s.endMin, timeZone: s.timeZone })), [shifts.data]);
  const siteOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of shiftChoices) if (s.siteId) m.set(s.siteId, s.siteName ?? s.siteId);
    return [...m].map(([value, label]) => ({ value, label }));
  }, [shiftChoices]);
  const shiftOptions = shiftChoices
    .filter((s) => state.siteIds.length === 0 || s.siteId === null || state.siteIds.includes(s.siteId))
    .map((s) => ({ value: s.id, label: `${s.name} · ${shiftTimesLabel(s.startMin, s.endMin, t)}`, description: s.siteName ?? t('No site') }));
  const vehicles = fleet.data?.vehicles ?? [];
  const withSeats = vehicles.filter((v) => v.seats !== null);
  const vehicleOptions = withSeats.map((v) => ({ value: v.objectId, label: `${v.name}${v.plateNumber ? ` · ${v.plateNumber}` : ''}`, description: t('{{n}} seats', { n: v.seats ?? 0 }) }));
  const weights = completeWeights(state.weights);
  const seeds = planSeeds({ day: state.day, direction: state.direction, shifts: shiftChoices, shiftIds: state.shiftIds, siteIds: state.siteIds, tz: fleet.data?.timeZone ?? tz ?? 'UTC' }, t);
  const chosenVehicles = withSeats.filter((v) => state.vehicleIds.includes(v.objectId));
  // T2-D5: a branch-scoped user plans for one of their branches (one: fixed; several: picked).
  const branch = planBranchChoice(caps?.access ?? { scope: 'COMPANY' });
  const branchId = branch.mode === 'fixed' ? branch.branch.id : branch.mode === 'pick' && branch.branches.some((b) => b.id === state.branchId) ? state.branchId : null;

  const problems: string[] = [];
  if (!seeds.length) problems.push(t('Choose at least one shift.'));
  if (seeds.some((x) => !x.sitePoiId)) problems.push(t('A chosen shift has no site: choose exactly one site for it.'));
  if (!chosenVehicles.length) problems.push(t('Choose at least one vehicle.'));
  if (!weights) problems.push(t('Set all four weights (at least one of distance, driving or route length above 0).'));
  if (branch.mode === 'pick' && !branchId) problems.push(t('Choose the branch for the plan.'));
  if (branch.mode === 'missing') problems.push(t('Your role has no branch to plan for. Ask an administrator to assign you a branch.'));
  const ready = problems.length === 0 && health.canOptimise && canPlan;

  const run = () => {
    setTouched(true);
    if (!ready || !weights) return;
    start.mutate(
      { planDate: state.day, direction: state.direction, seeds, objectIds: chosenVehicles.map((v) => v.objectId), weights, timeLimitS: state.timeLimitS, branchId },
      {
        onSuccess: (r) => {
          setStarted(r);
          for (const x of r) {
            const st = (x.error as { status?: number } | null)?.status;
            // Refused (4xx: nothing written) → a new key next time; network / 5xx → the same key replays.
            if (x.error && typeof st === 'number' && st < 500) keys.forget(`create:${x.seed.shiftId}`);
          }
          // Every plan started: a new click is a new action (new plans).
          if (r.every((x) => x.job)) keys.clear();
        },
      },
    );
  };

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,26rem)]">
      <Card className="min-w-0 gap-4 p-4">
        {!health.canOptimise && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft p-3 text-sm text-warning-fg">
            <RouteOffIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="grid gap-1">
              <span className="font-medium">{t(health.label)}</span>
              {health.detail && <span>{t(health.detail)}</span>}
              <Link to="/transport/dispatch" className="font-medium underline">
                {t('Open the dispatch board')}
              </Link>
            </div>
          </div>
        )}
        {health.canOptimise && health.detail && <p className="rounded-md bg-muted p-2 text-sm text-muted-foreground">{t(health.detail)}</p>}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('Service date')} htmlFor="opt-day">
            <Input id="opt-day" type="date" value={state.day} onChange={(e) => e.target.value && setState((s) => ({ ...s, day: e.target.value, vehicleIds: [] }))} className="h-9" />
          </Field>
          <div className="grid content-start gap-1.5">
            <span className="text-sm font-medium" id="opt-dir-label">
              {t('Direction')}
            </span>
            <div className="inline-flex rounded-lg border bg-muted p-[3px]" role="group" aria-labelledby="opt-dir-label">
              {(['IN', 'OUT'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={state.direction === d}
                  onClick={() => setState((s) => ({ ...s, direction: d }))}
                  className={cn('h-8 min-w-0 flex-1 rounded-md px-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring', state.direction === d ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground')}
                >
                  {t(DIRECTION_LABEL[d])}
                </button>
              ))}
            </div>
          </div>
          <Field label={t('Sites')} htmlFor="opt-sites" hint={t('Leave empty for every site.')}>
            <MultiSelect id="opt-sites" value={state.siteIds} onChange={(v) => setState((s) => ({ ...s, siteIds: v, shiftIds: s.shiftIds.filter((id) => shiftChoices.find((c) => c.id === id && (v.length === 0 || c.siteId === null || v.includes(c.siteId)))) }))} options={siteOptions} loading={shifts.isPending} placeholder={t('All sites')} searchPlaceholder={t('Search sites…')} emptyText={t('No sites on active shifts')} />
          </Field>
          <Field label={t('Shifts')} htmlFor="opt-shifts" hint={t('One plan per shift.')} error={touched && !seeds.length ? t('Choose at least one shift.') : undefined}>
            <MultiSelect id="opt-shifts" value={state.shiftIds} onChange={(v) => setState((s) => ({ ...s, shiftIds: v }))} options={shiftOptions} loading={shifts.isPending} placeholder={t('Choose shifts')} searchPlaceholder={t('Search shifts…')} emptyText={t('No active shifts')} invalid={touched && !seeds.length} />
          </Field>
          <Field
            label={t('Vehicles')}
            htmlFor="opt-vehicles"
            className="sm:col-span-2"
            hint={vehicles.length > withSeats.length ? t('{{n}} vehicle(s) without seats are not listed: set their seats first (Vehicle seats).', { n: vehicles.length - withSeats.length }) : t('Each plan may use every chosen vehicle.')}
            error={touched && !chosenVehicles.length ? t('Choose at least one vehicle.') : undefined}
          >
            <MultiSelect id="opt-vehicles" value={state.vehicleIds} onChange={(v) => setState((s) => ({ ...s, vehicleIds: v }))} options={vehicleOptions} loading={fleet.isPending} placeholder={t('Choose vehicles')} searchPlaceholder={t('Search name or plate…')} emptyText={t('No vehicles with seats')} invalid={touched && !chosenVehicles.length} />
          </Field>
          {branch.mode === 'pick' && (
            <Field label={t('Branch')} htmlFor="opt-branch" className="sm:col-span-2" hint={t('The plan takes the bookings of this branch.')} error={touched && !branchId ? t('Choose the branch for the plan.') : undefined}>
              <SimpleSelect id="opt-branch" value={branchId ?? ''} onChange={(v) => setState((s) => ({ ...s, branchId: v || null }))} options={[{ value: '', label: t('Choose a branch') }, ...branch.branches.map((b) => ({ value: b.id, label: b.name }))]} />
            </Field>
          )}
          {branch.mode === 'fixed' && <p className="text-sm text-muted-foreground sm:col-span-2">{t('Plans are made for your branch {{name}}.', { name: branch.branch.name })}</p>}
          {fleet.isError && <FormError message={plannerErrorMessage(fleet.error, t)} />}
          {shifts.isError && <FormError message={plannerErrorMessage(shifts.error, t)} />}
        </div>

        <WeightsEditor idPrefix="opt-w" showErrors={touched} value={state.weights} onChange={(w) => setState((s) => ({ ...s, weights: w }))} />

        <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
          <Field label={t('Time limit per plan')} htmlFor="opt-limit">
            <SimpleSelect id="opt-limit" value={String(state.timeLimitS)} onChange={(v) => setState((s) => ({ ...s, timeLimitS: Number(v) }))} options={timeLimitOptions(caps?.limits.optimizeTimeLimitS).map((n) => ({ value: String(n), label: t('{{n}} seconds', { n }) }))} />
          </Field>
          <Button onClick={run} disabled={start.isPending || !canPlan || !health.canOptimise}>
            {start.isPending ? <Spinner /> : <PlayIcon />} {seeds.length > 1 ? t('Optimise {{n}} plans', { n: seeds.length }) : t('Optimise')}
          </Button>
        </div>
        {!canPlan && <p className="text-sm text-muted-foreground">{t('You can view plans; optimising needs the Route planning → create permission.')}</p>}
        {touched && problems.length > 0 && (
          <ul role="alert" className="list-disc ps-5 text-sm text-destructive-fg">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {start.isError && <FormError message={plannerErrorMessage(start.error, t)} />}
      </Card>

      <Card className="min-w-0 gap-3 p-4" aria-live="polite">
        <h2 className="text-sm font-semibold">{t('Optimisations')}</h2>
        {started.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('Started optimisations show here with their progress. You can leave this page; plans stay under Plans.')}</p>
        ) : (
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-3">
            {started.map((s) => (
              <li key={s.seed.shiftId} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-lg border p-3">
                {s.job ? (
                  <JobProgress jobId={s.job.jobId} planId={s.planId} label={s.seed.name} canCancel={canPlan} />
                ) : s.empty ? (
                  <div className="grid gap-1">
                    <span className="text-sm font-medium">{s.seed.name}</span>
                    <p role="status" className="text-sm text-warning-fg">
                      {s.empty === 'NO_BOOKINGS_FOR_SHIFT'
                        ? t('No bookings for this shift on this date.')
                        : s.empty === 'NO_BOOKINGS'
                          ? t('No bookings for this site and direction on this date.')
                          : t('Bookings were found, but none could be planned (routing consent, location or scope).')}{' '}
                      {t('Nothing was optimised.')}
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-1">
                    <span className="text-sm font-medium">{s.seed.name}</span>
                    <p role="alert" className={cn('text-sm', plannerErrorOf(s.error).kind === 'unavailable' ? 'text-warning-fg' : 'text-destructive-fg')}>
                      {plannerErrorMessage(s.error, t)}
                    </p>
                  </div>
                )}
                <SkippedBookings skipped={s.skipped} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
