import { useQuery } from '@tanstack/react-query';
import type { DeviceDto, RawPacketDto } from '@veetracer/shared';
import { CopyIcon, RefreshCwIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

/** Hex grouped in bytes for reading (`78 78 22 22 …`). */
const spaced = (hex: string) => hex.replace(/(..)(?=.)/g, '$1 ');

/** Latest raw frames of a device (support: checking what a tracker actually sends). */
export function RawPacketsSheet({ device, onClose }: { device: DeviceDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const raw = useQuery({
    queryKey: ['device-raw', device?.id],
    queryFn: ({ signal }) => api.get<RawPacketDto[]>(`/devices/${device!.id}/raw`, { limit: 200 }, signal),
    enabled: !!device,
  });
  const copyAll = async () => {
    const text = (raw.data ?? []).map((r) => `${r.receivedAt}\t${r.protocol}\t${r.hex}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('Copied {{n}} frames', { n: raw.data?.length ?? 0 }));
    } catch {
      toast.error(t('Could not copy to the clipboard'));
    }
  };
  return (
    <Sheet open={!!device} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{t('Raw data')} · {device?.uniqueId}</SheetTitle>
          <SheetDescription>{t('Latest position frames received from this tracker, newest first (kept for 7 days).')}</SheetDescription>
        </SheetHeader>
        <div className="flex gap-2 px-4">
          <Button size="sm" variant="outline" onClick={() => raw.refetch()} disabled={raw.isFetching}>
            <RefreshCwIcon /> {t('Refresh')}
          </Button>
          <Button size="sm" variant="outline" onClick={copyAll} disabled={!raw.data?.length}>
            <CopyIcon /> {t('Copy all')}
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
          {raw.isLoading && <Skeleton className="h-40" />}
          {raw.isError && <p className="text-sm text-destructive">{errorMessage(raw.error)}</p>}
          {raw.data?.length === 0 && <p className="text-sm text-muted-foreground">{t('No frames stored for this device in the last 7 days.')}</p>}
          {raw.data?.map((r) => (
            <div key={r.id} className="rounded-lg border p-2.5">
              <p className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                <span className="tabular-nums">{formatDateTime(r.receivedAt)}</span>
                <span>
                  {r.protocol} · {t('{{n}} bytes', { n: r.length })}{r.remoteAddress ? ` · ${r.remoteAddress}` : ''}
                </span>
              </p>
              <p className="mt-1 font-mono text-xs break-all">{spaced(r.hex)}</p>
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
