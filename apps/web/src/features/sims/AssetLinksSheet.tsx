import { useQuery } from '@tanstack/react-query';
import type { AssetLinksDto } from '@veetracer/shared';
import { CardSimIcon, CpuIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { daysLeft, renewalText } from '@/features/inventory/inventory-format';
import { InfoRow } from '@/features/inventory/shared';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { SimStatusBadge } from './sim-shared';

export interface AssetLinksTarget {
  objectId: string;
  label: string;
}

/**
 * Customer portal, read-only: the device(s) fitted to one of the company's own vehicles, their licence status and
 * (when the platform enables it, QI-21) the managed SIM's number, status and renewal date. No cost data.
 */
export function AssetLinksSheet({ target, onClose }: { target: AssetLinksTarget | null; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['asset-links', target?.objectId], queryFn: () => api.get<AssetLinksDto>(`/asset-links/objects/${target!.objectId}`), enabled: !!target });
  const d = q.data;
  return (
    <Sheet open={!!target} onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{t('Devices & SIMs')}</SheetTitle>
          <SheetDescription>{target?.label}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {q.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : q.isError ? (
            <p className="text-sm text-destructive-fg">{t('Could not load the devices of this vehicle.')}</p>
          ) : !d?.devices.length ? (
            <EmptyState icon={CpuIcon} title={t('No device fitted')} description={t('Fit a device on the vehicle form.')} />
          ) : (
            d.devices.map((dev) => (
              <section key={dev.deviceId} className="rounded-xl border p-4">
                <div className="mb-2 flex items-center gap-2">
                  <CpuIcon className="size-4 text-muted-foreground" />
                  <span className="font-mono text-sm font-medium">{dev.uniqueId}</span>
                  <span className="text-xs text-muted-foreground">{dev.modelName}</span>
                </div>
                <dl className="divide-y">
                  <InfoRow label="Fitted since">{dev.fittedAt ? formatDateTime(dev.fittedAt) : '—'}</InfoRow>
                  <InfoRow label="Licence">
                    <span className="inline-flex items-center gap-2">
                      <Badge variant={dev.licence.status === 'ACTIVE' ? 'success' : dev.licence.status === 'EXPIRED' ? 'destructive' : 'warning'}>
                        {dev.licence.status === 'ACTIVE' ? t('Licensed') : dev.licence.status === 'EXPIRED' ? t('Expired') : t('No seat')}
                      </Badge>
                      {dev.licence.expiresAt && <span className="text-xs text-muted-foreground">{t('until {{d}}', { d: dev.licence.expiresAt.slice(0, 10) })}</span>}
                    </span>
                  </InfoRow>
                  <InfoRow label="SIM number">{dev.simNumber ?? '—'}</InfoRow>
                </dl>
                {d.simVisible && (
                  <div className="mt-3 rounded-lg bg-muted/50 p-3">
                    <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase">
                      <CardSimIcon className="size-3.5" /> {t('Managed SIM')}
                    </p>
                    {dev.sim ? (
                      <dl>
                        <InfoRow label="Mobile no.">{dev.sim.msisdn ? `+${dev.sim.msisdn}` : '—'}</InfoRow>
                        <InfoRow label="Status">
                          <SimStatusBadge status={dev.sim.status} />
                        </InfoRow>
                        <InfoRow label="Renewal due">
                          {dev.sim.renewalDueAt ?? '—'} <span className="text-xs text-muted-foreground">{dev.sim.renewalDueAt ? t(renewalText(daysLeft(dev.sim.renewalDueAt))) : ''}</span>
                        </InfoRow>
                      </dl>
                    ) : (
                      <p className="text-sm text-muted-foreground">{t('No managed SIM recorded for this device.')}</p>
                    )}
                  </div>
                )}
              </section>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
