import { IndianRupeeIcon, MessageSquareIcon, ReceiptTextIcon, WaypointsIcon } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { InvoicingSettings } from './InvoicingSettings';
import { MessagingSettings } from './MessagingSettings';
import { PricingSettings } from './PricingSettings';
import { RoutingSwitchPanel } from '@/features/platform/routing-switch/RoutingSwitchPanel';

/**
 * Platform → Platform Settings (Super Admin): licence pricing, invoicing (supplier) details, messaging channels (SMS /
 * e-mail / Arattai / WhatsApp), and (v1.16) the automatic route planning switch with its readiness checklist.
 */
export function PlatformSettingsPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const tab = params.get('tab');
  return (
    <div className="w-full space-y-6 p-4 sm:p-6">
      <PageHeader title={t('Platform Settings')} description={t('Licence prices, GST, the supplier details printed on invoices, and the messaging channels.')} />
      <Tabs defaultValue={tab === 'messaging' || tab === 'routing' ? tab : 'pricing'}>
        <TabsList>
          <TabsTrigger value="pricing">
            <IndianRupeeIcon className="size-4" />
            {t('Licence pricing')}
          </TabsTrigger>
          <TabsTrigger value="invoicing">
            <ReceiptTextIcon className="size-4" />
            {t('Invoicing')}
          </TabsTrigger>
          <TabsTrigger value="messaging">
            <MessageSquareIcon className="size-4" />
            {t('Messaging')}
          </TabsTrigger>
          <TabsTrigger value="routing">
            <WaypointsIcon className="size-4" />
            {t('Route planning')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="pricing" className="mt-4">
          <PricingSettings />
        </TabsContent>
        <TabsContent value="invoicing" className="mt-4">
          <InvoicingSettings />
        </TabsContent>
        <TabsContent value="messaging" className="mt-4">
          <MessagingSettings />
        </TabsContent>
        <TabsContent value="routing" className="mt-4">
          <RoutingSwitchPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
