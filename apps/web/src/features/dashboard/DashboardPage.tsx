import { ArrowRightIcon, ChartColumnIcon, HeartPulseIcon, LayoutDashboardIcon, MapIcon, TriangleAlertIcon } from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { PageCapture } from '@/components/page-capture';
import { Breadcrumb, PageHeader } from '@/components/page-header';
import { isEnabled } from '@/lib/flags';
import { useQueryUpdatedAt } from './refresh/use-updated-at';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/features/auth/auth-context';
import { CompareTab } from './CompareTab';
import { CriticalityTab, DeviceHealthTab } from './HealthTabs';
import { OverviewTab } from './OverviewTab';

const TABS = [
  { value: 'overview', label: 'Overview', description: 'Fleet status right now and today’s activity. Updates automatically.' },
  { value: 'criticality', label: 'Criticality', description: 'Vehicles that need attention: inactive, no GPS, wrong time zone or never connected.' },
  { value: 'health', label: 'Device health', description: 'Inactivity, today’s movement and device battery across the fleet.' },
  { value: 'compare', label: 'Compare', description: 'Compare trips, distance, idling and alerts across vehicles for any period.' },
] as const;
type TabValue = (typeof TABS)[number]['value'];
const TAB_ICON: Record<TabValue, typeof MapIcon> = { overview: LayoutDashboardIcon, criticality: TriangleAlertIcon, health: HeartPulseIcon, compare: ChartColumnIcon };

/** "Updated 12:06" from the overview query's dataUpdatedAt (read from the cache; adds no request). */
function UpdatedChip() {
  const { t, i18n } = useTranslation();
  const at = useQueryUpdatedAt('dashboard-overview');
  if (!at) return null;
  const time = new Date(at).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-0.5 text-xs text-muted-foreground" title={new Date(at).toLocaleString(i18n.language)}>
      <span className="size-1.5 rounded-full bg-[var(--success)]" aria-hidden />
      {t('Updated {{time}}', { time })}
    </span>
  );
}

export function DashboardPage() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const pageRef = useRef<HTMLDivElement>(null);
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((x) => x.value === params.get('tab'))?.value ?? 'overview') as TabValue;
  const description = TABS.find((x) => x.value === tab)?.description;
  const tabLabel = TABS.find((x) => x.value === tab)?.label ?? 'Overview';
  const setTab = (v: string) =>
    setParams(
      (p) => {
        if (v === 'overview') p.delete('tab');
        else p.set('tab', v);
        return p;
      },
      { replace: true },
    );

  const capture = (
    <PageCapture
      target={pageRef}
      fileName={() => `dashboard-${tab}-${new Date().toISOString().slice(0, 10)}`}
      caption={() => ({ title: me?.company.name ?? '', lines: [`${t('Dashboard')} · ${t(tabLabel)}`, description && t(description)] })}
    />
  );

  if (isEnabled('uiRefresh')) {
    return (
      <div ref={pageRef} className="w-full space-y-4 p-4 sm:space-y-5 sm:p-6">
        <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0 space-y-1">
            <Breadcrumb title={t('Dashboard')} />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-xl font-bold tracking-tight sm:text-[26px] sm:leading-8">{t('Dashboard')}</h1>
              {tab === 'overview' && <UpdatedChip />}
            </div>
            {description && <p className="text-sm text-muted-foreground">{t(description)}</p>}
          </div>
          {/* Actions grouped; the group is left out of the saved picture like the buttons were before. */}
          <div role="group" aria-label={t('Dashboard actions')} data-capture-skip="" className="flex flex-wrap items-center gap-2 [&>*]:flex-1 sm:[&>*]:flex-none">
            {capture}
            {can('live_map') && (
              <Button asChild data-capture-skip="">
                <Link to="/live">
                  <MapIcon /> {t('Open live map')} <ArrowRightIcon />
                </Link>
              </Button>
            )}
          </div>
        </header>
        <Tabs value={tab} onValueChange={setTab}>
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <TabsList className="h-auto w-max justify-start gap-1 rounded-xl border bg-card p-1 shadow-xs">
              {TABS.map((x) => {
                const Icon = TAB_ICON[x.value];
                return (
                  <TabsTrigger key={x.value} value={x.value} className="h-9 flex-none rounded-lg px-3 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm">
                    <Icon aria-hidden /> {t(x.label)}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </div>
          <TabsContent value="overview" className="pt-4">
            <OverviewTab />
          </TabsContent>
          <TabsContent value="criticality" className="pt-4">
            <CriticalityTab />
          </TabsContent>
          <TabsContent value="health" className="pt-4">
            <DeviceHealthTab />
          </TabsContent>
          <TabsContent value="compare" className="pt-4">
            <CompareTab />
          </TabsContent>
        </Tabs>
      </div>
    );
  }

  return (
    <div ref={pageRef} className="w-full space-y-5 p-4 sm:p-6">
      <PageHeader
        title={t('Dashboard')}
        description={description && t(description)}
        actions={
          <>
            {/* PNG / PDF of the dashboard with the VeeTrax · company header (the buttons are left out). */}
            <PageCapture
              target={pageRef}
              fileName={() => `dashboard-${tab}-${new Date().toISOString().slice(0, 10)}`}
              caption={() => ({ title: me?.company.name ?? '', lines: [`${t('Dashboard')} · ${t(tabLabel)}`, description && t(description)] })}
            />
            {can('live_map') && (
              <Button asChild data-capture-skip="">
                <Link to="/live">
                  <MapIcon /> {t('Open live map')} <ArrowRightIcon />
                </Link>
              </Button>
            )}
          </>
        }
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
          {TABS.map((x) => (
            <TabsTrigger key={x.value} value={x.value}>
              {t(x.label)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview" className="pt-4">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="criticality" className="pt-4">
          <CriticalityTab />
        </TabsContent>
        <TabsContent value="health" className="pt-4">
          <DeviceHealthTab />
        </TabsContent>
        <TabsContent value="compare" className="pt-4">
          <CompareTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
