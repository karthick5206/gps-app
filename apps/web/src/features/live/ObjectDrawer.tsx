import { useQuery } from '@tanstack/react-query';
import { DEFAULT_SPEED_LIMIT_KPH, type DeviceDto, type LiveObject } from '@veetracer/shared';
import { CrosshairIcon, HistoryIcon, LocateFixedIcon, LocateIcon, XIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/features/auth/auth-context';
import { api } from '@/lib/api';
import { formatDateTime, formatDuration, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';

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
  const since = o.statusSince ? formatDuration((now - Date.parse(o.statusSince)) / 1000) : null;
  const limit = o.speedLimitKph ?? (o.vehicleType ? DEFAULT_SPEED_LIMIT_KPH[o.vehicleType] : null);
  return (
    <dl className="divide-y">
      <Row label="Status">
        <span className="flex flex-col items-end gap-1">
          <StatusBadge status={o.status} />
          {since && <span className="text-xs font-normal text-muted-foreground">for {since}</span>}
        </span>
      </Row>
      <Row label="Speed">{`${Math.round(o.speedKph)} km/h`}</Row>
      <Row label="Ignition">{o.ignition === null ? '—' : o.ignition ? 'On' : 'Off'}</Row>
      <Row label="Coordinates">
        {o.lat !== null && o.lng !== null ? <span className="font-mono text-xs">{`${o.lat.toFixed(6)}, ${o.lng.toFixed(6)}`}</span> : '—'}
      </Row>
      <Row label="Heading">{o.lat !== null ? `${Math.round(o.course)}°` : '—'}</Row>
      <Row label="Last fix">
        <span className="flex flex-col items-end">
          {formatDateTime(o.fixTime)}
          <span className="text-xs font-normal text-muted-foreground">{relativeTime(o.fixTime, now)}</span>
        </span>
      </Row>
      <Row label="Server time">{formatDateTime(o.serverTime)}</Row>
      <Row label="Battery">{orDash(o.batteryLevel, '%')}</Row>
      <Row label="GSM signal">{o.gsmSignal === null ? '—' : (GSM_LABELS[o.gsmSignal] ?? o.gsmSignal)}</Row>
      <Row label="External voltage">{orDash(o.extVoltage, ' V')}</Row>
      <Row label="Satellites">{orDash(o.satellites)}</Row>
      <Row label="Speed limit">{limit === null ? '—' : `${limit} km/h${o.speedLimitKph === null ? ' (default)' : ''}`}</Row>
    </dl>
  );
}

function DeviceTab({ o }: { o: LiveObject }) {
  const { can } = useAuth();
  const allowed = can('devices') && !!o.deviceId;
  const device = useQuery({
    queryKey: ['device', o.deviceId],
    queryFn: ({ signal }) => api.get<DeviceDto>(`/devices/${o.deviceId}`, undefined, signal),
    enabled: allowed,
    staleTime: 5 * 60_000,
  });
  if (!o.deviceId) return <p className="py-6 text-center text-sm text-muted-foreground">No device is assigned to this object.</p>;
  const d = device.data;
  const pending = allowed && device.isPending;
  const value = (v: string | null | undefined) => (pending ? <Skeleton className="ml-auto h-4 w-24" /> : orDash(v));
  return (
    <dl className="divide-y">
      <Row label="IMEI / ID">
        <span className="font-mono text-xs">{o.uniqueId}</span>
      </Row>
      <Row label="Model">{value(d?.modelName)}</Row>
      <Row label="Protocol">{value(d?.protocol)}</Row>
      <Row label="SIM number">{value(d?.simNumber)}</Row>
      <Row label="SIM operator">{value(d?.simOperator)}</Row>
      <Row label="Firmware">{value(d?.firmware)}</Row>
      {!can('devices') && <p className="pt-3 text-xs text-muted-foreground">Device details require access to the Devices master.</p>}
    </dl>
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
  const hasCoords = object.lat !== null;
  const { can } = useAuth();
  return (
    <aside
      aria-label="Object details"
      className={cn('flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card shadow-xl animate-slide-in-right', className)}
    >
      <div className="flex items-start gap-3 border-b p-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{object.name}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {[object.plateNumber, object.vehicleType ?? object.type].filter(Boolean).join(' · ')}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close details">
          <XIcon />
        </Button>
      </div>
      <div className="flex gap-2 border-b px-4 py-3">
        <Button size="sm" variant={following ? 'default' : 'outline'} disabled={!hasCoords} onClick={() => onFollowChange(!following)} aria-pressed={following}>
          {following ? <LocateFixedIcon /> : <LocateIcon />}
          {following ? 'Following' : 'Follow'}
        </Button>
        <Button size="sm" variant="outline" disabled={!hasCoords} onClick={onZoomTo}>
          <CrosshairIcon /> Zoom to
        </Button>
        {can('history') && (
          <Button size="sm" variant="outline" asChild>
            <Link to={`/history?objectId=${encodeURIComponent(object.objectId)}`}>
              <HistoryIcon /> History
            </Link>
          </Button>
        )}
      </div>
      <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-4 mt-3 w-[calc(100%-2rem)]">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="device">Device</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <Overview o={object} now={now} />
        </TabsContent>
        <TabsContent value="device" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <DeviceTab o={object} />
        </TabsContent>
      </Tabs>
    </aside>
  );
}
