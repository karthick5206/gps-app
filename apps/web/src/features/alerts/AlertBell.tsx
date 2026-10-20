import type { AlertDto } from '@veetracer/shared';
import { BellIcon, CheckCheckIcon, MailOpenIcon, MapPinIcon, MonitorIcon, MonitorOffIcon, PanelTopIcon, PanelTopDashedIcon, ShieldAlertIcon, Volume2Icon, VolumeXIcon } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip } from '@/components/ui/tooltip';
import { useAuth } from '@/features/auth/auth-context';
import { errorMessage } from '@/lib/api';
import { formatDateTime, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { alertCenter, alertTitle } from './alert-center';
import { alertIcon, AlertTypeIcon } from './alert-icons';
import { desktopNotify, useDesktopNotify } from './desktop-notify';
import { isUnread } from './read-state';
import { SEVERITY_COLOR } from './severity';

// Lazy so maplibre stays out of the main bundle (the bell is in the shell).
const MiniMap = lazy(() => import('./MiniMap').then((m) => ({ default: m.MiniMap })));

export function useAlertCenter() {
  return useSyncExternalStore(alertCenter.subscribe, alertCenter.getState);
}

/**
 * Where clicking an alert goes: the live map focused on the vehicle (falls back to the alerts page).
 * Opening an alert marks it read for this user (bell item, toast "View", desktop notification, pop-up "View on map").
 */
export function useOpenAlert() {
  const navigate = useNavigate();
  const { can } = useAuth();
  return (a: AlertDto) => {
    alertCenter.markRead(a).catch(() => undefined);
    if (can('live_map')) navigate(`/live?focus=${encodeURIComponent(a.objectId)}&alert=${encodeURIComponent(a.id)}`);
    else navigate(`/alerts?alertId=${encodeURIComponent(a.id)}`);
  };
}

function vehicleLabel(a: AlertDto) {
  return a.plateNumber && a.plateNumber !== a.objectName ? `${a.objectName} · ${a.plateNumber}` : a.objectName;
}

const BURST_WINDOW_MS = 4000;
const BURST_MAX = 4;

/** Toast per incoming alert; bursts collapse into one summary toast so a noisy fleet doesn't flood the screen. */
function useAlertToasts() {
  const { t } = useTranslation();
  const open = useOpenAlert();
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const recent: number[] = [];
    let burstCount = 0;
    return alertCenter.onAlert((a) => {
      const now = Date.now();
      while (recent.length && now - recent[0] > BURST_WINDOW_MS) recent.shift();
      recent.push(now);
      if (recent.length > BURST_MAX) {
        burstCount = recent.length > BURST_MAX + 1 ? burstCount + 1 : 1;
        toast.info(t('{{count}} more alert(s) just arrived', { count: burstCount }), { id: 'alert-burst', description: t('Open the bell to see the latest alerts.'), duration: 5000 });
        return;
      }
      // Background tab / minimised window: also a desktop notification with the VeeTrax icon.
      desktopNotify.show(a, alertTitle(a), `${vehicleLabel(a)} — ${a.message}`, () => openRef.current(a));
      const Icon = alertIcon(a.type);
      const opts = {
        id: `alert-${a.id}`,
        icon: <Icon className="size-4" style={{ color: SEVERITY_COLOR[a.severity] }} aria-hidden />,
        description: `${vehicleLabel(a)} — ${a.message}`,
        duration: a.severity === 'INFO' ? 4000 : 7000,
        action: { label: t('View'), onClick: () => openRef.current(a) },
      };
      const title = alertTitle(a);
      if (a.severity === 'CRITICAL') toast.error(title, opts);
      else if (a.severity === 'WARNING') toast.warning(title, opts);
      else toast.info(title, opts);
    });
  }, [t]);
}

/** Desktop notifications on / off for this browser (asks for permission when turned on). */
function DesktopNotifyToggle() {
  const { t } = useTranslation();
  const state = useDesktopNotify();
  if (state === 'unsupported') return null;
  const label =
    state === 'on'
      ? t('Desktop notifications on — click to turn off')
      : state === 'blocked'
        ? t('Desktop notifications are blocked in the browser settings for this site')
        : t('Desktop notifications off — click to turn on');
  const toggle = async () => {
    if (state === 'on') return desktopNotify.disable();
    const next = await desktopNotify.enable();
    if (next === 'on') toast.success(t('Desktop notifications on'), { description: t('Warning and critical alerts appear on your desktop when this tab is in the background.') });
    else toast.error(t('Desktop notifications are blocked in the browser settings for this site'));
  };
  return (
    <Tooltip content={label}>
      <Button variant="ghost" size="icon-sm" aria-label={label} aria-pressed={state === 'on'} disabled={state === 'blocked'} onClick={() => void toggle()}>
        {state === 'on' ? <MonitorIcon /> : <MonitorOffIcon />}
      </Button>
    </Tooltip>
  );
}

function CriticalAlertModal() {
  const { t } = useTranslation();
  const { critical } = useAlertCenter();
  const { can } = useAuth();
  const open = useOpenAlert();
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const current = critical[0];
  // Power cut can be configured not to need acknowledgement: then the pop-up only offers View / Dismiss.
  const canAck = can('alerts', 'edit') && !!current?.ackRequired;

  useEffect(() => setNote(''), [current?.id]);

  if (!current) return null;

  const ack = async (thenOpen: boolean) => {
    setPending(true);
    try {
      await alertCenter.ack(current.id, note.trim() || undefined);
      toast.success(t('Alert acknowledged'));
      if (thenOpen) open(current);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  const ackAll = async () => {
    setPending(true);
    try {
      await alertCenter.ackAll(
        critical.filter((c) => c.ackRequired).map((c) => c.id),
        note.trim() || undefined,
      );
      toast.success(t('{{count}} critical alerts acknowledged', { count: critical.length }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open>
      <DialogContent
        hideClose
        className="max-w-md border-destructive/40 shadow-[0_0_0_4px] shadow-destructive/15"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <span className="flex size-9 items-center justify-center rounded-full bg-destructive/12 text-destructive motion-safe:animate-pulse">
              <ShieldAlertIcon className="size-5" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <AlertTypeIcon type={current.type} severity="CRITICAL" />
                {alertTitle(current)}
              </DialogTitle>
              <p className="text-xs text-muted-foreground">
                {t('Critical alert')}
                {critical.length > 1 ? ` · ${t('1 of {{count}}', { count: critical.length })}` : ''}
              </p>
            </div>
          </div>
          <DialogDescription className="pt-2 text-foreground">
            <span className="font-medium">{vehicleLabel(current)}</span> — {current.message}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {current.lat !== null && current.lng !== null && (
            <Suspense fallback={<div className="h-36 rounded-lg border bg-muted" />}>
              <MiniMap lat={current.lat} lng={current.lng} severity="CRITICAL" className="h-36" />
            </Suspense>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('Time')}</dt>
            <dd>{formatDateTime(current.occurredAt)}</dd>
            {(current.address || current.lat !== null) && (
              <>
                <dt className="text-muted-foreground">{t('Location')}</dt>
                <dd className="break-words">{current.address ?? `${current.lat?.toFixed(5)}, ${current.lng?.toFixed(5)}`}</dd>
              </>
            )}
            {current.geofenceName && (
              <>
                <dt className="text-muted-foreground">{t('Geofence')}</dt>
                <dd>{current.geofenceName}</dd>
              </>
            )}
          </dl>
          {canAck && <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('Note (optional) — what action was taken?')} className="min-h-16" aria-label={t('Acknowledgement note')} />}
        </div>
        <DialogFooter className="flex-wrap">
          {canAck ? (
            <>
              {critical.length > 1 && (
                <Button variant="ghost" onClick={ackAll} disabled={pending}>
                  {t('Acknowledge all {{count}}', { count: critical.length })}
                </Button>
              )}
              <Button variant="outline" onClick={() => ack(true)} disabled={pending}>
                <MapPinIcon /> {t('Acknowledge & view')}
              </Button>
              <Button variant="destructive" onClick={() => ack(false)} disabled={pending}>
                {pending && <Spinner />}
                {t('Acknowledge')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => open(current)}>
                <MapPinIcon /> {t('View on map')}
              </Button>
              <Button variant="destructive" onClick={() => alertCenter.dismissCritical(current.id)}>
                {t('Dismiss')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AlertRow({ a, onOpen }: { a: AlertDto; onOpen: () => void }) {
  const { t } = useTranslation();
  const unread = isUnread(a);
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
        <AlertTypeIcon type={a.type} severity={a.severity} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className={cn('truncate text-sm', unread ? 'font-semibold' : 'font-medium text-muted-foreground')}>{alertTitle(a)}</span>
            {unread && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label={t('Unread')} />}
            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground" title={formatDateTime(a.occurredAt)}>
              {relativeTime(a.occurredAt)}
            </span>
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {vehicleLabel(a)} — {a.message}
          </span>
        </span>
      </button>
    </li>
  );
}

/** Top-bar bell: unread count, latest 20 dropdown, mute toggle; hosts alert toasts and the critical modal. */
export function AlertBell() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const state = useAlertCenter();
  const [open, setOpen] = useState(false);
  const openAlert = useOpenAlert();
  const navigate = useNavigate();
  const [acking, setAcking] = useState(false);
  const [reading, setReading] = useState(false);
  useAlertToasts();

  useEffect(() => {
    alertCenter.start();
    return () => alertCenter.stop();
  }, []);

  // Acknowledge applies only to alerts that need it (emergencies, power cut, offline, CRITICAL).
  const unreadShown = state.latest.filter((a) => a.status === 'NEW' && a.ackRequired).map((a) => a.id);
  const markShownRead = async () => {
    setAcking(true);
    try {
      await alertCenter.ackAll(unreadShown);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setAcking(false);
    }
  };
  const markAllRead = async () => {
    setReading(true);
    try {
      await alertCenter.markAllRead();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setReading(false);
    }
  };
  const label = state.unread ? t('Alerts, {{count}} unread', { count: state.unread }) : t('Alerts');

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip content={label}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={label} className="relative">
              <BellIcon />
              {state.unread > 0 && (
                <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-none font-semibold text-destructive-foreground tabular-nums ring-2 ring-card">
                  {state.unread > 99 ? '99+' : state.unread}
                </span>
              )}
            </Button>
          </PopoverTrigger>
        </Tooltip>
        <PopoverContent
          align="end"
          className="w-[min(24rem,calc(100vw-1rem))] p-0"
          onOpenAutoFocus={(e) => {
            // Focus the list rather than the first icon button (which would pop its tooltip).
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('li button')?.focus({ preventScroll: true });
          }}
        >
          <div className="flex items-center gap-2 border-b px-3 py-2.5">
            <p className="text-sm font-semibold">{t('Alerts')}</p>
            {state.unread > 0 && <Badge variant="destructive">{t('{{count}} unread', { count: state.unread })}</Badge>}
            {state.pendingAck > 0 && (
              <Tooltip content={t('Alerts that still need acknowledgement')}>
                <Badge variant="warning">{t('{{count}} need acknowledgement', { count: state.pendingAck })}</Badge>
              </Tooltip>
            )}
            <span className="flex-1" />
            <Tooltip content={state.muted ? t('Sound off — click to turn on') : t('Sound on for Warning and Critical — click to mute')}>
              <Button variant="ghost" size="icon-sm" aria-label={state.muted ? t('Unmute alert sound') : t('Mute alert sound')} aria-pressed={state.muted} onClick={() => alertCenter.setMuted(!state.muted)}>
                {state.muted ? <VolumeXIcon /> : <Volume2Icon />}
              </Button>
            </Tooltip>
            <Tooltip content={state.criticalPopup ? t('Critical alerts open a pop-up until acknowledged — click to turn off') : t('Critical pop-ups off — click to turn on')}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={state.criticalPopup ? t('Turn off critical alert pop-ups') : t('Turn on critical alert pop-ups')}
                aria-pressed={!state.criticalPopup}
                onClick={() => alertCenter.setCriticalPopup(!state.criticalPopup)}
              >
                {state.criticalPopup ? <PanelTopIcon /> : <PanelTopDashedIcon />}
              </Button>
            </Tooltip>
            <DesktopNotifyToggle />
            {can('alerts', 'edit') && unreadShown.length > 0 && (
              <Tooltip content={t('Acknowledge the alerts shown that need it')}>
                <Button variant="ghost" size="icon-sm" aria-label={t('Acknowledge shown alerts')} onClick={markShownRead} disabled={acking}>
                  {acking ? <Spinner /> : <CheckCheckIcon />}
                </Button>
              </Tooltip>
            )}
          </div>
          <ul className="max-h-[min(28rem,70vh)] overflow-y-auto p-1">
            {!state.loaded && <li className="px-3 py-8 text-center text-sm text-muted-foreground">{t('Loading…')}</li>}
            {state.loaded && state.latest.length === 0 && <li className="px-3 py-8 text-center text-sm text-muted-foreground">{t('No alerts yet.')}</li>}
            {state.latest.map((a) => (
              <AlertRow
                key={a.id}
                a={a}
                onOpen={() => {
                  setOpen(false);
                  openAlert(a);
                }}
              />
            ))}
          </ul>
          <div className="flex gap-1 border-t p-1.5">
            {state.unread > 0 && (
              <Button variant="ghost" size="sm" className="flex-1" onClick={markAllRead} disabled={reading}>
                {reading ? <Spinner /> : <MailOpenIcon />}
                {t('Mark all as read')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="flex-1"
              onClick={() => {
                setOpen(false);
                navigate('/alerts');
              }}
            >
              {t('View all alerts')}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <CriticalAlertModal />
    </>
  );
}
