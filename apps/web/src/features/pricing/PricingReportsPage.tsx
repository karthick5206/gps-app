import { PRICING_REPORT_GROUPS, PRICING_REPORT_TYPES, type BranchDto, type PricingReportDto, type PricingReportType } from '@veetracer/shared';
import { BarChart3Icon, FileDownIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { downloadCsv } from '@/lib/api';
import { canSeeCosts, reportTypesFor } from './access';
import { pricingErrorMessage } from './errors';
import { P, useContractOptions, usePricingQuery } from './pricing-api';
import { buildReportView } from './reports';
import { Empty, enumLabel, FilterBar, Labeled, Money, PricingShell, QueryView, ScrollTable, Sel, Td, Th, monthStart, todayYmd } from './ui';

const TYPE_LABEL: Record<PricingReportType, string> = {
  revenue: 'Revenue',
  trips: 'Trips by status (per km, per trip)',
  availability: 'Availability revenue',
  ageing: 'Invoice ageing',
  margin: 'Margin (revenue − cost)',
};
const GROUP_LABEL: Record<string, string> = { contract: 'Contract', customer: 'Customer', branch: 'Branch', vehicle: 'Vehicle (per vehicle-day)', day: 'Day', month: 'Month' };

/** Pricing → Reports (menu pricing_reports): revenue, trips, availability, ageing, margin; cost columns only with pricing_costs. */
export function PricingReportsPage() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const costs = canSeeCosts(me?.permissions);
  const today = todayYmd();
  const [type, setType] = useState<PricingReportType>('revenue');
  const [groupBy, setGroupBy] = useState('contract');
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [contractId, setContractId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [exporting, setExporting] = useState(false);
  const { contracts } = useContractOptions(can('pricing_contracts'));
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: can('branches') });
  const query = { from, to, groupBy, contractId: contractId || undefined, branchId: branchId || undefined };
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const q = usePricingQuery<PricingReportDto>(['report', type], `${P}/reports/${type}`, query, valid);
  const view = useMemo(() => (q.data ? buildReportView(q.data, costs) : null), [q.data, costs]);
  const grouped = type !== 'ageing' && type !== 'trips';
  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadCsv(`${P}/reports/${type}`, query, `pricing-${type}-${from}-${to}.csv`);
    } catch (e) {
      toast.error(pricingErrorMessage(e, t));
    } finally {
      setExporting(false);
    }
  };
  return (
    <PricingShell
      title={t('Pricing reports')}
      description={costs ? t('Revenue, trips, availability, ageing and margin.') : t('Revenue, trips, availability and ageing. Cost and margin need the “Operating costs & margin” permission.')}
      actions={
        can('pricing_reports', 'export') && (
          <Button size="sm" variant="outline" onClick={() => void exportCsv()} disabled={exporting || !valid}>
            <FileDownIcon /> CSV
          </Button>
        )
      }
    >
      <FilterBar>
        <Labeled label="Report">{(id) => <Sel id={id} value={type} onChange={(v) => setType(v as PricingReportType)} options={reportTypesFor(PRICING_REPORT_TYPES, costs).map((r) => ({ value: r, label: t(TYPE_LABEL[r]) }))} />}</Labeled>
        {grouped && <Labeled label="Group by">{(id) => <Sel id={id} value={groupBy} onChange={setGroupBy} options={PRICING_REPORT_GROUPS.map((g) => ({ value: g, label: t(GROUP_LABEL[g]) }))} />}</Labeled>}
        <Labeled label="From">{(id) => <Input id={id} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}</Labeled>
        <Labeled label="To" error={valid ? null : 'Must be after the start date'}>{(id) => <Input id={id} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />}</Labeled>
        {can('pricing_contracts') && <Labeled label="Contract">{(id) => <Sel id={id} value={contractId} allLabel="All contracts" onChange={setContractId} options={contracts.map((c) => ({ value: c.id, label: c.name }))} />}</Labeled>}
        {can('branches') && <Labeled label="Branch">{(id) => <Sel id={id} value={branchId} allLabel="All branches" onChange={setBranchId} options={branches.options} />}</Labeled>}
      </FilterBar>
      {valid && (
        <QueryView query={q}>
          {() =>
            !view || view.rows.length === 0 ? (
              <Empty icon={BarChart3Icon} title="No data for this period" />
            ) : (
              <ScrollTable label={t(TYPE_LABEL[type])} minWidth={Math.max(640, view.columns.length * 130)}>
                <thead>
                  <tr>
                    {view.columns.map((c) => (
                      <Th key={c.key} right={c.kind !== 'text'}>
                        {t(c.label)}
                      </Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map((r, i) => (
                    <tr key={i}>
                      {view.columns.map((c) => {
                        const v = r[c.key];
                        const currency = typeof r.currency === 'string' ? r.currency : 'XXX';
                        return (
                          <Td key={c.key} right={c.kind !== 'text'} className="whitespace-nowrap">
                            {v === null || v === undefined ? '—' : c.kind === 'money' ? <Money minor={String(v)} currency={currency} /> : c.key === 'status' || c.key === 'bucket' ? t(enumLabel(String(v))) : String(v)}
                          </Td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </ScrollTable>
            )
          }
        </QueryView>
      )}
    </PricingShell>
  );
}
