import { useMutation, useQuery } from '@tanstack/react-query';
import { DEFAULT_SPEED_LIMIT_KPH, type DeviceDto, type LiveObject } from '@veetracer/shared';
import { CrosshairIcon, HistoryIcon, LocateFixedIcon, LocateIcon, WrenchIcon, XIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Link } from 'react-router';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatDuration, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CommandsTab } from './CommandsTab';
import { DriverControl } from './DriverControl';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium break-words">{children ?? '—'}</dd>
    </div>
  );
}

function orDash(v: string | number | null | undefined, suffix = ''): string {
  return v === null || v === undefined ? '—' : `${v}${suffix}`;
}

const GSM_LABELS = ['No signal', 'Weak', 'Fair', 'Good', 'Excellent'];

function Overview({ o, now }: { o: LiveObject; now: number }) {
  const { t } = useTranslation();
  const since = o.statusSince ? formatDuration((now - Date.parse(o.statusSince)) / 1000) : null;
  const limit = o.speedLimitKph ?? (o.vehicleType ? DEFAULT_SPEED_LIMIT_KPH[o.vehicleType] : null);
  return (
    <dl className="divide-y">
      <Row label={t('Status')}>
        <span className="flex flex-col items-end gap-1">
          <StatusBadge status={o.status} />
          {since && <span className="text-xs font-normal text-muted-foreground">{t('for {{duration}}', { duration: since })}</span>}
        </span>
      </Row>
      {o.type === 'VEHICLE' && <DriverControl o={o} />}
      <Row label={t('Speed')}>{`${Math.round(o.speedKph)} km/h`}</Row>
      <Row label={t('Ignition')}>{o.ignition === null ? '—' : o.ignition ? t('On') : t('Off')}</Row>
      <Row label={t('Coordinates')}>
        {o.lat !== null && o.lng !== null ? <span className="font-mono text-xs">{`${o.lat.toFixed(6)}, ${o.lng.toFixed(6)}`}</span> : '—'}
      </Row>
      <Row label={t('Heading')}>{o.lat !== null ? `${Math.round(o.course)}°` : '—'}</Row>
      <Row label={t('Last fix')}>
        <span className="flex flex-col items-end">
          {formatDateTime(o.fixTime)}
          <span className="text-xs font-normal text-muted-foreground">{relativeTime(o.fixTime, now)}</span>
        </span>
      </Row>
      <Row label={t('Server time')}>{formatDateTime(o.serverTime)}</Row>
      <Row label={t('Battery')}>{orDash(o.batteryLevel, '%')}</Row>
      <Row label={t('GSM signal')}>{o.gsmSignal === null ? '—' : t(GSM_LABELS[o.gsmSignal] ?? String(o.gsmSignal))}</Row>
      <Row label={t('External voltage')}>{orDash(o.extVoltage, ' V')}</Row>
      <Row label={t('Satellites')}>{orDash(o.satellites)}</Row>
      <Row label={t('Speed limit')}>{limit === null ? '—' : o.speedLimitKph === null ? t('{{limit}} km/h (default)', { limit }) : `${limit} km/h`}</Row>
    </dl>
  );
}

function DeviceTab({ o }: { o: LiveObject }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const allowed = can('devices') && !!o.deviceId;
  const device = useQuery({
    queryKey: ['device', o.deviceId],
    queryFn: ({ signal }) => api.get<DeviceDto>(`/devices/${o.deviceId}`, undefined, signal),
    enabled: allowed,
    staleTime: 5 * 60_000,
  });
  if (!o.deviceId) return <p className="py-6 text-center text-sm text-muted-foreground">{t('No device is assigned to this object.')}</p>;
  const d = device.data;
  const pending = allowed && device.isPending;
  const value = (v: string | null | undefined) => (pending ? <Skeleton className="ml-auto h-4 w-24" /> : orDash(v));
  return (
    <dl className="divide-y">
      <Row label={t('IMEI / ID')}>
        <span className="font-mono text-xs">{o.uniqueId}</span>
      </Row>
      <Row label={t('Model')}>{value(d?.modelName)}</Row>
      <Row label={t('Protocol')}>{value(d?.protocol)}</Row>
      <Row label={t('SIM number')}>{value(d?.simNumber)}</Row>
      <Row label={t('SIM operator')}>{value(d?.simOperator)}</Row>
      <Row label={t('Firmware')}>{value(d?.firmware)}</Row>
      {!can('devices') && <p className="pt-3 text-xs text-muted-foreground">{t('Device details require access to the Devices master.')}</p>}
    </dl>
  );
}

/** Put the vehicle in / out of maintenance (alerts are suppressed while in maintenance). */
function MaintenanceControl({ objectId, inMaintenance, onChange }: { objectId: string; inMaintenance: boolean; onChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.post(`/objects/${objectId}/maintenance`, { enabled, ...(enabled && note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: (_r, enabled) => {
      onChange(enabled);
      setOpen(false);
      setNote('');
      toast.success(enabled ? t('Vehicle is in maintenance: alerts are paused') : t('Maintenance ended: alerts resume'));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (inMaintenance) {
    return (
      <Button size="sm" variant="outline" onClick={() => save.mutate(false)} disabled={save.isPending}>
        {save.isPending ? <Spinner /> : <WrenchIcon />} {t('End maintenance')}
      </Button>
    );
  }
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <WrenchIcon /> {t('Maintenance')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('Put in maintenance')}</DialogTitle>
            <DialogDescription>{t('No alerts are raised while the vehicle is in maintenance, and it is listed separately on the criticality board.')}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field label={t('Note (optional)')} htmlFor="maint-note">
              <Input id="maint-note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder={t('e.g. At ABC Motors for service')} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button onClick={() => save.mutate(true)} disabled={save.isPending}>
              {save.isPending && <Spinner />} {t('Start maintenance')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ObjectDrawer({
  object,
  now,
  following,
  onFollowChange,
  onZoomTo,
  onClose,
  className,
}: {
  object: LiveObject;
  now: number;
  following: boolean;
  onFollowChange: (follow: boolean) => void;
  onZoomTo: () => void;
  onClose: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const hasCoords = object.lat !== null;
  const { can } = useAuth();
  const [maintenance, setMaintenance] = useState<{ id: string; value: boolean } | null>(null);
  const inMaintenance = maintenance?.id === object.objectId ? maintenance.value : !!object.inMaintenance;
  const canCommand = can('live_map', 'command') && !!object.deviceId;
  return (
    <aside
      aria-label={t('Object details')}
      className={cn('flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card shadow-xl animate-slide-in-right', className)}
    >
      <div className="flex items-start gap-3 border-b p-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{object.name}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {[object.plateNumber, object.vehicleType ?? object.type].filter(Boolean).join(' · ')}
          </p>
          {inMaintenance && (
            <Badge variant="warning" className="mt-1.5">
              <WrenchIcon className="size-3" /> {t('In maintenance · alerts paused')}
            </Badge>
          )}
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('Close details')}>
          <XIcon />
        </Button>
      </div>
      <div className="flex flex-wrap gap-2 border-b px-4 py-3">
        <Button size="sm" variant={following ? 'default' : 'outline'} disabled={!hasCoords} onClick={() => onFollowChange(!following)} aria-pressed={following}>
          {following ? <LocateFixedIcon /> : <LocateIcon />}
          {following ? t('Following') : t('Follow')}
        </Button>
        <Button size="sm" variant="outline" disabled={!hasCoords} onClick={onZoomTo}>
          <CrosshairIcon /> {t('Zoom to')}
        </Button>
        {can('history') && (
          <Button size="sm" variant="outline" asChild>
            <Link to={`/history?objectId=${encodeURIComponent(object.objectId)}`}>
              <HistoryIcon /> {t('History')}
            </Link>
          </Button>
        )}
        {can('objects', 'edit') && <MaintenanceControl objectId={object.objectId} inMaintenance={inMaintenance} onChange={(value) => setMaintenance({ id: object.objectId, value })} />}
      </div>
      <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-4 mt-3 w-[calc(100%-2rem)]">
          <TabsTrigger value="overview">{t('Overview')}</TabsTrigger>
          <TabsTrigger value="device">{t('Device')}</TabsTrigger>
          {canCommand && <TabsTrigger value="commands">{t('Commands')}</TabsTrigger>}
        </TabsList>
        <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <Overview o={object} now={now} />
        </TabsContent>
        <TabsContent value="device" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <DeviceTab o={object} />
        </TabsContent>
        {canCommand && (
          <TabsContent value="commands" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            <CommandsTab object={object} />
          </TabsContent>
        )}
      </Tabs>
    </aside>
  );
}
