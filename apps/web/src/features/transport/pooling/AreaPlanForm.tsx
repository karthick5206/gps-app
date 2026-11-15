import type { RoutingCapabilities, RoutingStrategy, TransportPlaceOptionDto } from '@veetracer/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlayIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Combobox, MultiSelect } from '@/components/ui/multi-select';
import { Spinner } from '@/components/ui/spinner';
import { fromZonedWall } from '@/features/planned-trips/trip-format';
import { errorMessage } from '@/lib/api';
import { SimpleSelect } from '../dispatch/e3-ui';
import { useBookingPlaces } from '../dispatch/use-e3';
import type { CreatePlanRequest } from '../planning/planner-api';
import { call, plannerKeys } from '../planning/planner-client';
import type { KeyStore, StartedPlan } from '../planning/planner-flow';
import { capabilityView, planBranchChoice, timeLimitOptions, timeLimitWithin } from '../planning/planner-format';
import { invalidatePlans, plannerErrorMessage, usePlannerVehicles } from '../planning/use-planner';
import { areaPlanRequest, type AreaPlanDraft, type AreaPlanRequest } from './plan-trips';

const placeOption = (p: TransportPlaceOptionDto) => ({ value: p.id, label: p.category ? `${p.name} · ${p.category}` : p.name });

/**
 * Create the AREA plan, then start its optimise job (pickup-and-delivery, contract v3). Until the optimiser answers v3
 * the job fails PDP_UNSUPPORTED (final); the plan stays as a draft and the screen says why.
 */
function useStartAreaPlan(keys: KeyStore) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ body, timeLimitS, strategy }: { body: AreaPlanRequest; timeLimitS: number; strategy: RoutingStrategy }): Promise<StartedPlan> => {
      const seed = { name: body.name, shiftId: `area:${body.windowStart}:${Date.now()}`, sitePoiId: null, planStartAt: body.windowStart };
      let planId: string | null = null;
      try {
        // The AREA body has no direction / site (CreateRoutePlanDto validates them only for SITE plans).
        const plan = await call((c) => c.createPlan(body as unknown as CreatePlanRequest, keys.keyFor('create:area', body)));
        planId = plan.id;
        const left = { skipped: plan.skippedBookings ?? [], counts: plan.bookingCounts ?? null };
        if (plan.emptyReason) return { seed, planId, job: null, error: null, empty: plan.emptyReason, ...left };
        const opt = { planId: plan.id, expectedVersion: plan.version, timeLimitS, strategy };
        const job = await call((c) => c.optimize(opt, keys.keyFor(`optimize:${plan.id}`, opt)));
        qc.setQueryData(plannerKeys.job(job.jobId), job);
        return { seed, planId, job, error: null, ...left };
      } catch (error) {
        return { seed, planId, job: null, error };
      }
    },
    onSettled: () => invalidatePlans(qc),
  });
}

/**
 * Optimise tab, AREA scope (doc 20 §3.5): point-to-point pooling over an operating window. Bookings selected by the
 * server: point-to-point and commute bookings waiting for a seat whose window overlaps, not on hold, in the branch.
 * A vehicle's route may hold several trips; each is published as its own trip.
 */
export function AreaPlanForm({ caps, day, setDay, onStarted, keys, canPlan, tz }: { caps: RoutingCapabilities | undefined; day: string; setDay: (d: string) => void; onStarted: (s: StartedPlan) => void; keys: KeyStore; canPlan: boolean; tz: string | undefined }) {
  const { t } = useTranslation();
  const fleet = usePlannerVehicles(day, 'IN');
  const [d, setD] = useState<Omit<AreaPlanDraft, 'day'>>({ startTime: '07:00', endTime: '22:00', depot: null, vehicleIds: [], name: '' });
  const [q, setQ] = useState('');
  const places = useBookingPlaces(q, canPlan);
  const placeRows = useMemo(() => places.data ?? [], [places.data]);
  const [touched, setTouched] = useState(false);
  const [branchPick, setBranchPick] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<RoutingStrategy>('BALANCED');
  const timeLimitS = timeLimitWithin(caps?.limits.optimizeTimeLimitS ?? 30, caps?.limits.optimizeTimeLimitS);
  const [limit, setLimit] = useState<number>(timeLimitS);
  const start = useStartAreaPlan(keys);
  const health = capabilityView(caps);
  const zone = fleet.data?.timeZone ?? tz;
  const withSeats = (fleet.data?.vehicles ?? []).filter((v) => v.seats !== null);
  const vehicleOptions = withSeats.map((v) => ({ value: v.objectId, label: `${v.name}${v.plateNumber ? ` · ${v.plateNumber}` : ''}`, description: t('{{n}} seats', { n: v.seats ?? 0 }) }));
  const branch = planBranchChoice(caps?.access ?? { scope: 'COMPANY' });
  const branchId = branch.mode === 'fixed' ? branch.branch.id : branch.mode === 'pick' && branch.branches.some((b) => b.id === branchPick) ? branchPick : null;
  const req = areaPlanRequest({ ...d, day }, (w) => fromZonedWall(w, zone), branchId, t);
  const problems = req.ok ? [] : [...req.errors];
  if (branch.mode === 'pick' && !branchId) problems.push(t('Choose the branch for the plan.'));
  const ready = req.ok && problems.length === 0 && health.canOptimise && canPlan;

  const run = () => {
    setTouched(true);
    if (!ready || !req.ok) return;
    start.mutate(
      { body: req.value, timeLimitS: limit, strategy },
      {
        onSuccess: (r) => {
          onStarted(r);
          const st = (r.error as { status?: number } | null)?.status;
          if (r.error && typeof st === 'number' && st < 500) keys.forget('create:area');
          if (r.job) keys.clear();
        },
      },
    );
  };

  return (
    <Card className="min-w-0 gap-4 p-4">
      <p className="rounded-md bg-muted p-2 text-sm text-muted-foreground">
        {t('An area plan pools point-to-point and commute rides of one operating window. A vehicle may run several trips; private rides travel alone (whole trip).')}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('Service date')} htmlFor="area-day">
          <Input id="area-day" type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} className="h-9" />
        </Field>
        <Field label={t('Plan name (optional)')} htmlFor="area-name">
          <Input id="area-name" value={d.name} maxLength={120} onChange={(e) => setD({ ...d, name: e.target.value })} className="h-9" />
        </Field>
        <fieldset className="grid gap-1.5 sm:col-span-2">
          <legend className="mb-1 text-sm font-medium">{t('Operating window')}</legend>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('From')} htmlFor="area-from">
              <Input id="area-from" type="time" value={d.startTime} onChange={(e) => setD({ ...d, startTime: e.target.value })} className="h-9" />
            </Field>
            <Field label={t('To')} htmlFor="area-to">
              <Input id="area-to" type="time" value={d.endTime} onChange={(e) => setD({ ...d, endTime: e.target.value })} className="h-9" />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">{t('At most 24 hours; an end before the start is the next day. Times in {{zone}}.', { zone: zone ?? '' })}</p>
        </fieldset>
        <Field label={t('Depot')} htmlFor="area-depot" className="sm:col-span-2" hint={t('A company place: the vehicles start there.')} error={touched && !d.depot ? t('Choose the depot (a company place): the vehicles start there.') : undefined}>
          <Combobox
            id="area-depot"
            value={d.depot?.id ?? null}
            selectedOption={d.depot ? { value: d.depot.id, label: d.depot.name } : null}
            onChange={(id) => {
              const p = placeRows.find((r) => r.id === id);
              setD({ ...d, depot: p ? { id: p.id, name: p.name, lat: p.lat, lng: p.lng } : null });
            }}
            options={placeRows.map(placeOption)}
            loading={places.isFetching}
            onSearch={setQ}
            placeholder={t('Choose a company place')}
            searchPlaceholder={t('Search places…')}
            emptyText={places.isError ? errorMessage(places.error) : t('No places found')}
          />
        </Field>
        <Field label={t('Vehicles')} htmlFor="area-vehicles" className="sm:col-span-2" error={touched && !d.vehicleIds.length ? t('Choose at least one vehicle.') : undefined}>
          <MultiSelect id="area-vehicles" value={d.vehicleIds} onChange={(v) => setD({ ...d, vehicleIds: v })} options={vehicleOptions} loading={fleet.isPending} placeholder={t('Choose vehicles')} searchPlaceholder={t('Search name or plate…')} emptyText={t('No vehicles with seats')} />
        </Field>
        {branch.mode === 'pick' && (
          <Field label={t('Branch')} htmlFor="area-branch" className="sm:col-span-2">
            <SimpleSelect id="area-branch" value={branchId ?? ''} onChange={(v) => setBranchPick(v || null)} label={t('Branch')} options={branch.branches.map((b) => ({ value: b.id, label: b.name }))} />
          </Field>
        )}
        <Field label={t('Strategy')} htmlFor="area-strategy">
          <SimpleSelect
            id="area-strategy"
            value={strategy}
            onChange={(v) => setStrategy(v as RoutingStrategy)}
            options={[
              { value: 'BALANCED', label: t('Balanced') },
              { value: 'FEWER_VEHICLES', label: t('Fewer vehicles') },
              { value: 'COMFORT', label: t('Comfort') },
            ]}
          />
        </Field>
        <Field label={t('Time limit per plan')} htmlFor="area-limit">
          <SimpleSelect id="area-limit" value={String(limit)} onChange={(v) => setLimit(Number(v))} options={timeLimitOptions(caps?.limits.optimizeTimeLimitS).map((n) => ({ value: String(n), label: t('{{n}} seconds', { n }) }))} />
        </Field>
      </div>
      <Button onClick={run} disabled={start.isPending || !canPlan || !health.canOptimise} className="justify-self-start">
        {start.isPending ? <Spinner /> : <PlayIcon />} {t('Create area plan and optimise')}
      </Button>
      {touched && problems.length > 0 && (
        <ul role="alert" className="list-disc ps-5 text-sm text-destructive-fg">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {start.isError && <FormError message={plannerErrorMessage(start.error, t)} />}
    </Card>
  );
}
