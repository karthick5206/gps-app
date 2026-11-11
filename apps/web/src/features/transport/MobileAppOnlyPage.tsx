import { SmartphoneIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * `etms_driver` (My transport duty) is mobile-first (doc 09). The route exists (every menu has one) and says where to
 * go, instead of a 404 or an empty page: a driver who signs in on the web lands here (HomeRedirect picks their only
 * menu). `etms_self` (My commute) has its own web page since E3 WP 3.6 (dispatch/MyTransportPage).
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

export function MyTransportDutyPage() {
  return <MobileAppOnly title="My transport duty" text="Your assigned transport trips and passenger lists will be shown in the mobile app, with the same account. This part of employee transport is still being rolled out." />;
}
