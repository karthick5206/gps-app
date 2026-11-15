import { PRICING_CONTRACT_STATUSES, type PricingContractSummaryDto, type PricingPage } from '@veetracer/shared';
import { FileTextIcon, PlusIcon, SettingsIcon } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import { ContractForm } from './ContractForm';
import { P, usePricingQuery } from './pricing-api';
import { Empty, enumLabel, FilterBar, Labeled, Pager, PricingShell, QueryView, ScrollTable, Sel, StatusPill, Td, Th } from './ui';

const PAGE_SIZE = 25;

/** Pricing → Company contracts (menu pricing_contracts): list; the contract screen is /pricing/contracts/:id. */
export function ContractsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const search = useDeferredValue(q);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const status = params.get('status') ?? '';
  const list = usePricingQuery<PricingPage<PricingContractSummaryDto>>(['contracts'], `${P}/contracts`, { status: status || undefined, q: search || undefined, page, pageSize: PAGE_SIZE });
  return (
    <PricingShell
      title={t('Company contracts')}
      description={t('What each customer pays: pricing model, rates, validity and approvals.')}
      actions={
        <>
          <Button variant="outline" size="sm" asChild>
            <Link to="/pricing/settings">
              <SettingsIcon /> {t('Pricing settings')}
            </Link>
          </Button>
          {can('pricing_contracts', 'create') && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <PlusIcon /> {t('New contract')}
            </Button>
          )}
        </>
      }
    >
      <FilterBar>
        <Labeled label="Search">{(id) => <Input id={id} value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} placeholder={t('Name, customer or reference')} />}</Labeled>
        <Labeled label="Status">
          {(id) => (
            <Sel
              id={id}
              value={status}
              allLabel="All statuses"
              options={PRICING_CONTRACT_STATUSES.map((s) => ({ value: s, label: t(enumLabel(s)) }))}
              onChange={(v) => {
                setPage(1);
                setParams(v ? { status: v } : {}, { replace: true });
              }}
            />
          )}
        </Labeled>
      </FilterBar>
      <QueryView query={list}>
        {(d) =>
          d.items.length === 0 ? (
            <Empty icon={FileTextIcon} title="No contracts yet" description={can('pricing_contracts', 'create') ? 'Create the first contract to start pricing trips.' : undefined} />
          ) : (
            <>
              <ScrollTable label={t('Company contracts')} minWidth={760}>
                <thead>
                  <tr>
                    <Th>{t('Contract')}</Th>
                    <Th>{t('Customer')}</Th>
                    <Th>{t('Status')}</Th>
                    <Th>{t('Current version')}</Th>
                    <Th>{t('Billing')}</Th>
                    <Th>{t('Currency')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((c) => (
                    <tr key={c.id} className="hover:bg-muted/40">
                      <Td>
                        <Link to={`/pricing/contracts/${c.id}`} className="font-medium text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                          {c.name}
                        </Link>
                        {c.reference && <span className="block text-xs text-muted-foreground">{c.reference}</span>}
                      </Td>
                      <Td>
                        {c.customerName}
                        {!c.customerCompanyId && <span className="block text-xs text-muted-foreground">{c.isDefault ? t('Default contract') : t('Internal')}</span>}
                      </Td>
                      <Td>
                        <span className="flex flex-wrap gap-1">
                          <StatusPill status={c.status} />
                          {c.pendingVersionId && <Badge variant="warning">{t('Approval pending')}</Badge>}
                        </span>
                      </Td>
                      <Td>{c.currentVersion ? `v${c.currentVersion.versionNo} · ${c.currentVersion.validFrom}${c.currentVersion.validTo ? ` – ${c.currentVersion.validTo}` : ''}` : '—'}</Td>
                      <Td>{t(enumLabel(c.billingFrequency))}</Td>
                      <Td>{c.currency}</Td>
                    </tr>
                  ))}
                </tbody>
              </ScrollTable>
              <Pager page={page} pageSize={PAGE_SIZE} total={d.total} onPage={setPage} />
            </>
          )
        }
      </QueryView>
      {creating && <ContractForm open={creating} onOpenChange={setCreating} />}
    </PricingShell>
  );
}
