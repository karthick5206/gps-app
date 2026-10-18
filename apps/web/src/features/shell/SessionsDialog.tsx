import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionDto } from '@veetracer/shared';
import { LaptopIcon, LogOutIcon, SmartphoneIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

/** "Chrome on Windows"-style label from a user-agent string. */
export function deviceLabel(ua: string | null): { label: string; mobile: boolean } {
  if (!ua) return { label: 'Unknown device', mobile: false };
  const mobile = /Android|iPhone|iPad|Mobile/i.test(ua);
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : /Dart|okhttp/i.test(ua)
              ? 'VeeTracer app'
              : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  return { label: os ? `${browser} on ${os}` : browser, mobile };
}

const KEY = ['auth-sessions'] as const;

/** Where the user is signed in, with sign-out per device or everywhere else. */
export function SessionsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient();
  const sessions = useQuery({ queryKey: KEY, queryFn: ({ signal }) => api.get<SessionDto[]>('/auth/sessions', undefined, signal), enabled: open });
  const end = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/sessions/${id}`),
    onSuccess: () => {
      toast.success('Signed out that device');
      queryClient.invalidateQueries({ queryKey: KEY });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const endOthers = useMutation({
    mutationFn: () => api.post<{ count: number }>('/auth/sessions/revoke-others'),
    onSuccess: (r) => {
      toast.success(r.count ? `Signed out ${r.count} other device${r.count === 1 ? '' : 's'}` : 'No other devices were signed in');
      queryClient.invalidateQueries({ queryKey: KEY });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const others = sessions.data?.filter((s) => !s.current).length ?? 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Signed-in devices</DialogTitle>
          <DialogDescription>Browsers and apps where your account is signed in. Signing a device out takes effect immediately.</DialogDescription>
        </DialogHeader>
        <DialogBody className="max-h-[60vh] space-y-2 overflow-y-auto">
          {sessions.isLoading && <Skeleton className="h-24" />}
          {sessions.isError && <p className="text-sm text-destructive">{errorMessage(sessions.error)}</p>}
          {sessions.data?.map((s) => {
            const d = deviceLabel(s.userAgent);
            const Icon = d.mobile ? SmartphoneIcon : LaptopIcon;
            return (
              <div key={s.id} className="flex items-center gap-3 rounded-lg border p-3">
                <Icon className="size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {d.label}
                    {s.current && <Badge variant="success">This device</Badge>}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {s.ip ?? 'Unknown IP'} · signed in {formatDateTime(s.createdAt)}
                  </p>
                </div>
                {!s.current && (
                  <Button size="sm" variant="outline" onClick={() => end.mutate(s.id)} disabled={end.isPending} aria-label={`Sign out ${d.label}`}>
                    <LogOutIcon /> Sign out
                  </Button>
                )}
              </div>
            );
          })}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button variant="destructive" onClick={() => endOthers.mutate()} disabled={!others || endOthers.isPending}>
            {endOthers.isPending && <Spinner />} Sign out all other devices
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
