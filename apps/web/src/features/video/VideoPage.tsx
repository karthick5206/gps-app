import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/page-header';
import { Combobox } from '@/components/ui/multi-select';
import { useVehicleOptions } from '@/features/history/use-history';
import { VideoPanel } from './VideoPanel';

/**
 * Dashcam video page: `/video?objectId=…&channel=…&at=…` (`at` = alert time → recordings ± 2 min). Also the page the
 * mobile app opens in the browser.
 */
export function VideoPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const vehicles = useVehicleOptions(search);
  const objectId = params.get('objectId');
  const channel = Number(params.get('channel')) || undefined;
  const at = params.get('at') ?? undefined;
  const vehicle = vehicles.options.find((o) => o.value === objectId)?.label ?? '';

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader title={t('Video')} description={t('Live and recorded video from dashcams.')} />
      <Combobox
        value={objectId}
        onChange={(id) => {
          const next = new URLSearchParams();
          if (id) next.set('objectId', id);
          setParams(next, { replace: true });
        }}
        options={vehicles.options}
        loading={vehicles.loading}
        onSearch={vehicles.remoteSearch ? setSearch : undefined}
        placeholder={t('Select a vehicle…')}
        searchPlaceholder={t('Search name or plate…')}
        emptyText={t('No vehicles found')}
        clearable={false}
        className="w-full sm:w-72"
        id="video-vehicle"
      />
      {objectId ? (
        <VideoPanel key={`${objectId}-${at ?? ''}`} objectId={objectId} vehicle={vehicle} initialChannel={channel} initialAt={at} large className="max-w-6xl" />
      ) : (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('Select a vehicle with a dashcam to watch its video.')}</p>
      )}
    </div>
  );
}
