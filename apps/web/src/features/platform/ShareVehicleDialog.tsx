import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CompanyDto, Paginated, VehicleShareDto } from '@veetracer/shared';
import { SearchIcon, Share2Icon, Trash2Icon } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useMe } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

type Item = { id: string; name: string; companyId: string | null };

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const when = (iso: string) => dateTime.format(Date.parse(iso));

/** Super Admin: which other companies see this vehicle (view only), and sharing it with one more. */
function ShareVehicleDialog({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const query = useDeferredValue(q);
  const [target, setTarget] = useState<CompanyDto | null>(null);
  const [alertsOn, setAlertsOn] = useState(false);
  const [end, setEnd] = useState('');
  const key = ['vehicle-shares', item?.id];
  const shares = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.get<VehicleShareDto[]>('/admin/vehicle-shares', { objectId: item!.id }, signal),
    enabled: !!item,
  });
  const companies = useQuery({
    queryKey: ['transfer-companies', query],
    queryFn: ({ signal }) => api.get<Paginated<CompanyDto>>('/admin/companies', { q: query, pageSize: 50, sort: 'name', order: 'asc' }, signal),
    enabled: !!item,
  });
  const done = (message: string) => {
    void qc.invalidateQueries({ queryKey: key });
    toast.success(message);
  };
  const add = useMutation({
    mutationFn: () => api.post<VehicleShareDto>('/admin/vehicle-shares', { objectId: item!.id, companyId: target!.id, alertsOn, endAt: end ? new Date(end).toISOString() : null }),
    onSuccess: (r) => {
      setTarget(null);
      setAlertsOn(false);
      setEnd('');
      done(t('Shared with {{company}}', { company: r.sharedWithName }));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const setAlerts = useMutation({
    mutationFn: (v: { id: string; alertsOn: boolean }) => api.patch<VehicleShareDto>(`/admin/vehicle-shares/${v.id}`, { alertsOn: v.alertsOn }),
    onSuccess: () => done(t('Saved')),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/vehicle-shares/${id}`),
    onSuccess: () => done(t('Sharing removed')),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const close = () => {
    setQ('');
    setTarget(null);
    setAlertsOn(false);
    setEnd('');
    onClose();
  };
  const now = Date.now();
  const taken = new Set((shares.data ?? []).filter((s) => !s.endAt || Date.parse(s.endAt) > now).map((s) => s.sharedWithId));

  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && !add.isPending && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2Icon className="size-5 text-primary" /> {t('Share vehicle with another company')}
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{item?.name}</span> · {t('The other company sees it on the live map, in history and in reports, view only, and nothing from before the share. This company keeps the vehicle, its device and its licence.')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {!!shares.data?.length && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">{t('Shared with')}</h3>
              {shares.data.map((s) => {
                const ended = !!s.endAt && Date.parse(s.endAt) <= now;
                return (
                  <div key={s.id} className="rounded-md border p-2.5 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{s.sharedWithName}</span>
                        <span className="block text-xs text-muted-foreground">
                          {t('Since {{time}}', { time: when(s.startAt) })}
                          {s.endAt ? ` · ${ended ? t('Ended {{time}}', { time: when(s.endAt) }) : t('Until {{time}}', { time: when(s.endAt) })}` : ''}
                        </span>
                      </span>
                      <Button variant="ghost" size="icon-sm" aria-label={t('Remove sharing with {{company}}', { company: s.sharedWithName })} disabled={remove.isPending} onClick={() => remove.mutate(s.id)}>
                        <Trash2Icon />
                      </Button>
                    </div>
                    <label className="mt-2 flex items-center justify-between gap-3 text-xs">
                      {t('They also see its alerts')}
                      <Switch checked={s.alertsOn} disabled={setAlerts.isPending || ended} onCheckedChange={(v) => setAlerts.mutate({ id: s.id, alertsOn: v })} />
                    </label>
                  </div>
                );
              })}
            </div>
          )}
          <div className="rounded-md border">
            <div className="flex items-center gap-2 border-b px-3">
              <SearchIcon className="size-4 text-muted-foreground" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search companies…')} aria-label={t('Search companies')} className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
              {companies.isFetching && <Spinner className="text-muted-foreground" />}
            </div>
            <ul className="max-h-44 overflow-y-auto p-1" role="listbox" aria-label={t('Company to share with')}>
              {companies.data?.items
                .filter((c) => c.id !== item?.companyId && !taken.has(c.id))
                .map((c) => (
                  <li key={c.id} role="option" aria-selected={target?.id === c.id}>
                    <button type="button" onClick={() => setTarget(c)} className={cn('w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent', target?.id === c.id && 'bg-accent font-medium')}>
                      {c.name}
                    </button>
                  </li>
                ))}
            </ul>
          </div>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              <span className="block font-medium">{t('They also see its alerts')}</span>
              <span className="block text-xs text-muted-foreground">{t('In their alert list and bell. Acknowledging stays with this company.')}</span>
            </span>
            <Switch checked={alertsOn} onCheckedChange={setAlertsOn} />
          </label>
          <Field label={t('End (optional)')} htmlFor="share-end" hint={t('Leave empty to share until you remove it.')}>
            <Input id="share-end" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={add.isPending}>
            {t('Close')}
          </Button>
          <Button onClick={() => add.mutate()} disabled={!target || add.isPending}>
            {add.isPending ? <Spinner /> : <Share2Icon />} {target ? t('Share with {{company}}', { company: target.name }) : t('Choose a company')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Super Admin "Share with company…" row action + its dialog (same pattern as useTransferAction). */
export function useShareVehicleAction() {
  const { t } = useTranslation();
  const me = useMe();
  const [item, setItem] = useState<Item | null>(null);
  const isSuperAdmin = !!me?.user.isSuperAdmin;
  return {
    item: (row: Item) =>
      isSuperAdmin ? (
        <DropdownMenuItem key="share" onSelect={() => setItem(row)}>
          <Share2Icon /> {t('Share with company…')}
        </DropdownMenuItem>
      ) : null,
    dialog: isSuperAdmin ? <ShareVehicleDialog item={item} onClose={() => setItem(null)} /> : null,
  };
}
