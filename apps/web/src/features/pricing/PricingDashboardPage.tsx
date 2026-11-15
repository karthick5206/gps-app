import type { PricingDashboardDto } from '@veetracer/shared';
import { AlertTriangleIcon, FileClockIcon, FileTextIcon, GaugeIcon, HandCoinsIcon, ReceiptIcon, TrendingUpIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useAuth } from '@/features/auth/auth-context';
import { canSeeCosts } from './access';
import { P, usePricingQuery } from './pricing-api';
import { Money, PricingShell, QueryView, Section } from './ui';

function Tile({ label, icon: Icon, children, to, tone }: { label: string; icon: typeof ReceiptIcon; children: ReactNode; to?: string; tone?: 'warning' }) {
  const { t } = useTranslation();
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-medium text-muted-foreground">{t(label)}</p>
        <span className={tone === 'warning' ? 'flex size-8 shrink-0 items-center justify-center rounded-lg bg-warning-soft text-warning-fg' : 'flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-primary'} aria-hidden>
          <Icon className="size-4" />
        </span>
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums sm:text-2xl">{children}</div>
    </>
  );
  const cls = 'flex min-w-0 flex-col rounded-xl border bg-card p-4 shadow-xs';
  return to ? (
    <Link to={to} className={`${cls} hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function MoneyList({ items }: { items: { currency: string; minor: string }[] }) {
  if (!items.length) return <span>—</span>;
  return (
    <span className="flex flex-col">
      {items.map((x) => (
        <Money key={x.currency} minor={x.minor} currency={x.currency} />
      ))}
    </span>
  );
}

/** Pricing → Dashboard (menu `pricing`): this month's revenue, review queue, receivables, approvals; margin only with pricing_costs. */
export function PricingDashboardPage() {
  const { t } = useTranslation();
  const { me, can } = useAuth();
  const q = usePricingQuery<PricingDashboardDto>(['dashboard'], `${P}/dashboard`);
  const costs = canSeeCosts(me?.permissions);
  return (
    <PricingShell title={t('Pricing dashboard')} description={t('This month’s revenue, trips needing review, open invoices and contracts waiting for you.')}>
      <QueryView query={q} rows={4}>
        {(d) => (
          <>
            <p className="text-xs text-muted-foreground">{t('Month: {{month}}', { month: d.month })}</p>
            <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-4">
              <Tile label="Revenue this month (before tax)" icon={TrendingUpIcon} to={can('pricing_reports') ? '/pricing/reports' : undefined}>
                <MoneyList items={d.revenue.map((r) => ({ currency: r.currency, minor: r.totalMinor }))} />
              </Tile>
              <Tile label="Trips priced" icon={GaugeIcon} to={can('pricing_trip_charges') ? '/pricing/trip-charges?status=PRICED' : undefined}>
                {d.tripsPriced}
              </Tile>
              <Tile label="Trips needing review" icon={AlertTriangleIcon} tone={d.tripsNeedingReview ? 'warning' : undefined} to={can('pricing_trip_charges') ? '/pricing/trip-charges?status=NEEDS_REVIEW' : undefined}>
                {d.tripsNeedingReview}
              </Tile>
              <Tile label="Trips without pricing" icon={AlertTriangleIcon} tone={d.tripsWithoutPricing ? 'warning' : undefined} to={can('pricing_trip_charges') ? '/pricing/trip-charges?status=NO_APPLICABLE_PRICING' : undefined}>
                {d.tripsWithoutPricing}
              </Tile>
              <Tile label="Open invoices" icon={ReceiptIcon} to={can('pricing_invoices') ? '/pricing/invoices' : undefined}>
                {d.openInvoices}
                {d.overdueInvoices > 0 && <span className="block text-xs font-medium text-destructive-fg">{t('{{n}} overdue', { n: d.overdueInvoices })}</span>}
              </Tile>
              <Tile label="Outstanding" icon={HandCoinsIcon}>
                <MoneyList items={d.outstanding.map((r) => ({ currency: r.currency, minor: r.balanceMinor }))} />
              </Tile>
              <Tile label="Contract versions waiting for approval" icon={FileClockIcon} tone={d.contractsPendingApproval ? 'warning' : undefined} to={can('pricing_contracts') ? '/pricing/contracts?status=PENDING_APPROVAL' : undefined}>
                {d.contractsPendingApproval}
              </Tile>
              <Tile label="Contracts expiring in 30 days" icon={FileTextIcon} to={can('pricing_contracts') ? '/pricing/contracts' : undefined}>
                {d.contractsExpiringSoon}
              </Tile>
            </div>
            {costs && d.margin && (
              <Section title={t('Margin this month')} description={t('Revenue before tax minus recorded operating costs.')}>
                {d.margin.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[420px] text-sm">
                      <thead className="text-xs text-muted-foreground uppercase">
                        <tr>
                          <th scope="col" className="py-1.5 text-left font-medium">{t('Currency')}</th>
                          <th scope="col" className="py-1.5 text-right font-medium">{t('Revenue')}</th>
                          <th scope="col" className="py-1.5 text-right font-medium">{t('Operating cost')}</th>
                          <th scope="col" className="py-1.5 text-right font-medium">{t('Margin')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.margin.map((m) => (
                          <tr key={m.currency} className="border-t">
                            <td className="py-1.5">{m.currency}</td>
                            <td className="py-1.5 text-right"><Money minor={m.revenueMinor} currency={m.currency} /></td>
                            <td className="py-1.5 text-right"><Money minor={m.costMinor} currency={m.currency} /></td>
                            <td className="py-1.5 text-right font-medium"><Money minor={m.marginMinor} currency={m.currency} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{t('No revenue this month yet.')}</p>
                )}
              </Section>
            )}
          </>
        )}
      </QueryView>
    </PricingShell>
  );
}
