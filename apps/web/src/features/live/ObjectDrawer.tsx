import { useMutation, useQuery } from '@tanstack/react-query';
import { DEFAULT_SPEED_LIMIT_KPH, displayStatus, displayStatusLabel, personActivity, type DeviceDto, type LiveObject } from '@veetracer/shared';
import { CrosshairIcon, HistoryIcon, LocateFixedIcon, LocateIcon, LockIcon, WrenchIcon, XIcon } from 'lucide-react';
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
import { useAddress } from '@/features/geocoding/use-address';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatDuration, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CompliancePanel } from '@/features/documents/CompliancePanel';
import { CommandsTab } from './CommandsTab';
import { DriverControl } from './DriverControl';
import { useVideoChannels, VideoPanel } from '@/features/video/VideoPanel';
import { RecentDriverEvents } from '@/features/driver-events/AlertSnapshot';
import { ignitionText, TodayCard, useDayStats } from './day-stats';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium break-words">{children ?? '—'}</dd>
    </div>
  );
}

function AddressRow({ lat, lng }: { lat: number | null; lng: number | null }) {
  const { t } = useTranslation();
  const { address, loading } = useAddress(lat, lng);
  if (!loading && !address) return null;
  return <Row label={t('Address')}>{loading ? <Skeleton className="ml-auto h-4 w-40" /> : <span className="font-normal">{address}</span>}</Row>;
}

function orDash(v: string | number | null | undefined, suffix = ''): string {
  return v === null || v === undefined ? '—' : `${v}${suffix}`;
}

const GSM_LABELS = ['No signal', 'Weak', 'Fair', 'Good', 'Excellent'];

function Overview({ o, now }: { o: LiveObject; now: number }) {
  const { t } = useTranslation();
  const activity = personActivity(o);
  const since = !activity && o.statusSince ? formatDuration((now - Date.parse(o.statusSince)) / 1000) : null;
  const limit = o.speedLimitKph ?? (o.vehicleType ? DEFAULT_SPEED_LIMIT_KPH[o.vehicleType] : null);
  const dayStats = useDayStats(!o.licenceLocked);
  return (
    <>
    {!o.licenceLocked && <TodayCard s={dayStats.data?.[o.objectId]} loading={dayStats.isPending} />}
    <dl className="divide-y">
      <Row label={t('Status')}>
        <span className="flex flex-col items-end gap-1">
          <StatusBadge status={displayStatus(o)} label={activity ? displayStatusLabel(o) : undefined} />
          {since && <span className="text-xs font-normal text-muted-foreground">{t('for {{duration}}', { duration: since })}</span>}
        </span>
      </Row>
      {o.type === 'VEHICLE' && <DriverControl o={o} />}
      <Row label={t('Speed')}>{`${Math.round(o.speedKph)} km/h`}</Row>
      <Row label={t('Ignition')}>{ignitionText(o, now, t) ?? '—'}</Row>
      <AddressRow lat={o.lat} lng={o.lng} />
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
      {o.fuelL != null && (
        <Row label={t('Fuel')}>
          <span className="flex items-center gap-2 tabular-nums">
            {`${o.fuelL.toFixed(1)} L`}
            {o.fuelPct != null && (
              <span className="inline-flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
                <span className="h-1.5 w-12 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <span className={`block h-full rounded-full ${o.fuelPct < 15 ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${Math.min(100, Math.max(0, o.fuelPct))}%` }} />
                </span>
                {`${Math.round(o.fuelPct)}%`}
              </span>
            )}
          </span>
        </Row>
      )}
      {o.acOn !== undefined && (
        <Row label={t('AC')}>
          {o.acOn === null ? '—' : o.acOn ? t('On') : t('Off')}
          {o.acVoltage != null && <span className="ms-1 font-normal text-muted-foreground">{`(${o.acVoltage.toFixed(1)} V)`}</span>}
        </Row>
      )}
      {o.doorOpen !== undefined && (
        <Row label={t('Door')}>
          {o.doorOpen === null ? '—' : o.doorOpen ? t('Open') : t('Closed')}
          {o.doorVoltage != null && <span className="ms-1 font-normal text-muted-foreground">{`(${o.doorVoltage.toFixed(1)} V)`}</span>}
        </Row>
      )}
      <Row label={t('Satellites')}>{orDash(o.satellites)}</Row>
      <Row label={t('Speed limit')}>{limit === null ? '—' : o.speedLimitKph === null ? t('{{limit}} km/h (default)', { limit }) : `${limit} km/h`}</Row>
    </dl>
    </>
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
      <Row label={t('SIM number')}>
        {(d?.simNumber ?? o.simNumber) ? (
          <a className="font-medium text-primary hover:underline" href={`tel:${(d?.simNumber ?? o.simNumber)!.replace(/[^\d+]/g, '')}`}>
            {d?.simNumber ?? o.simNumber}
          </a>
        ) : (
          value(null)
        )}
      </Row>
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
  // Dashcams only: the channels call answers NOT_DASHCAM (400) for other trackers, which hides the tab.
  const video = useVideoChannels(object.objectId, can('video') && !!object.deviceId && !object.licenceLocked);
  const hasVideo = video.isSuccess;
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
          {object.licenceLocked && (
            <Badge variant="destructive" className="mt-1.5">
              <LockIcon className="size-3" /> {t('Licence expired — renew to view')}
            </Badge>
          )}
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
          {hasVideo && <TabsTrigger value="video">{t('Video')}</TabsTrigger>}
          {canCommand && <TabsTrigger value="commands">{t('Commands')}</TabsTrigger>}
          {can('documents') && object.type === 'VEHICLE' && <TabsTrigger value="documents">{t('Documents')}</TabsTrigger>}
        </TabsList>
        <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <Overview o={object} now={now} />
          {hasVideo && <RecentDriverEvents objectId={object.objectId} />}
        </TabsContent>
        <TabsContent value="device" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <DeviceTab o={object} />
        </TabsContent>
        {can('documents') && object.type === 'VEHICLE' && (
          <TabsContent value="documents" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <CompliancePanel target={{ objectId: object.objectId, label: object.name }} />
          </TabsContent>
        )}
        {hasVideo && (
          <TabsContent value="video" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <VideoPanel objectId={object.objectId} vehicle={object.name} />
          </TabsContent>
        )}
        {canCommand && (
          <TabsContent value="commands" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            <CommandsTab object={object} />
          </TabsContent>
        )}
      </Tabs>
    </aside>
  );
}
