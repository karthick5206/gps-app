import { TRIP_PRICE_STATUSES, type BranchDto, type TripChargeListResponse } from '@veetracer/shared';
import { AlertTriangleIcon, FileDownIcon, RouteIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Link, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { downloadCsv } from '@/lib/api';
import { pricingErrorMessage } from './errors';
import { formatKm } from './money';
import { P, useContractOptions, usePricingQuery } from './pricing-api';
import { Empty, enumLabel, FilterBar, Labeled, Money, Pager, PricingShell, QueryView, ScrollTable, Sel, StatusPill, Td, Th, monthStart, todayYmd } from './ui';

const PAGE_SIZE = 50;

/** Pricing → Trip charges (menu pricing_trip_charges): priced trips with filters, review queue and CSV. */
export function TripChargesPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const today = todayYmd();
  const from = params.get('from') ?? monthStart(today);
  const to = params.get('to') ?? today;
  const status = params.get('status') ?? '';
  const branchId = params.get('branch') ?? '';
  const contractId = params.get('contract') ?? '';
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
    setPage(1);
  };
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: can('branches') });
  const { contracts } = useContractOptions(can('pricing_contracts'));
  const query = { from, to, status: status || undefined, branchId: branchId || undefined, contractId: contractId || undefined };
  const list = usePricingQuery<TripChargeListResponse>(['trip-charges'], `${P}/trip-charges`, { ...query, page, pageSize: PAGE_SIZE });
  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadCsv(`${P}/trip-charges`, query, `trip-charges-${from}-${to}.csv`);
    } catch (e) {
      toast.error(pricingErrorMessage(e, t));
    } finally {
      setExporting(false);
    }
  };
  return (
    <PricingShell
      title={t('Trip charges')}
      description={t('What each trip costs the customer: billable distance, model, rate, surcharges, tax and total. Trips needing review are left out of invoices.')}
      actions={
        can('pricing_trip_charges', 'export') && (
          <Button size="sm" variant="outline" onClick={() => void exportCsv()} disabled={exporting}>
            <FileDownIcon /> CSV
          </Button>
        )
      }
    >
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('Quick filters')}>
        {[
          ['', 'All'],
          ['NEEDS_REVIEW', 'Review queue'],
          ['NO_APPLICABLE_PRICING', 'No pricing'],
          ['ERROR', 'Errors'],
        ].map(([v, l]) => (
          <Button key={v} size="sm" variant={status === v ? 'default' : 'outline'} aria-pressed={status === v} onClick={() => set('status', v)}>
            {t(l)}
          </Button>
        ))}
      </div>
      <FilterBar>
        <Labeled label="From">{(id) => <Input id={id} type="date" value={from} max={to} onChange={(e) => set('from', e.target.value)} />}</Labeled>
        <Labeled label="To">{(id) => <Input id={id} type="date" value={to} min={from} onChange={(e) => set('to', e.target.value)} />}</Labeled>
        <Labeled label="Status">{(id) => <Sel id={id} value={status} allLabel="All statuses" onChange={(v) => set('status', v)} options={TRIP_PRICE_STATUSES.map((s) => ({ value: s, label: t(enumLabel(s)) }))} />}</Labeled>
        {can('branches') && <Labeled label="Branch">{(id) => <Sel id={id} value={branchId} allLabel="All branches" onChange={(v) => set('branch', v)} options={branches.options} />}</Labeled>}
        {can('pricing_contracts') && <Labeled label="Contract">{(id) => <Sel id={id} value={contractId} allLabel="All contracts" onChange={(v) => set('contract', v)} options={contracts.map((c) => ({ value: c.id, label: c.name }))} />}</Labeled>}
      </FilterBar>
      <QueryView query={list}>
        {(d) => (
          <>
            {d.totals.length > 0 && (
              <div className="flex flex-wrap gap-3">
                {d.totals.map((x) => (
                  <div key={x.currency} className="rounded-lg border bg-card px-3 py-2">
                    <p className="text-xs text-muted-foreground">{t('{{count}} trip(s)', { count: x.count })}</p>
                    <p className="text-lg font-semibold">
                      <Money minor={x.totalMinor} currency={x.currency} />
                    </p>
                  </div>
                ))}
              </div>
            )}
            {d.items.length === 0 ? (
              <Empty icon={RouteIcon} title="No trip charges" description="Trips are priced after they finish (every 30 minutes) or when recalculated." />
            ) : (
              <>
                <ScrollTable label={t('Trip charges')} minWidth={900}>
                  <thead>
                    <tr>
                      <Th>{t('Date')}</Th>
                      <Th>{t('Trip')}</Th>
                      <Th>{t('Contract')}</Th>
                      <Th>{t('Model')}</Th>
                      <Th right>{t('Billable')}</Th>
                      <Th>{t('Status')}</Th>
                      <Th right>{t('Total')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((s) => (
                      <tr key={s.id} className="hover:bg-muted/40">
                        <Td className="whitespace-nowrap tabular-nums">{s.serviceDate}</Td>
                        <Td>
                          <Link to={`/pricing/trip-charges/${s.transportTripId}`} className="font-mono text-xs text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                            {s.transportTripId.slice(0, 8)}
                          </Link>
                          {s.invoiceId && <span className="block text-xs text-muted-foreground">{t('Invoiced')}</span>}
                        </Td>
                        <Td>{s.contractName ?? '—'}</Td>
                        <Td>{s.pricingModel ? t(enumLabel(s.pricingModel)) : '—'}</Td>
                        <Td right className="whitespace-nowrap">
                          {formatKm(s.distances.billableM)}
                          {s.gpsQuality !== 'OK' && (
                            <span className="flex items-center justify-end gap-1 text-xs text-warning-fg">
                              <AlertTriangleIcon className="size-3" aria-hidden /> {t(s.gpsQuality === 'MISSING' ? 'GPS missing' : s.gpsQuality === 'LOW_COVERAGE' ? 'Low GPS coverage' : 'GPS unavailable')}
                            </span>
                          )}
                        </Td>
                        <Td>
                          <StatusPill status={s.status} />
                        </Td>
                        <Td right className="font-medium">
                          <Money minor={s.totalMinor} currency={s.currency} />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </ScrollTable>
                <Pager page={page} pageSize={PAGE_SIZE} total={d.total} onPage={setPage} />
              </>
            )}
          </>
        )}
      </QueryView>
    </PricingShell>
  );
}
