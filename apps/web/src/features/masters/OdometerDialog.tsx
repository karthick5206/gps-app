import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeviceDto, DeviceOdometerDto } from '@veetracer/shared';
import { GaugeIcon, RotateCcwIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';
import { formatNumber } from '@/lib/format';

const km = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${formatNumber(Math.round(v * 10) / 10)} km`);

/** Devices → row menu → Odometer: set or reset the odometer of the vehicle the device is fitted to (web only). */
export function useOdometerAction() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [device, setDevice] = useState<DeviceDto | null>(null);
  return {
    item: (r: DeviceDto) =>
      can('devices', 'edit') && r.object ? (
        <DropdownMenuItem onSelect={() => setDevice(r)}>
          <GaugeIcon /> {t('Odometer')}
        </DropdownMenuItem>
      ) : null,
    dialog: device ? <OdometerDialog device={device} onClose={() => setDevice(null)} /> : null,
  };
}

function OdometerDialog({ device, onClose }: { device: DeviceDto; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const current = useQuery({ queryKey: ['device-odometer', device.id], queryFn: ({ signal }) => api.get<DeviceOdometerDto>(`/devices/${device.id}/odometer`, undefined, signal) });
  const [value, setValue] = useState('0');
  const [note, setNote] = useState('');
  const v = Number(value);
  const valid = value.trim() !== '' && Number.isFinite(v) && v >= 0 && v <= 10_000_000;
  const save = useMutation({
    mutationFn: () => api.post<DeviceOdometerDto>(`/devices/${device.id}/odometer`, { valueKm: v, ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: (r) => {
      qc.setQueryData(['device-odometer', device.id], r);
      void qc.invalidateQueries({ queryKey: ['live-day-stats'] });
      toast.success(t('Odometer set to {{km}}', { km: km(r.odometerKm) }));
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const d = current.data;
  const delta = d?.odometerKm != null && valid ? v - d.odometerKm : 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Odometer: {{name}}', { name: device.object?.name ?? device.uniqueId })}</DialogTitle>
          <DialogDescription>{t('Set the reading shown for this vehicle, for example 0 after a reset or the reading on its dashboard. Distance keeps adding from that value.')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {current.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">{t('Current odometer')}</div>
                <div className="text-lg font-semibold tabular-nums">{km(d?.odometerKm)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{t('Recorded by VeeTrax')}</div>
                <div className="tabular-nums">{km(d?.recordedKm)}</div>
              </div>
            </div>
          )}
          <div className="flex items-end gap-2">
            <Field label={t('New odometer (km)')} htmlFor="odo-value" className="flex-1">
              <Input id="odo-value" type="number" inputMode="decimal" min={0} step="0.1" value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
            <Button type="button" variant="outline" onClick={() => setValue('0')}>
              <RotateCcwIcon /> {t('Reset to 0')}
            </Button>
          </div>
          <Field label={t('Reason (optional)')} htmlFor="odo-note">
            <Input id="odo-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={t('e.g. Odometer replaced at service')} />
          </Field>
          {!!d?.remindersByOdometer && delta !== 0 && (
            <p className="rounded-md bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300">
              {t('{{n}} service reminder(s) due by odometer will move by {{km}}, so they stay the same distance away.', { n: d.remindersByOdometer, km: km(delta) })}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button onClick={() => save.mutate()} disabled={!valid || save.isPending || current.isPending}>
            {save.isPending && <Spinner />} {t('Save odometer')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
