import { AVAILABILITY_PERIOD_STATUSES, type AvailabilityCloseResponse, type AvailabilityPeriodDto, type AvailabilityPeriodRequest, type PricingPage } from '@veetracer/shared';
import { CalendarCheckIcon, ChevronDownIcon, ChevronRightIcon, LockIcon, RefreshCwIcon } from 'lucide-react';
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import { api } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { formatKm } from './money';
import { newIdempotencyKey, P, postIdempotent, useContractOptions, usePricingMutation, usePricingQuery } from './pricing-api';
import { Empty, enumLabel, FilterBar, Issues, Labeled, Money, Pager, PriceBreakdown, PricingShell, QueryView, ScrollTable, Sel, SimpleDialog, StatusPill, Td, Th, todayYmd } from './ui';

const PAGE_SIZE = 50;

/** Pricing → Availability billing (menu pricing_availability): periods per dedicated vehicle, compute, close. */
export function AvailabilityPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const { contracts } = useContractOptions();
  const contractId = params.get('contract') ?? '';
  const status = params.get('status') ?? '';
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const [action, setAction] = useState<'compute' | 'close' | null>(null);
  const [form, setForm] = useState<AvailabilityPeriodRequest>({ contractId: '', periodDate: todayYmd() });
  const [key, setKey] = useState(newIdempotencyKey);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
    setPage(1);
  };
  const list = usePricingQuery<PricingPage<AvailabilityPeriodDto>>(['availability'], `${P}/availability`, { contractId: contractId || undefined, status: status || undefined, page, pageSize: PAGE_SIZE });
  const compute = usePricingMutation((b: AvailabilityPeriodRequest) => api.post<AvailabilityPeriodDto[]>(`${P}/availability/compute`, b), { success: (r) => t('{{count}} period(s) computed', { count: r.length }), toastError: false, onSuccess: () => setAction(null) });
  const close = usePricingMutation((b: AvailabilityPeriodRequest) => postIdempotent<AvailabilityCloseResponse>(`${P}/availability/close`, b, key), {
    success: (r) => t('{{count}} period(s) closed', { count: r.periods.length }),
    toastError: false,
    onSuccess: () => {
      setAction(null);
      setKey(newIdempotencyKey());
    },
  });
  const start = (a: 'compute' | 'close') => {
    setForm({ contractId: contractId || contracts[0]?.id || '', periodDate: todayYmd() });
    if (a === 'close') setKey(newIdempotencyKey());
    setAction(a);
  };
  const m = action === 'close' ? close : compute;
  return (
    <PricingShell
      title={t('Availability billing')}
      description={t('Periods per dedicated vehicle: days attached and billable, downtime, included versus used km / hours, excess. Closed periods go on the next invoice.')}
      actions={
        <>
          <Button size="sm" variant="outline" onClick={() => start('compute')} disabled={!contracts.length}>
            <RefreshCwIcon /> {t('Compute period')}
          </Button>
          {can('pricing_availability', 'command') && (
            <Button size="sm" onClick={() => start('close')} disabled={!contracts.length}>
              <LockIcon /> {t('Close period')}
            </Button>
          )}
        </>
      }
    >
      <FilterBar>
        <Labeled label="Contract">{(id) => <Sel id={id} value={contractId} allLabel="All contracts" onChange={(v) => set('contract', v)} options={contracts.map((c) => ({ value: c.id, label: c.name }))} />}</Labeled>
        <Labeled label="Status">{(id) => <Sel id={id} value={status} allLabel="All statuses" onChange={(v) => set('status', v)} options={AVAILABILITY_PERIOD_STATUSES.map((s) => ({ value: s, label: t(enumLabel(s)) }))} />}</Labeled>
      </FilterBar>
      <QueryView query={list}>
        {(d) =>
          d.items.length === 0 ? (
            <Empty icon={CalendarCheckIcon} title="No availability periods" description="Add dedicated vehicles to a contract with an availability fee, then compute the period." />
          ) : (
            <>
              <ScrollTable label={t('Availability periods')} minWidth={980}>
                <thead>
                  <tr>
                    <Th />
                    <Th>{t('Vehicle')}</Th>
                    <Th>{t('Period')}</Th>
                    <Th right>{t('Attached / billable days')}</Th>
                    <Th right>{t('Downtime')}</Th>
                    <Th right>{t('Used')}</Th>
                    <Th right>{t('Trips')}</Th>
                    <Th>{t('Status')}</Th>
                    <Th right>{t('Total')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((p) => (
                    <Fragment key={p.id}>
                      <tr className="hover:bg-muted/40">
                        <Td>
                          <Button size="icon-sm" variant="ghost" aria-expanded={open === p.id} aria-label={t('Show breakdown')} onClick={() => setOpen(open === p.id ? null : p.id)}>
                            {open === p.id ? <ChevronDownIcon /> : <ChevronRightIcon />}
                          </Button>
                        </Td>
                        <Td className="font-medium">{p.objectName ?? '—'}</Td>
                        <Td className="whitespace-nowrap">
                          {p.periodStart} – {p.periodEnd}
                          <span className="block text-xs text-muted-foreground">{t(enumLabel(p.frequency))}</span>
                        </Td>
                        <Td right className="tabular-nums">
                          {p.attachedDays} / {p.billableDays}
                        </Td>
                        <Td right className="tabular-nums">
                          {p.downtimeDays}
                          {p.suspensionDays ? ` + ${t('{{n}} suspended', { n: p.suspensionDays })}` : ''}
                        </Td>
                        <Td right className="whitespace-nowrap">
                          {formatKm(p.usedDistanceM)}
                          <span className="block text-xs text-muted-foreground">{formatDuration(p.usedSeconds)}</span>
                        </Td>
                        <Td right className="tabular-nums">{p.tripCount}</Td>
                        <Td>
                          <StatusPill status={p.status} />
                        </Td>
                        <Td right className="font-medium">
                          <Money minor={p.totalMinor} currency={p.currency} />
                        </Td>
                      </tr>
                      {open === p.id && (
                        <tr>
                          <Td colSpan={9} className="bg-muted/20">
                            <div className="space-y-3 py-2">
                              <Issues issues={p.issues} />
                              <PriceBreakdown currency={p.currency} lines={p.lines} subtotalMinor={p.subtotalMinor} discountMinor={p.discountMinor} taxLines={p.taxLines} taxMinor={p.taxMinor} totalMinor={p.totalMinor} />
                            </div>
                          </Td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </ScrollTable>
              <Pager page={page} pageSize={PAGE_SIZE} total={d.total} onPage={setPage} />
            </>
          )
        }
      </QueryView>
      <SimpleDialog
        open={!!action}
        onOpenChange={(o) => !o && setAction(null)}
        title={action === 'close' ? 'Close availability period' : 'Compute availability period'}
        description={action === 'close' ? 'Closing freezes the period for every dedicated vehicle of the contract; it then goes on the next invoice. Sending it twice is safe.' : 'Recomputes the open periods of the contract from the latest trips, downtime and assignments.'}
        pending={m.isPending}
        error={m.error}
        submitLabel={action === 'close' ? 'Close period' : 'Compute'}
        onSubmit={() => form.contractId && m.mutate(form)}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Labeled label="Contract" className="sm:col-span-2">{(id) => <Sel id={id} value={form.contractId} onChange={(v) => setForm({ ...form, contractId: v })} options={contracts.map((c) => ({ value: c.id, label: c.name }))} />}</Labeled>
          <Labeled label="Any date in the period" hint="The contract’s fee frequency decides the period bounds.">
            {(id) => <Input id={id} type="date" value={form.periodDate} onChange={(e) => setForm({ ...form, periodDate: e.target.value })} />}
          </Labeled>
        </div>
      </SimpleDialog>
    </PricingShell>
  );
}
