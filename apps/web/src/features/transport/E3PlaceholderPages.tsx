import { HourglassIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/page-header';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * Placeholders for the E3 menus (etms_schedules, etms_bookings, etms_dispatch) so every menu has a route while the E3
 * web screens (12 WP 3.5) are built against the contract in packages/shared/src/transport-trips.ts. The web agent
 * replaces these with the real pages.
 */
function Placeholder({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex w-full min-w-0 flex-col gap-4 p-4 sm:p-6">
      <PageHeader title={t(title)} />
      <Card className="py-0">
        <EmptyState icon={HourglassIcon} title={t('Coming soon')} description={t('This part of employee transport is still being rolled out.')} />
      </Card>
    </div>
  );
}

export function SchedulesPlaceholderPage() {
  return <Placeholder title="Shifts & schedules" />;
}

export function BookingsPlaceholderPage() {
  return <Placeholder title="Bookings" />;
}

export function DispatchPlaceholderPage() {
  return <Placeholder title="Dispatch" />;
}
