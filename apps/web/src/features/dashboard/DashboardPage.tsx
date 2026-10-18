import { ArrowRightIcon, MapIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { PageHeader } from '@/components/page-header';
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

export function DashboardPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((x) => x.value === params.get('tab'))?.value ?? 'overview') as TabValue;
  const description = TABS.find((x) => x.value === tab)?.description;
  const setTab = (v: string) =>
    setParams(
      (p) => {
        if (v === 'overview') p.delete('tab');
        else p.set('tab', v);
        return p;
      },
      { replace: true },
    );

  return (
    <div className="w-full space-y-5 p-4 sm:p-6">
      <PageHeader
        title={t('Dashboard')}
        description={description && t(description)}
        actions={
          can('live_map') && (
            <Button asChild>
              <Link to="/live">
                <MapIcon /> {t('Open live map')} <ArrowRightIcon />
              </Link>
            </Button>
          )
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
