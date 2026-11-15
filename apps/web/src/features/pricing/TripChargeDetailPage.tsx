import type { BillableDistanceRequest, TripChargeDetailResponse, TripOverrideRequest, TripOverrideResponse, TripPriceSnapshotDto } from '@veetracer/shared';
import { AlertTriangleIcon, CalculatorIcon, HandCoinsIcon, RulerIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import { ChangesView } from '@/features/masters/ChangesView';
import { api } from '@/lib/api';
import { formatDateTime, formatDuration } from '@/lib/format';
import { amountError, formatKm } from './money';
import { P, pk, usePricingMutation } from './pricing-api';
import { useQuery } from '@tanstack/react-query';
import { Empty, enumLabel, Facts, Issues, Labeled, Money, PriceBreakdown, PricingShell, QueryView, ReasonDialog, ScrollTable, Section, StatusPill, Td, Th } from './ui';

const KM = /^\d{1,5}(\.\d{1,3})?$/;

function Distances({ s }: { s: TripPriceSnapshotDto }) {
  const { t } = useTranslation();
  const items: [string, number | null, string | null][] = [
    ['Planned', s.distances.plannedM, 'PLANNED'],
    ['Actual GPS', s.distances.gpsM, 'GPS'],
    ['Agreed', s.distances.agreedM, 'AGREED'],
    ['Manual (approved)', s.distances.manualM, 'MANUAL_APPROVED'],
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {items.map(([label, m, src]) => (
        <div key={label} className={s.distanceSource === src ? 'rounded-lg border-2 border-primary/60 p-2' : 'rounded-lg border p-2'}>
          <p className="text-xs text-muted-foreground">{t(label)}</p>
          <p className="font-medium tabular-nums">{formatKm(m)}</p>
          {s.distanceSource === src && <p className="text-xs text-primary">{t('Used for billing')}</p>}
        </div>
      ))}
      <div className="col-span-2 rounded-lg border bg-accent p-2 sm:col-span-1">
        <p className="text-xs text-muted-foreground">{t('Billable')}</p>
        <p className="font-semibold tabular-nums">{formatKm(s.distances.billableM)}</p>
        <p className="text-xs text-muted-foreground">{s.distanceSource ? t(enumLabel(s.distanceSource)) : t('Unknown')}</p>
      </div>
    </div>
  );
}

/** Pricing → Trip charges → one trip: breakdown, recalculation, manual billable distance, override, history, audit. */
export function TripChargeDetailPage() {
  const { tripId } = useParams();
  const { t } = useTranslation();
  const { can } = useAuth();
  const q = useQuery({ queryKey: pk('trip-charge', tripId), queryFn: ({ signal }) => api.get<TripChargeDetailResponse>(`${P}/trip-charges/${tripId}`, undefined, signal), enabled: !!tripId });
  const [recalc, setRecalc] = useState(false);
  const [distance, setDistance] = useState(false);
  const [km, setKm] = useState('');
  const [override, setOverride] = useState(false);
  const [amount, setAmount] = useState('');
  const recalculate = usePricingMutation((reason: string) => api.post(`${P}/trip-charges/${tripId}/recalculate`, { reason: reason || null }), { success: 'Trip recalculated', toastError: false, onSuccess: () => setRecalc(false) });
  const setBillable = usePricingMutation((reason: string) => api.post(`${P}/trip-charges/${tripId}/billable-distance`, { distanceKm: km.trim(), reason } satisfies BillableDistanceRequest), { success: 'Billable distance saved', toastError: false, onSuccess: () => setDistance(false) });
  const doOverride = usePricingMutation((reason: string) => api.post<TripOverrideResponse>(`${P}/trip-charges/${tripId}/override`, { amount: amount.trim(), reason } satisfies TripOverrideRequest), {
    success: (r) => (r.adjustment ? t('Override sent for approval (Billing adjustments)') : t('Trip price overridden')),
    toastError: false,
    onSuccess: () => setOverride(false),
  });

  return (
    <QueryView query={q}>
      {(d) => {
        const s = d.current;
        const invoiced = !!s?.invoiceId;
        const kmError = km.trim() && !KM.test(km.trim()) ? 'Enter km with at most 3 decimals' : null;
        const amtError = s ? (amount.trim() ? amountError(amount, s.currency) : null) : null;
        return (
          <PricingShell
            title={t('Trip charge')}
            description={<span className="font-mono text-xs">{tripId}</span>}
            actions={
              s && (
                <>
                  {can('etms_dispatch') && (
                    <Button size="sm" variant="outline" asChild>
                      <Link to={`/transport/trips/${tripId}`}>{t('Open trip')}</Link>
                    </Button>
                  )}
                  {can('pricing_trip_charges', 'edit') && (
                    <>
                      <Button size="sm" variant="outline" disabled={invoiced} onClick={() => setRecalc(true)}>
                        <CalculatorIcon /> {t('Recalculate')}
                      </Button>
                      <Button size="sm" variant="outline" disabled={invoiced} onClick={() => (setKm(''), setDistance(true))}>
                        <RulerIcon /> {t('Set billable distance')}
                      </Button>
                    </>
                  )}
                  {can('pricing_trip_charges', 'command') && (
                    <Button size="sm" variant="outline" disabled={invoiced} onClick={() => (setAmount(''), setOverride(true))}>
                      <HandCoinsIcon /> {t('Override price')}
                    </Button>
                  )}
                </>
              )
            }
          >
            {!s ? (
              <Empty title="Not priced yet" description="This trip has no price snapshot yet. Recalculate to price it now." />
            ) : (
              <>
                {invoiced && (
                  <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
                    {t('This trip is on an invoice; it can no longer be recalculated. Use an adjustment or a credit note.')}{' '}
                    {can('pricing_invoices') && (
                      <Link className="font-medium text-primary hover:underline" to={`/pricing/invoices/${s.invoiceId}`}>
                        {t('Open invoice')}
                      </Link>
                    )}
                  </p>
                )}
                {(s.gpsQuality !== 'OK' || s.status === 'NEEDS_REVIEW') && (
                  <p className="flex items-start gap-2 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
                    <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning-fg" aria-hidden />
                    <span>
                      <span className="font-medium">{t(s.gpsQuality === 'MISSING' ? 'GPS missing' : s.gpsQuality === 'LOW_COVERAGE' ? 'Low GPS coverage' : s.gpsQuality === 'UNAVAILABLE' ? 'GPS unavailable' : 'Needs review')}</span>
                      {' — '}
                      {t('Check the distance and set the billable distance manually with a reason if needed. Trips needing review are not invoiced.')}
                    </span>
                  </p>
                )}
                <Section title={t('Pricing')}>
                  <Facts
                    items={[
                      ['Status', <StatusPill key="s" status={s.status} />],
                      ['Total', <Money key="m" minor={s.totalMinor} currency={s.currency} className="font-semibold" />],
                      ['Service date', s.serviceDate],
                      ['Pricing model', s.pricingModel ? t(enumLabel(s.pricingModel)) : '—'],
                      [
                        'Pricing source',
                        s.contractId ? (
                          <span key="c">
                            {can('pricing_contracts') ? (
                              <Link className="text-primary hover:underline" to={`/pricing/contracts/${s.contractId}`}>
                                {s.contractName}
                              </Link>
                            ) : (
                              s.contractName
                            )}
                            {s.vehicleRateId && <Badge variant="info" className="ml-1">{t('Vehicle rate')}</Badge>}
                            {s.override && <Badge variant="warning" className="ml-1">{t('Override')}</Badge>}
                          </span>
                        ) : (
                          t('No applicable contract')
                        ),
                      ],
                      ['GPS quality', t(enumLabel(s.gpsQuality))],
                      ['Planned duration', s.plannedDurationS !== null ? formatDuration(s.plannedDurationS) : '—'],
                      ['Actual duration', s.actualDurationS !== null ? formatDuration(s.actualDurationS) : '—'],
                      ['Waiting', s.waitingS !== null ? formatDuration(s.waitingS) : '—'],
                      ['Extra stops', String(s.extraStops)],
                      ['Calculated', `${formatDateTime(s.calculatedAt)} · ${s.engineVersion}`],
                      ['Reason', s.reason ?? s.override?.reason ?? '—'],
                    ]}
                  />
                </Section>
                <Section title={t('Distances')} description={t('The highlighted value is the one the contract bills; the billable distance is what was priced.')}>
                  <Distances s={s} />
                </Section>
                <Section title={t('Breakdown')}>
                  <div className="space-y-3">
                    <Issues issues={s.issues} />
                    <PriceBreakdown currency={s.currency} lines={s.lines} subtotalMinor={s.subtotalMinor} discountMinor={s.discountMinor} taxLines={s.taxLines} taxMinor={s.taxMinor} totalMinor={s.totalMinor} />
                  </div>
                </Section>
              </>
            )}
            {d.history.length > 0 && (
              <Section title={t('Price history')} description={t('Every calculation is kept; only the current one counts.')}>
                <ScrollTable label={t('Price history')} minWidth={640}>
                  <thead>
                    <tr>
                      <Th>{t('Calculated')}</Th>
                      <Th>{t('Status')}</Th>
                      <Th right>{t('Billable')}</Th>
                      <Th>{t('Reason')}</Th>
                      <Th right>{t('Total')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.history.map((h) => (
                      <tr key={h.id} className={h.isCurrent ? 'bg-accent/40' : undefined}>
                        <Td className="whitespace-nowrap">
                          {formatDateTime(h.calculatedAt)}
                          {h.isCurrent && <Badge variant="success" className="ml-1">{t('Current')}</Badge>}
                        </Td>
                        <Td>
                          <StatusPill status={h.status} />
                        </Td>
                        <Td right>{formatKm(h.distances.billableM)}</Td>
                        <Td className="text-xs">{h.reason ?? h.override?.reason ?? '—'}</Td>
                        <Td right>
                          <Money minor={h.totalMinor} currency={h.currency} />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </ScrollTable>
              </Section>
            )}
            {d.audit.length > 0 && (
              <Section title={t('Audit')}>
                <ol className="space-y-3">
                  {d.audit.map((a) => (
                    <li key={a.id} className="space-y-1 border-l-2 pl-3">
                      <p className="text-sm">
                        <span className="font-medium">{a.userName ?? t('System')}</span> · {t(enumLabel(a.action))} · <span className="text-xs text-muted-foreground">{formatDateTime(a.createdAt)}</span>
                      </p>
                      <ChangesView changes={a.changes} />
                    </li>
                  ))}
                </ol>
              </Section>
            )}

            <ReasonDialog open={recalc} onOpenChange={setRecalc} title="Recalculate trip" description="Prices the trip again from the current contract and trip data. The previous calculation is kept in the history." reasonRequired={false} pending={recalculate.isPending} error={recalculate.error} onSubmit={(r) => recalculate.mutate(r)} confirmLabel="Recalculate" />
            <ReasonDialog open={distance} onOpenChange={setDistance} title="Set billable distance" description="Overrides the GPS / planned distance for this trip and prices it again." pending={setBillable.isPending} error={setBillable.error} canSubmit={!!km.trim() && !kmError} onSubmit={(r) => setBillable.mutate(r)} confirmLabel="Save">
              <Labeled label="Billable km" error={kmError ?? (!km.trim() ? 'Required' : null)}>
                {(id) => <Input id={id} inputMode="decimal" value={km} onChange={(e) => setKm(e.target.value)} />}
              </Labeled>
            </ReasonDialog>
            <ReasonDialog
              open={override}
              onOpenChange={setOverride}
              title="Override trip price"
              description="A negotiated price before tax replaces the calculated base and add-ons. When the contract requires it, a second user approves the override first."
              pending={doOverride.isPending}
              error={doOverride.error}
              canSubmit={!!amount.trim() && !amtError}
              onSubmit={(r) => doOverride.mutate(r)}
              confirmLabel="Override"
            >
              <Labeled label={`${t('Price before tax')} (${s?.currency ?? ''})`} error={amtError ?? (!amount.trim() ? 'Required' : null)}>
                {(id) => <Input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
              </Labeled>
            </ReasonDialog>
          </PricingShell>
        );
      }}
    </QueryView>
  );
}
