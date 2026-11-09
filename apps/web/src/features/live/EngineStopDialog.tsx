import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ENGINE_STOP_MAX_FIX_AGE_SEC,
  ENGINE_STOP_MAX_SPEED_KPH,
  ENGINE_STOP_PREPARE_WAIT_SEC,
  type CommandDto,
  type EngineStopPrepareResponse,
} from '@veetracer/shared';
import { CheckCircle2Icon, MapPinIcon, PowerOffIcon, RadarIcon, ShieldAlertIcon } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { ageSec, canConfirm, PREPARE_POLL_MS, secondsLeft, shouldPoll, waitLeft } from './engine-stop-flow';

// Lazy so maplibre stays out of the bundle until the fresh position is shown.
const MiniMap = lazy(() => import('@/features/alerts/MiniMap').then((m) => ({ default: m.MiniMap })));

/** Re-renders every second (countdowns). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * Engine stop in two steps (owner decision on the anti-theft proposal, Option 1): 1) ask the connected tracker for a
 * fresh position and show it; 2) explicit confirmation with the user's password, which sends the engine stop through
 * the normal command path. The server re-checks every rule at send time (online, telemetry ≤ 60 s, ≤ 20 km/h, never
 * queued); this dialog never sends anything automatically. Also opened from the parking-breach alarm ("Immobilise…").
 */
export function EngineStopDialog({ objectId, objectName, open, onClose, context }: { objectId: string; objectName: string; open: boolean; onClose: () => void; context?: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [prep, setPrep] = useState<EngineStopPrepareResponse | null>(null);
  const [password, setPassword] = useState('');
  const now = useNow(open && !!prep);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reset = () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setPrep(null);
    setPassword('');
  };
  useEffect(() => {
    if (!open) reset();
  }, [open]);

  const prepare = useMutation({
    mutationFn: (requestId?: string) => api.post<EngineStopPrepareResponse>(`/objects/${objectId}/commands/engine-stop/prepare`, requestId ? { requestId } : {}),
    onSuccess: (p) => setPrep(p),
    onError: (err) => {
      // Rate limit, expired request, network: back to the start (nothing was sent beyond the position request).
      toast.error(errorMessage(err));
      setPrep(null);
    },
  });

  // Poll while the tracker hasn't answered (re-calling prepare with the requestId never sends anything).
  useEffect(() => {
    if (!open || !shouldPoll(prep)) return;
    pollTimer.current = setTimeout(() => prepare.mutate(prep!.requestId!), PREPARE_POLL_MS);
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [open, prep]);

  const send = useMutation({
    mutationFn: () => api.post<CommandDto>(`/objects/${objectId}/commands`, { type: 'engine_stop', password, prepareRequestId: prep!.requestId }),
    onSuccess: (c) => {
      if (c.status === 'FAILED') toast.error(t('Stop engine: not sent'), { description: c.error ?? undefined });
      else toast.success(t('Stop engine: sent to the tracker'), { description: t('Delivery and the device reply appear in the command history.') });
      queryClient.invalidateQueries({ queryKey: ['commands', objectId] });
      onClose();
    },
    onError: (err) => {
      toast.error(errorMessage(err));
      setPassword('');
    },
  });

  const fresh = prep?.freshPosition ?? null;
  const left = secondsLeft(prep?.confirmBy, now);
  const confirmable = canConfirm(prep, now);
  const waiting = prep?.status === 'waiting' || (prepare.isPending && !prep);
  const refused = prep && (prep.status === 'blocked' || prep.status === 'timeout' || prep.status === 'not_connected');

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PowerOffIcon className="size-4 text-destructive" /> {t('Stop engine')} · {objectName}
          </DialogTitle>
          <DialogDescription>
            {context ?? t('First the tracker is asked for its position now. You then check the fresh position and confirm with your password.')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <ol className="flex gap-2 text-xs" aria-label={t('Steps')}>
            <li className={!fresh ? 'font-semibold' : 'text-muted-foreground'}>1. {t('Fresh position')}</li>
            <li aria-hidden>→</li>
            <li className={fresh ? 'font-semibold' : 'text-muted-foreground'}>2. {t('Confirm')}</li>
          </ol>

          {!prep && !prepare.isPending && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{t('The tracker must be connected now. Engine stop is never queued for later.')}</li>
              <li>{t('A new GPS position must arrive within {{sec}} s.', { sec: ENGINE_STOP_PREPARE_WAIT_SEC })}</li>
              <li>{t('Engine stop is only allowed at or below {{max}} km/h, with a position from the last {{age}} s.', { max: ENGINE_STOP_MAX_SPEED_KPH, age: ENGINE_STOP_MAX_FIX_AGE_SEC })}</li>
            </ul>
          )}

          {waiting && (
            <div className="flex items-center gap-3 rounded-lg bg-muted px-3 py-3 text-sm" role="status">
              <Spinner />
              <div>
                <p className="font-medium">{t('Asking the vehicle for its position…')}</p>
                <p className="text-xs text-muted-foreground">
                  {prep?.message ? t(prep.message) : null} {prep ? t('{{sec}} s left', { sec: waitLeft(prep.requestedAt, now) }) : null}
                </p>
              </div>
            </div>
          )}

          {fresh && (
            <div className="space-y-2">
              <Suspense fallback={<div className="h-36 rounded-lg border bg-muted" />}>
                <MiniMap key={fresh.fixTime} lat={fresh.lat} lng={fresh.lng} severity={prep?.status === 'ready' ? 'INFO' : 'CRITICAL'} className="h-36" />
              </Suspense>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">{t('Position time')}</dt>
                <dd>
                  {formatDateTime(fresh.fixTime)} · {t('{{sec}} s ago', { sec: ageSec(fresh.fixTime, now) })}
                </dd>
                <dt className="text-muted-foreground">{t('Speed')}</dt>
                <dd className={fresh.speedKph > ENGINE_STOP_MAX_SPEED_KPH ? 'font-semibold text-destructive' : 'font-semibold'}>{Math.round(fresh.speedKph)} km/h</dd>
                <dt className="text-muted-foreground">{t('Ignition')}</dt>
                <dd>{fresh.ignition === null ? '—' : fresh.ignition ? t('On') : t('Off')}</dd>
                {fresh.satellites !== null && (
                  <>
                    <dt className="text-muted-foreground">{t('Satellites')}</dt>
                    <dd>{fresh.satellites}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">
                  <MapPinIcon className="inline size-3.5" /> {t('Location')}
                </dt>
                <dd className="font-mono text-xs">
                  {fresh.lat.toFixed(5)}, {fresh.lng.toFixed(5)}
                </dd>
              </dl>
            </div>
          )}

          {refused && (
            <p className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
              <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" /> {t(prep.blockReason ?? prep.message ?? 'Engine stop is not possible right now.')}
            </p>
          )}

          {prep?.status === 'ready' && (
            <>
              <p className="flex gap-2 text-sm">
                <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" />
                {left > 0
                  ? t('Fresh position received. Confirm within {{sec}} s, or request a new position.', { sec: left })
                  : t('This position is now older than {{age}} s. Request a fresh position again.', { age: ENGINE_STOP_MAX_FIX_AGE_SEC })}
              </p>
              {left > 0 && (
                <Field label={t('Your password')} htmlFor="estop-password" hint={t('Required to stop an engine. The server checks every safety rule again when you confirm.')}>
                  <Input id="estop-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
                </Field>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Cancel')}
          </Button>
          {prep?.status === 'ready' && left > 0 ? (
            <Button variant="destructive" disabled={!confirmable || !password || send.isPending} onClick={() => send.mutate()}>
              {send.isPending && <Spinner />} <PowerOffIcon /> {t('Stop engine now')}
            </Button>
          ) : (
            <Button
              disabled={waiting || prepare.isPending}
              onClick={() => {
                reset();
                prepare.mutate(undefined);
              }}
            >
              {prepare.isPending && !prep ? <Spinner /> : <RadarIcon />} {prep ? t('Request fresh position again') : t('Request fresh position')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
