import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { COMMAND_DEF_MAP, ENGINE_STOP_MAX_SPEED_KPH, type AvailableCommand, type CommandDto, type CommandStatusValue, type LiveObject } from '@veetracer/shared';
import { PowerIcon, PowerOffIcon, RadarIcon, RotateCwIcon, SendIcon, TerminalIcon, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

const ICONS: Record<string, LucideIcon> = {
  engine_stop: PowerOffIcon,
  engine_resume: PowerIcon,
  locate: RadarIcon,
  status: SendIcon,
  reboot: RotateCwIcon,
  custom: TerminalIcon,
};

const STATUS: Record<CommandStatusValue, { label: string; variant: 'secondary' | 'default' | 'success' | 'destructive' | 'muted' }> = {
  QUEUED: { label: 'Queued', variant: 'secondary' },
  SENT: { label: 'Sent', variant: 'default' },
  ACKED: { label: 'Acknowledged', variant: 'success' },
  FAILED: { label: 'Failed', variant: 'destructive' },
  EXPIRED: { label: 'Expired', variant: 'muted' },
};

function ConfirmDialog({ object, command, onClose }: { object: LiveObject; command: AvailableCommand | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [text, setText] = useState('');
  const send = useMutation({
    mutationFn: () =>
      api.post<CommandDto>(`/objects/${object.objectId}/commands`, {
        type: command!.type,
        ...(command!.type === 'custom' ? { text } : {}),
        ...(command!.critical ? { password } : {}),
      }),
    onSuccess: (c) => {
      toast.success(c.status === 'QUEUED' ? `${command!.label}: sent to the device` : `${command!.label}: ${STATUS[c.status].label.toLowerCase()}`, {
        description: 'Delivery and the device reply appear in the command history.',
      });
      queryClient.invalidateQueries({ queryKey: ['commands', object.objectId] });
      setPassword('');
      setText('');
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const offline = object.status === 'OFFLINE' || object.status === 'NO_DATA';
  const blocked = !!command?.critical && object.speedKph > ENGINE_STOP_MAX_SPEED_KPH && !offline;
  const ready = !!command && (!command.critical || password.length > 0) && (command.type !== 'custom' || text.trim().length > 0) && !blocked;
  return (
    <Dialog open={!!command} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {command?.label} · {object.name}
          </DialogTitle>
          <DialogDescription>{command?.description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {command?.type === 'custom' ? (
            <Field label="Command text" htmlFor="cmd-text" hint="Sent exactly as typed, e.g. PARAM# (Concox) or getver (Teltonika).">
              <Input id="cmd-text" value={text} maxLength={200} onChange={(e) => setText(e.target.value)} autoFocus className="font-mono" />
            </Field>
          ) : (
            <p className="rounded-lg bg-muted px-3 py-2 font-mono text-sm">{command?.payload}</p>
          )}
          {offline && <p className="text-sm text-warning">The device is offline. The command is queued and sent when it reconnects (within 24 hours).</p>}
          {blocked && (
            <p className="text-sm text-destructive">
              The vehicle is moving at {Math.round(object.speedKph)} km/h. Engine stop is only allowed below {ENGINE_STOP_MAX_SPEED_KPH} km/h.
            </p>
          )}
          {command?.critical && !blocked && (
            <Field label="Your password" htmlFor="cmd-password" hint="Required to stop an engine.">
              <Input id="cmd-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            </Field>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={command?.critical ? 'destructive' : 'default'} disabled={!ready || send.isPending} onClick={() => send.mutate()}>
            {send.isPending && <Spinner />} {command?.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Live-map drawer tab: send commands to the vehicle's tracker and follow their delivery. */
export function CommandsTab({ object }: { object: LiveObject }) {
  const [pending, setPending] = useState<AvailableCommand | null>(null);
  const available = useQuery({
    queryKey: ['commands-available', object.objectId],
    queryFn: ({ signal }) => api.get<AvailableCommand[]>(`/objects/${object.objectId}/commands/available`, undefined, signal),
    staleTime: 5 * 60_000,
  });
  const history = useQuery({
    queryKey: ['commands', object.objectId],
    queryFn: ({ signal }) => api.get<CommandDto[]>(`/objects/${object.objectId}/commands`, undefined, signal),
    // Follow delivery while anything is still in flight.
    refetchInterval: (q) => (q.state.data?.some((c) => c.status === 'QUEUED' || c.status === 'SENT') ? 3000 : false),
  });

  return (
    <div className="space-y-4 pt-3">
      {available.isLoading && <Skeleton className="h-20" />}
      {available.isError && <p className="text-sm text-destructive">{errorMessage(available.error)}</p>}
      {available.data?.length === 0 && <p className="text-sm text-muted-foreground">This tracker model doesn't support remote commands.</p>}
      {!!available.data?.length && (
        <div className="grid grid-cols-2 gap-2">
          {available.data.map((c) => {
            const Icon = ICONS[c.type] ?? SendIcon;
            return (
              <Button key={c.type} variant={c.critical ? 'destructive' : 'outline'} size="sm" className="justify-start" onClick={() => setPending(c)}>
                <Icon /> {c.label}
              </Button>
            );
          })}
        </div>
      )}

      <section aria-labelledby="cmd-history" className="space-y-2">
        <h3 id="cmd-history" className="text-sm font-semibold">
          Recent commands
        </h3>
        {history.isLoading && <Skeleton className="h-24" />}
        {history.data?.length === 0 && <p className="text-sm text-muted-foreground">No commands sent yet.</p>}
        <ul className="space-y-2">
          {history.data?.map((c) => (
            <li key={c.id} className="rounded-lg border p-2.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{COMMAND_DEF_MAP[c.type]?.label ?? c.type}</span>
                <Badge variant={STATUS[c.status].variant}>{STATUS[c.status].label}</Badge>
              </div>
              <p className="mt-1 font-mono text-xs text-muted-foreground">{c.payload}</p>
              {c.response && <p className="mt-1.5 rounded bg-muted px-2 py-1 font-mono text-xs break-words">{c.response}</p>}
              {c.error && <p className="mt-1 text-xs text-destructive">{c.error}</p>}
              <p className="mt-1 text-xs text-muted-foreground">
                {c.createdByName ?? 'Unknown user'} · {formatDateTime(c.createdAt)}
                {c.ackAt ? ` · replied ${formatDateTime(c.ackAt)}` : c.sentAt ? ` · sent ${formatDateTime(c.sentAt)}` : ''}
              </p>
            </li>
          ))}
        </ul>
      </section>
      <ConfirmDialog object={object} command={pending} onClose={() => setPending(null)} />
    </div>
  );
}
