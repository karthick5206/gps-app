import { SmartphoneIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * `etms_self` (My commute) and `etms_driver` (My transport duty) are mobile-first (docs 08, 09); the web "My transport"
 * page is E3 WP 3.6. Until then the route exists (every menu has one) and says where to go, instead of a 404 or an empty
 * page: a passenger or driver who signs in on the web lands here (HomeRedirect picks their only menu).
 */
function MobileAppOnly({ title, text }: { title: string; text: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex w-full min-w-0 flex-col gap-4 p-4 sm:p-6">
      <PageHeader title={t(title)} />
      <Card className="py-0">
        <EmptyState
          icon={SmartphoneIcon}
          title={t('Available in the VeeTrax mobile app')}
          description={t(text)}
          action={
            <Button asChild>
              <Link to="/download">{t('Get the app')}</Link>
            </Button>
          }
        />
      </Card>
    </div>
  );
}

export function MyCommutePage() {
  return <MobileAppOnly title="My commute" text="Your pickups, trips and the vehicle on its way will be shown in the mobile app, with the same account. This part of employee transport is still being rolled out." />;
}

export function MyTransportDutyPage() {
  return <MobileAppOnly title="My transport duty" text="Your assigned transport trips and passenger lists will be shown in the mobile app, with the same account. This part of employee transport is still being rolled out." />;
}
