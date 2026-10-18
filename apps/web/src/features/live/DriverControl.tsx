import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DriverDto, LiveObject } from '@veetracer/shared';
import { IdCardIcon, ListIcon, UserRoundXIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Combobox, type Option } from '@/components/ui/multi-select';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { DriverSessionsSheet } from '@/features/masters/pages/DriversPage';
import { useEntityOptions } from '@/features/masters/use-options';
import { api, errorMessage } from '@/lib/api';
import { liveStore } from './live-store';

const driverOption = (d: DriverDto): Option => ({
  value: d.id,
  label: d.name,
  description: [d.employeeId, d.current ? `on ${d.current.objectName}` : null].filter(Boolean).join(' · ') || undefined,
});

/** Driver row of the live drawer: who is driving, change / clear it, and the vehicle's driver sessions. */
export function DriverControl({ o }: { o: LiveObject }) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const canAssign = can('drivers', 'edit') || can('objects', 'edit');
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState(false);
  const [q, setQ] = useState('');
  const [driverId, setDriverId] = useState<string | null>(null);
  const drivers = useEntityOptions<DriverDto>('/drivers', driverOption, { q, enabled: open });

  const assign = useMutation({
    mutationFn: (id: string | null) => api.post<{ changed: boolean }>('/drivers/assign', { objectId: o.objectId, driverId: id }),
    onSuccess: (_r, id) => {
      toast.success(id ? 'Driver assigned' : 'Driver removed from the vehicle');
      setOpen(false);
      setDriverId(null);
      queryClient.invalidateQueries({ queryKey: ['options', '/drivers'] });
      queryClient.invalidateQueries({ queryKey: ['master', '/drivers'] });
      // Live state carries the driver; reload it so the change shows without waiting for the next position.
      liveStore.loadSnapshot().catch(() => undefined);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <span className="text-muted-foreground">Driver</span>
      <span className="flex min-w-0 flex-col items-end gap-1">
        {o.driverName ? (
          <span className="flex items-center gap-1.5 font-medium">
            {o.driverName}
            <Badge variant="muted">{o.driverSource === 'RFID' ? 'card' : 'manual'}</Badge>
          </span>
        ) : (
          <span className="font-medium text-muted-foreground">—</span>
        )}
        <span className="flex gap-1">
          {canAssign && (
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setOpen(true)}>
              <IdCardIcon /> {o.driverName ? 'Change' : 'Assign'}
            </Button>
          )}
          {canAssign && o.driverName && (
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => assign.mutate(null)} disabled={assign.isPending} aria-label="Remove driver">
              <UserRoundXIcon />
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setSessions(true)}>
            <ListIcon /> Sessions
          </Button>
        </span>
      </span>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Driver for {o.name}</DialogTitle>
            <DialogDescription>Starts a driver session now. A driver already on another vehicle is moved here.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field label="Driver" htmlFor="assign-driver">
              <Combobox id="assign-driver" value={driverId} onChange={setDriverId} options={drivers.options} loading={drivers.loading} onSearch={setQ} placeholder="Search name or employee ID…" />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => assign.mutate(driverId)} disabled={!driverId || assign.isPending}>
              {assign.isPending && <Spinner />} Assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DriverSessionsSheet target={sessions ? { objectId: o.objectId, label: o.name } : null} onClose={() => setSessions(false)} />
    </div>
  );
}
