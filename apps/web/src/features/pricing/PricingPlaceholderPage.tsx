import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/page-header';

/**
 * Doc 19 Pricing & billing: every pricing menu needs a route (router PAGES is keyed by MenuKey). The backend ships first
 * behind the `pricing` add-on (off by default); the real screens replace this placeholder.
 */
export function PricingPlaceholderPage() {
  const { t } = useTranslation();
  return (
    <div className="flex w-full min-w-0 flex-col gap-4 p-4 sm:p-6">
      <PageHeader title={t('Pricing & billing')} />
      <p className="text-sm text-muted-foreground">{t('This area is being prepared.')}</p>
    </div>
  );
}
