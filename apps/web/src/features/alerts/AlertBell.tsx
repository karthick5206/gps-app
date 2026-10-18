import type { AlertDto } from '@veetracer/shared';
import { AlertTriangleIcon, BellIcon, CheckCheckIcon, InfoIcon, MapPinIcon, PanelTopIcon, PanelTopDashedIcon, ShieldAlertIcon, SirenIcon, Volume2Icon, VolumeXIcon } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
import { SEVERITY_COLOR, SEVERITY_LABEL } from './severity';

// Lazy so maplibre stays out of the main bundle (the bell is in the shell).
const MiniMap = lazy(() => import('./MiniMap').then((m) => ({ default: m.MiniMap })));

export function useAlertCenter() {
  return useSyncExternalStore(alertCenter.subscribe, alertCenter.getState);
}

export function SeverityIcon({ severity, className }: { severity: AlertDto['severity']; className?: string }) {
  const Icon = severity === 'CRITICAL' ? SirenIcon : severity === 'WARNING' ? AlertTriangleIcon : InfoIcon;
  return <Icon className={cn('size-4 shrink-0', className)} style={{ color: SEVERITY_COLOR[severity] }} aria-label={SEVERITY_LABEL[severity]} />;
}

/** Where clicking an alert goes: the live map focused on the vehicle (falls back to the alerts page). */
export function useOpenAlert() {
  const navigate = useNavigate();
  const { can } = useAuth();
  return (a: AlertDto) => {
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
        toast.info(`${burstCount} more alert(s) just arrived`, { id: 'alert-burst', description: 'Open the bell to see the latest alerts.', duration: 5000 });
        return;
      }
      const opts = {
        id: `alert-${a.id}`,
        description: `${vehicleLabel(a)} — ${a.message}`,
        duration: a.severity === 'INFO' ? 4000 : 7000,
        action: { label: 'View', onClick: () => openRef.current(a) },
      };
      const title = alertTitle(a);
      if (a.severity === 'CRITICAL') toast.error(title, opts);
      else if (a.severity === 'WARNING') toast.warning(title, opts);
      else toast.info(title, opts);
    });
  }, []);
}

function CriticalAlertModal() {
  const { critical } = useAlertCenter();
  const { can } = useAuth();
  const open = useOpenAlert();
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const current = critical[0];
  const canAck = can('alerts', 'edit');

  useEffect(() => setNote(''), [current?.id]);

  if (!current) return null;

  const ack = async (thenOpen: boolean) => {
    setPending(true);
    try {
      await alertCenter.ack(current.id, note.trim() || undefined);
      toast.success('Alert acknowledged');
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
        critical.map((c) => c.id),
        note.trim() || undefined,
      );
      toast.success(`${critical.length} critical alerts acknowledged`);
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
              <DialogTitle className="text-destructive">{alertTitle(current)}</DialogTitle>
              <p className="text-xs text-muted-foreground">
                Critical alert{critical.length > 1 ? ` · 1 of ${critical.length}` : ''}
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
            <dt className="text-muted-foreground">Time</dt>
            <dd>{formatDateTime(current.occurredAt)}</dd>
            {(current.address || current.lat !== null) && (
              <>
                <dt className="text-muted-foreground">Location</dt>
                <dd className="break-words">{current.address ?? `${current.lat?.toFixed(5)}, ${current.lng?.toFixed(5)}`}</dd>
              </>
            )}
            {current.geofenceName && (
              <>
                <dt className="text-muted-foreground">Geofence</dt>
                <dd>{current.geofenceName}</dd>
              </>
            )}
          </dl>
          {canAck && <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional) — what action was taken?" className="min-h-16" aria-label="Acknowledgement note" />}
        </div>
        <DialogFooter className="flex-wrap">
          {canAck ? (
            <>
              {critical.length > 1 && (
                <Button variant="ghost" onClick={ackAll} disabled={pending}>
                  Acknowledge all {critical.length}
                </Button>
              )}
              <Button variant="outline" onClick={() => ack(true)} disabled={pending}>
                <MapPinIcon /> Acknowledge &amp; view
              </Button>
              <Button variant="destructive" onClick={() => ack(false)} disabled={pending}>
                {pending && <Spinner />}
                Acknowledge
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => open(current)}>
                <MapPinIcon /> View on map
              </Button>
              <Button variant="destructive" onClick={() => alertCenter.dismissCritical(current.id)}>
                Dismiss
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AlertRow({ a, onOpen }: { a: AlertDto; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
        <SeverityIcon severity={a.severity} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className={cn('truncate text-sm', a.status === 'NEW' ? 'font-semibold' : 'font-medium text-muted-foreground')}>{alertTitle(a)}</span>
            {a.status === 'NEW' && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
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
  const { can } = useAuth();
  const state = useAlertCenter();
  const [open, setOpen] = useState(false);
  const openAlert = useOpenAlert();
  const navigate = useNavigate();
  const [acking, setAcking] = useState(false);
  useAlertToasts();

  useEffect(() => {
    alertCenter.start();
    return () => alertCenter.stop();
  }, []);

  const unreadShown = state.latest.filter((a) => a.status === 'NEW').map((a) => a.id);
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
  const label = state.unread ? `Alerts, ${state.unread} unread` : 'Alerts';

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
            <p className="text-sm font-semibold">Alerts</p>
            {state.unread > 0 && <Badge variant="destructive">{state.unread} unread</Badge>}
            <span className="flex-1" />
            <Tooltip content={state.muted ? 'Sound off — click to turn on' : 'Sound on for Warning and Critical — click to mute'}>
              <Button variant="ghost" size="icon-sm" aria-label={state.muted ? 'Unmute alert sound' : 'Mute alert sound'} aria-pressed={state.muted} onClick={() => alertCenter.setMuted(!state.muted)}>
                {state.muted ? <VolumeXIcon /> : <Volume2Icon />}
              </Button>
            </Tooltip>
            <Tooltip content={state.criticalPopup ? 'Critical alerts open a pop-up until acknowledged — click to turn off' : 'Critical pop-ups off — click to turn on'}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={state.criticalPopup ? 'Turn off critical alert pop-ups' : 'Turn on critical alert pop-ups'}
                aria-pressed={!state.criticalPopup}
                onClick={() => alertCenter.setCriticalPopup(!state.criticalPopup)}
              >
                {state.criticalPopup ? <PanelTopIcon /> : <PanelTopDashedIcon />}
              </Button>
            </Tooltip>
            {can('alerts', 'edit') && unreadShown.length > 0 && (
              <Tooltip content="Acknowledge the unread alerts shown">
                <Button variant="ghost" size="icon-sm" aria-label="Acknowledge shown alerts" onClick={markShownRead} disabled={acking}>
                  {acking ? <Spinner /> : <CheckCheckIcon />}
                </Button>
              </Tooltip>
            )}
          </div>
          <ul className="max-h-[min(28rem,70vh)] overflow-y-auto p-1">
            {!state.loaded && <li className="px-3 py-8 text-center text-sm text-muted-foreground">Loading…</li>}
            {state.loaded && state.latest.length === 0 && <li className="px-3 py-8 text-center text-sm text-muted-foreground">No alerts yet.</li>}
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
          <div className="border-t p-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => {
                setOpen(false);
                navigate('/alerts');
              }}
            >
              View all alerts
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <CriticalAlertModal />
    </>
  );
}
