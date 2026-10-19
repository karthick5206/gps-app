import { IndianRupeeIcon, ReceiptTextIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { InvoicingSettings } from './InvoicingSettings';
import { PricingSettings } from './PricingSettings';

/** Platform → Platform Settings (Super Admin): licence pricing and invoicing (supplier) details. */
export function PlatformSettingsPage() {
  const { t } = useTranslation();
  return (
    <div className="w-full space-y-6 p-4 sm:p-6">
      <PageHeader title={t('Platform Settings')} description={t('Licence prices, GST and the supplier details printed on invoices.')} />
      <Tabs defaultValue="pricing">
        <TabsList>
          <TabsTrigger value="pricing">
            <IndianRupeeIcon className="size-4" />
            {t('Licence pricing')}
          </TabsTrigger>
          <TabsTrigger value="invoicing">
            <ReceiptTextIcon className="size-4" />
            {t('Invoicing')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="pricing" className="mt-4">
          <PricingSettings />
        </TabsContent>
        <TabsContent value="invoicing" className="mt-4">
          <InvoicingSettings />
        </TabsContent>
      </Tabs>
    </div>
  );
}
