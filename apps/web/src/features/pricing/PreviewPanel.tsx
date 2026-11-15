import { AVAILABILITY_FREQUENCIES, type PricingComponentDto, type PricingPolicies, type PricingPreviewRequest, type PricingPreviewResponse } from '@veetracer/shared';
import { useMutation } from '@tanstack/react-query';
import { CalculatorIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api';
import { pricingErrorMessage } from './errors';
import { P } from './pricing-api';
import { daysInclusive, periodFactsFromForm, tripFactsFromForm, type PeriodPreviewForm, type TripPreviewForm } from './preview';
import { enumLabel, Issues, Labeled, monthEnd, monthStart, PriceBreakdown, Section, Sel, StatusPill, todayYmd } from './ui';

const FIELD_LABEL: Record<string, string> = {
  km: 'Billable km',
  actualHours: 'Actual hours',
  reservedHours: 'Reserved hours',
  waitingMinutes: 'Waiting minutes',
  stops: 'Stops served',
  passengers: 'Passengers',
  cancelledMinutesBefore: 'Cancelled minutes before start',
  startTime: 'Start time',
  tolls: 'Tolls / parking',
  usedKm: 'Km used',
  usedHours: 'Hours used',
  overtimeHours: 'Overtime hours',
};

/**
 * Sample calculation (doc 19 §6): enter km / hours / stops / waiting / night start → the engine's full breakdown via
 * POST /contracts/:id/preview. Nothing is stored. Unsaved components of a draft are sent as they are on screen.
 */
export function PreviewPanel({ contractId, currency, versionId, components, policies }: { contractId: string; currency: string; versionId?: string; components?: PricingComponentDto[]; policies?: PricingPolicies }) {
  const { t } = useTranslation();
  const today = todayYmd();
  const [kind, setKind] = useState<'TRIP' | 'PERIOD'>('TRIP');
  const [trip, setTrip] = useState<TripPreviewForm>({ serviceDate: today, km: '25', actualHours: '', reservedHours: '', waitingMinutes: '', stops: '', passengers: '', startTime: '', tolls: '', cancelledMinutesBefore: '', onDedicatedVehicle: false, vehicleCategory: '' });
  const [period, setPeriod] = useState<PeriodPreviewForm>({ frequency: 'MONTHLY', periodStart: monthStart(today), periodEnd: monthEnd(today), attachedDays: String(daysInclusive(monthStart(today), monthEnd(today))), downtimeDays: '0', suspensionDays: '0', holidayDaysWorked: '0', usedKm: '', usedHours: '', overtimeHours: '', tripCount: '' });
  const [inputError, setInputError] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: (body: PricingPreviewRequest) => api.post<PricingPreviewResponse>(`${P}/contracts/${contractId}/preview`, body),
  });
  const calculate = () => {
    setInputError(null);
    try {
      const body: PricingPreviewRequest = {
        kind,
        ...(components ? { components, policies } : { versionId: versionId ?? null }),
        ...(kind === 'TRIP' ? { trip: tripFactsFromForm(trip, currency) } : { period: periodFactsFromForm(period) }),
      };
      run.mutate(body);
    } catch (e) {
      const field = String((e as Error).message).replace('INVALID: ', '');
      setInputError(t('Check the value of “{{field}}”.', { field: t(FIELD_LABEL[field] ?? field) }));
    }
  };
  const tf = (k: keyof TripPreviewForm, label: string, opts: { type?: string; placeholder?: string } = {}) => (
    <Labeled label={label}>{(id) => <Input id={id} type={opts.type} inputMode={opts.type ? undefined : 'decimal'} placeholder={opts.placeholder} value={trip[k] as string} onChange={(e) => setTrip({ ...trip, [k]: e.target.value })} />}</Labeled>
  );
  const pf = (k: keyof PeriodPreviewForm, label: string, type?: string) => (
    <Labeled label={label}>{(id) => <Input id={id} type={type} inputMode={type ? undefined : 'decimal'} value={period[k]} onChange={(e) => setPeriod({ ...period, [k]: e.target.value })} />}</Labeled>
  );
  const r = run.data;
  return (
    <Section title={t('Sample calculation')} description={components ? t('Uses the components as shown above, including unsaved changes. Nothing is stored.') : t('Uses this version’s stored components. Nothing is stored.')}>
      <div className="mb-3 flex flex-wrap gap-2" role="radiogroup" aria-label={t('Calculate for')}>
        {(['TRIP', 'PERIOD'] as const).map((k) => (
          <Button key={k} size="sm" role="radio" aria-checked={kind === k} variant={kind === k ? 'default' : 'outline'} onClick={() => setKind(k)}>
            {k === 'TRIP' ? t('One trip') : t('Availability period')}
          </Button>
        ))}
      </div>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          calculate();
        }}
        className="space-y-3"
      >
        {kind === 'TRIP' ? (
          <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-4">
            {tf('serviceDate', 'Service date', { type: 'date' })}
            {tf('km', 'Billable km')}
            {tf('actualHours', 'Actual hours')}
            {tf('reservedHours', 'Reserved hours')}
            {tf('waitingMinutes', 'Waiting minutes')}
            {tf('stops', 'Stops served')}
            {tf('passengers', 'Passengers')}
            {tf('startTime', 'Start time', { type: 'time' })}
            {tf('tolls', `${t('Tolls / parking')} (${currency})`)}
            {tf('cancelledMinutesBefore', 'Cancelled minutes before start')}
            {tf('vehicleCategory', 'Vehicle category')}
            <label className="flex items-center gap-2 self-end text-sm">
              <Checkbox checked={trip.onDedicatedVehicle} onCheckedChange={(c) => setTrip({ ...trip, onDedicatedVehicle: !!c })} />
              {t('On a dedicated vehicle')}
            </label>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-4">
            <Labeled label="Frequency">{(id) => <Sel id={id} value={period.frequency} onChange={(v) => setPeriod({ ...period, frequency: v as PeriodPreviewForm['frequency'] })} options={AVAILABILITY_FREQUENCIES.map((f) => ({ value: f, label: t(enumLabel(f)) }))} />}</Labeled>
            {pf('periodStart', 'Period start', 'date')}
            {pf('periodEnd', 'Period end', 'date')}
            {pf('attachedDays', 'Days attached')}
            {pf('downtimeDays', 'Downtime days (not billable)')}
            {pf('suspensionDays', 'Suspension days')}
            {pf('holidayDaysWorked', 'Holidays worked')}
            {pf('usedKm', 'Km used')}
            {pf('usedHours', 'Hours used')}
            {pf('overtimeHours', 'Overtime hours')}
            {pf('tripCount', 'Trips')}
          </div>
        )}
        <Button type="submit" size="sm" disabled={run.isPending}>
          {run.isPending ? <Spinner /> : <CalculatorIcon />} {t('Calculate')}
        </Button>
      </form>
      <div className="mt-4 space-y-3" aria-live="polite">
        {inputError && <FormError message={inputError} />}
        {run.isError && <FormError message={pricingErrorMessage(run.error, t)} />}
        {r && !run.isPending && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <StatusPill status={r.status} />
              <span className="text-xs text-muted-foreground">{r.engineVersion}</span>
            </div>
            <Issues issues={r.issues} />
            <PriceBreakdown currency={r.currency} lines={r.lines} subtotalMinor={r.subtotalMinor} discountMinor={r.discountMinor} taxLines={r.taxLines} taxMinor={r.taxMinor} totalMinor={r.totalMinor} />
          </>
        )}
      </div>
    </Section>
  );
}
