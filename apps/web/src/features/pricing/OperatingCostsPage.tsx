import { COST_CATEGORIES, CURRENCY_EXPONENTS, type CreateOperatingCostRequest, type OperatingCostDto, type PricingPage } from '@veetracer/shared';
import { PlusIcon, WalletIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import { api } from '@/lib/api';
import { VehiclePicker } from './DedicatedVehicles';
import { amountError } from './money';
import { P, usePricingMutation, usePricingQuery } from './pricing-api';
import { Empty, enumLabel, FilterBar, Labeled, Money, Pager, PricingShell, QueryView, ScrollTable, Sel, SimpleDialog, Td, Th, monthStart, todayYmd } from './ui';

const PAGE_SIZE = 50;
const CURRENCIES = Object.keys(CURRENCY_EXPONENTS).sort();

/** Pricing → Operating costs & margin (menu pricing_costs): manual cost records used by the margin report. */
export function OperatingCostsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const today = todayYmd();
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [touched, setTouched] = useState(false);
  const [form, setForm] = useState<CreateOperatingCostRequest>({ date: today, category: 'FUEL', amount: '', currency: 'INR', objectId: null, note: '' });
  const list = usePricingQuery<PricingPage<OperatingCostDto>>(['costs'], `${P}/costs`, { from, to, category: category || undefined, page, pageSize: PAGE_SIZE });
  const amtErr = amountError(form.amount, form.currency);
  const create = usePricingMutation(() => api.post(`${P}/costs`, { ...form, amount: form.amount.trim(), note: form.note || null, source: 'MANUAL' } satisfies CreateOperatingCostRequest), { success: 'Cost recorded', toastError: false, onSuccess: () => setCreating(false) });
  return (
    <PricingShell
      title={t('Operating costs & margin')}
      description={t('Driver, fuel, maintenance and other costs per vehicle and day. The margin report subtracts them from revenue.')}
      actions={
        can('pricing_costs', 'create') && (
          <Button size="sm" onClick={() => (setTouched(false), setForm({ date: today, category: 'FUEL', amount: '', currency: form.currency, objectId: null, note: '' }), setCreating(true))}>
            <PlusIcon /> {t('Record cost')}
          </Button>
        )
      }
    >
      <FilterBar>
        <Labeled label="From">{(id) => <Input id={id} type="date" value={from} onChange={(e) => (setFrom(e.target.value), setPage(1))} />}</Labeled>
        <Labeled label="To">{(id) => <Input id={id} type="date" value={to} onChange={(e) => (setTo(e.target.value), setPage(1))} />}</Labeled>
        <Labeled label="Category">{(id) => <Sel id={id} value={category} allLabel="All categories" onChange={(v) => (setCategory(v), setPage(1))} options={COST_CATEGORIES.map((c) => ({ value: c, label: t(enumLabel(c)) }))} />}</Labeled>
      </FilterBar>
      <QueryView query={list}>
        {(d) =>
          d.items.length === 0 ? (
            <Empty icon={WalletIcon} title="No costs recorded" />
          ) : (
            <>
              <ScrollTable label={t('Operating costs')} minWidth={640}>
                <thead>
                  <tr>
                    <Th>{t('Date')}</Th>
                    <Th>{t('Category')}</Th>
                    <Th>{t('Source')}</Th>
                    <Th>{t('Note')}</Th>
                    <Th right>{t('Amount')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((c) => (
                    <tr key={c.id}>
                      <Td className="whitespace-nowrap">{c.date}</Td>
                      <Td>{t(enumLabel(c.category))}</Td>
                      <Td>{t(enumLabel(c.source))}</Td>
                      <Td className="text-xs">{c.note ?? '—'}</Td>
                      <Td right>
                        <Money minor={c.amountMinor} currency={c.currency} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </ScrollTable>
              <Pager page={page} pageSize={PAGE_SIZE} total={d.total} onPage={setPage} />
            </>
          )
        }
      </QueryView>
      <SimpleDialog
        open={creating}
        onOpenChange={setCreating}
        title="Record cost"
        pending={create.isPending}
        error={create.error}
        onSubmit={() => {
          setTouched(true);
          if (!amtErr) create.mutate(undefined);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Labeled label="Date">{(id) => <Input id={id} type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />}</Labeled>
          <Labeled label="Category">{(id) => <Sel id={id} value={form.category} onChange={(v) => setForm({ ...form, category: v as CreateOperatingCostRequest['category'] })} options={COST_CATEGORIES.map((c) => ({ value: c, label: t(enumLabel(c)) }))} />}</Labeled>
          <Labeled label="Amount" error={touched ? amtErr : null}>{(id) => <Input id={id} inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />}</Labeled>
          <Labeled label="Currency">{(id) => <Sel id={id} value={form.currency} onChange={(v) => setForm({ ...form, currency: v })} options={CURRENCIES.map((c) => ({ value: c, label: c }))} />}</Labeled>
          <Labeled label="Vehicle (optional)" className="sm:col-span-2">{(id) => <VehiclePicker id={id} value={form.objectId ?? null} onChange={(v) => setForm({ ...form, objectId: v })} />}</Labeled>
          <Labeled label="Note" className="sm:col-span-2">{(id) => <Input id={id} value={form.note ?? ''} maxLength={500} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Labeled>
        </div>
      </SimpleDialog>
    </PricingShell>
  );
}
