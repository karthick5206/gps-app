import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DRIVER_EVENT_LIMITS, type DriverEventSettings } from '@veetracer/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { formatBytes } from '@/features/video/video-utils';
import { api, errorMessage } from '@/lib/api';

type Resp = { settings: DriverEventSettings; usedBytes: number };
type NumKey = Exclude<keyof DriverEventSettings, 'snapshot'>;

/** Company settings for driver events: camera channels, photos per event, retention and storage quota. */
export function DriverEventSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['driver-events', 'settings'], queryFn: ({ signal }) => api.get<Resp>('/driver-events/settings', undefined, signal), enabled: open });
  const [form, setForm] = useState<DriverEventSettings | null>(null);
  useEffect(() => {
    if (open && query.data) setForm(query.data.settings);
  }, [open, query.data]);
  const save = useMutation({
    mutationFn: (s: DriverEventSettings) => api.put<Resp>('/driver-events/settings', s),
    onSuccess: (r) => {
      qc.setQueryData(['driver-events', 'settings'], r);
      toast.success(t('Driver event settings saved'));
      onOpenChange(false);
    },
  });
  const L = DRIVER_EVENT_LIMITS;
  const num = (key: NumKey, label: string, [min, max]: readonly [number, number], hint?: string) => (
    <Field label={label} htmlFor={`de-${key}`} hint={hint ?? `${min}–${max}`}>
      <Input
        id={`de-${key}`}
        type="number"
        min={min}
        max={max}
        value={form?.[key] ?? ''}
        onChange={(e) => form && setForm({ ...form, [key]: Math.round(Number(e.target.value)) })}
      />
    </Field>
  );
  const valid =
    !!form &&
    (Object.entries({ cabinChannel: L.channel, roadChannel: L.channel, maxPhotos: L.maxPhotos, retentionDays: L.retentionDays, quotaMb: L.quotaMb }) as [NumKey, readonly [number, number]][]).every(
      ([k, [min, max]]) => Number.isInteger(form[k]) && form[k] >= min && form[k] <= max,
    );

  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Driver event settings')}</DialogTitle>
          <DialogDescription>{t('Snapshots are requested from the dashcam when an ADAS / DMS or crash alert is raised.')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {query.isError && <FormError message={errorMessage(query.error)} />}
          {save.isError && <FormError message={errorMessage(save.error)} />}
          {!form ? (
            <Spinner />
          ) : (
            <>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>{t('Take a snapshot when an event is raised')}</span>
                <Switch checked={form.snapshot} onCheckedChange={(v) => setForm({ ...form, snapshot: v })} />
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                {num('cabinChannel', t('Cabin camera channel'), L.channel, t('Driver-facing camera (fatigue, phone, smoking…)'))}
                {num('roadChannel', t('Road camera channel'), L.channel, t('Road-facing camera (collision, lane, tailgating, crash)'))}
                {num('maxPhotos', t('Photos per event'), L.maxPhotos)}
                {num('retentionDays', t('Keep events for (days)'), L.retentionDays)}
                {num('quotaMb', t('Storage quota (MB)'), L.quotaMb, query.data ? t('Used: {{used}}', { used: formatBytes(query.data.usedBytes) }) : undefined)}
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            {t('Cancel')}
          </Button>
          <Button onClick={() => form && save.mutate(form)} disabled={!valid || save.isPending}>
            {save.isPending && <Spinner />}
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
