import { useQuery } from '@tanstack/react-query';
import type { AlertDto, GeofenceDto, NotificationLogDto, NotificationStatus } from '@veetracer/shared';
import { CheckIcon, MailIcon, MapPinIcon, MessageSquareIcon, SmartphoneIcon, BellIcon } from 'lucide-react';
import { lazy, Suspense, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, humanize } from '@/lib/format';
import { i18n } from '@/lib/i18n';
import { alertTitle } from './alert-center';
import { useOpenAlert } from './AlertBell';
import { AlertTypeIcon } from './alert-icons';
import { AlertStatusBadge, SeverityBadge } from './badges';

const MiniMap = lazy(() => import('./MiniMap').then((m) => ({ default: m.MiniMap })));

const NOTIFY_VARIANT: Record<NotificationStatus, 'success' | 'destructive' | 'muted' | 'secondary'> = {
  SENT: 'success',
  FAILED: 'destructive',
  SKIPPED: 'muted',
  QUEUED: 'secondary',
};

const CHANNEL_ICON = { EMAIL: MailIcon, SMS: SmartphoneIcon, WHATSAPP: MessageSquareIcon, PUSH: BellIcon, INAPP: BellIcon } as const;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** Formats an alert `data` value: seconds → duration-ish, numbers rounded, objects as JSON. */
function showValue(key: string, v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') {
    const rounded = Math.round(v * 10) / 10;
    if (/kph|speed|limit/i.test(key)) return `${rounded} km/h`;
    if (/sec$/i.test(key)) return `${Math.round(v)} s`;
    if (/min$/i.test(key)) return `${rounded} min`;
    if (/pct|battery/i.test(key)) return `${rounded}%`;
    if (/(^|_)m$|meters|distanceM/i.test(key)) return `${rounded} m`;
    return String(rounded);
  }
  if (typeof v === 'boolean') return v ? i18n.t('Yes') : i18n.t('No');
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}T/.test(v) ? formatDateTime(v) : v;
  return JSON.stringify(v);
}

function labelOf(key: string): string {
  return humanize(key.replace(/([a-z])([A-Z])/g, '$1_$2'));
}

/** Alert detail: map snippet, fields, `data`, acknowledgement, and the per-recipient notification log. */
export function AlertDetailSheet({ alertId, initial, onClose, onAck }: { alertId: string | null; initial: AlertDto | null; onClose: () => void; onAck: (a: AlertDto) => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const openOnMap = useOpenAlert();
  const alert = useQuery({
    queryKey: ['alerts', 'detail', alertId],
    queryFn: ({ signal }) => api.get<AlertDto>(`/alerts/${alertId}`, undefined, signal),
    enabled: !!alertId,
    initialData: initial ?? undefined,
  });
  const logs = useQuery({
    queryKey: ['alerts', 'notifications', alertId],
    queryFn: ({ signal }) => api.get<NotificationLogDto[]>(`/alerts/${alertId}/notifications`, undefined, signal),
    enabled: !!alertId,
    refetchInterval: (q) => (q.state.data?.some((l) => l.status === 'QUEUED') ? 3000 : false),
  });
  const a = alert.data;
  const geofence = useQuery({
    queryKey: ['geofence', a?.geofenceId],
    queryFn: ({ signal }) => api.get<GeofenceDto>(`/geofences/${a!.geofenceId}`, undefined, signal),
    enabled: !!a?.geofenceId && can('geofences'),
    staleTime: 5 * 60_000,
  });
  const dataEntries = Object.entries(a?.data ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '');

  return (
    <Sheet open={!!alertId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {a && <AlertTypeIcon type={a.type} severity={a.severity} />}
            {a ? alertTitle(a) : t('Alert')}
          </SheetTitle>
          <SheetDescription className="truncate">{a ? `${a.objectName}${a.plateNumber && a.plateNumber !== a.objectName ? ` · ${a.plateNumber}` : ''}` : ' '}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {alert.isError && <FormError message={errorMessage(alert.error)} />}
          {!a && alert.isPending && <Skeleton className="h-40 w-full" />}
          {a && (
            <>
              {a.lat !== null && a.lng !== null ? (
                <Suspense fallback={<div className="h-44 rounded-lg border bg-muted" />}>
                  <MiniMap lat={a.lat} lng={a.lng} severity={a.severity} geofence={geofence.data ? { geometry: geofence.data.geometry, color: geofence.data.color } : null} className="h-44" />
                </Suspense>
              ) : (
                <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">{t('No location for this alert.')}</p>
              )}
              <div className="flex flex-wrap gap-2">
                {can('live_map') && (
                  <Button size="sm" variant="outline" onClick={() => openOnMap(a)}>
                    <MapPinIcon /> {t('View on live map')}
                  </Button>
                )}
                {can('alerts', 'edit') && a.status === 'NEW' && (
                  <Button size="sm" onClick={() => onAck(a)}>
                    <CheckIcon /> {t('Acknowledge')}
                  </Button>
                )}
              </div>
              <dl className="divide-y">
                <Row label={t('Severity')}>
                  <SeverityBadge severity={a.severity} />
                </Row>
                <Row label={t('Status')}>
                  <span className="flex flex-wrap items-center gap-2">
                    <AlertStatusBadge status={a.status} />
                    {a.ackAt && <span className="text-xs text-muted-foreground">{`${a.ackByName ? `${t('by {{name}}', { name: a.ackByName })} · ` : ''}${formatDateTime(a.ackAt)}`}</span>}
                  </span>
                </Row>
                {a.ackNote && <Row label={t('Note')}>{a.ackNote}</Row>}
                <Row label={t('Time')}>{formatDateTime(a.occurredAt)}</Row>
                <Row label={t('Message')}>{a.message}</Row>
                <Row label={t('Location')}>
                  {a.address ?? <span className="text-muted-foreground">{t('Address pending')}</span>}
                  {a.lat !== null && <span className="block font-mono text-xs text-muted-foreground">{`${a.lat.toFixed(6)}, ${a.lng?.toFixed(6)}`}</span>}
                </Row>
                {a.geofenceName && <Row label={t('Geofence')}>{a.geofenceName}</Row>}
                {dataEntries.map(([k, v]) => (
                  <Row key={k} label={labelOf(k)}>
                    {showValue(k, v)}
                  </Row>
                ))}
              </dl>
            </>
          )}

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{t('Notifications')}</h3>
            {logs.isPending && <Skeleton className="h-16 w-full" />}
            {logs.isError && <FormError message={errorMessage(logs.error)} />}
            {logs.data?.length === 0 && <p className="text-sm text-muted-foreground">{t('No notifications were sent for this alert (in-app only, or no recipients).')}</p>}
            {logs.data && logs.data.length > 0 && (
              <ul className="divide-y rounded-lg border">
                {logs.data.map((l) => {
                  const Icon = CHANNEL_ICON[l.channel] ?? BellIcon;
                  return (
                    <li key={l.id} className="flex items-start gap-3 px-3 py-2 text-sm">
                      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label={l.channel} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{l.recipient}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {l.channel}
                          {l.provider ? ` · ${l.provider}` : ''} · {formatDateTime(l.sentAt ?? l.createdAt)}
                        </p>
                        {l.error && <p className="text-xs text-destructive">{l.error}</p>}
                      </div>
                      <Badge variant={NOTIFY_VARIANT[l.status]}>{humanize(l.status)}</Badge>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
