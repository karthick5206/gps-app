import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CompanyDto, Paginated, TransferKind, TransferResult } from '@veetracer/shared';
import { ArrowRightLeftIcon, SearchIcon } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { useMe } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

const WHAT: Record<TransferKind, { title: string; note: string }> = {
  object: {
    title: 'Move vehicle to another company',
    note: 'Its devices move with it, each with its paid licence (same expiry). Groups, branch, user access and the current driver of the old company are removed.',
  },
  device: {
    title: 'Move device to another company',
    note: 'The device leaves the vehicle it is fitted to (the vehicle stays). Its paid licence (same expiry), sensor settings and phone codes move with it.',
  },
  driver: {
    title: 'Move driver to another company',
    note: 'The driver and their documents move. Current vehicle assignments in the old company end; past ones stay there.',
  },
};

/** Super Admin: pick the target company (and, for a vehicle, with or without its history), then move. */
function TransferDialog({
  kind,
  item,
  onClose,
}: {
  kind: TransferKind;
  item: { id: string; name: string; companyId: string | null } | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const query = useDeferredValue(q);
  const [target, setTarget] = useState<CompanyDto | null>(null);
  const [withHistory, setWithHistory] = useState(true);
  const companies = useQuery({
    queryKey: ['transfer-companies', query],
    queryFn: ({ signal }) => api.get<Paginated<CompanyDto>>('/admin/companies', { q: query, pageSize: 50, sort: 'name', order: 'asc' }, signal),
    enabled: !!item,
  });
  const move = useMutation({
    mutationFn: () =>
      api.post<TransferResult>(`/admin/transfer/${kind}/${item!.id}`, {
        targetCompanyId: target!.id,
        ...(kind === 'object' ? { withHistory } : {}),
      }),
    onSuccess: (r) => {
      toast.success(t('Moved to {{company}}.', { company: r.companyName }));
      void queryClient.invalidateQueries();
      close();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const close = () => {
    setQ('');
    setTarget(null);
    setWithHistory(true);
    onClose();
  };

  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && !move.isPending && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeftIcon className="size-5 text-primary" /> {t(WHAT[kind].title)}
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{item?.name}</span> · {t(WHAT[kind].note)}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="rounded-md border">
            <div className="flex items-center gap-2 border-b px-3">
              <SearchIcon className="size-4 text-muted-foreground" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('Search companies…')}
                aria-label={t('Search companies')}
                className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              {companies.isFetching && <Spinner className="text-muted-foreground" />}
            </div>
            <ul className="max-h-56 overflow-y-auto p-1" role="listbox" aria-label={t('Target company')}>
              {companies.data?.items
                .filter((c) => c.id !== item?.companyId)
                .map((c) => (
                  <li key={c.id} role="option" aria-selected={target?.id === c.id}>
                    <button
                      type="button"
                      onClick={() => setTarget(c)}
                      className={cn('w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent', target?.id === c.id && 'bg-accent font-medium')}
                    >
                      {c.name} <span className="text-xs text-muted-foreground">· {t('{{count}} objects', { count: c.objectCount })}</span>
                    </button>
                  </li>
                ))}
            </ul>
          </div>
          {kind === 'object' && (
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium">{t('History (trips, positions, alerts, reports)')}</legend>
              {[
                {
                  v: true,
                  label: t('Move with history'),
                  hint: t('The new company sees all past trips and positions of this vehicle.'),
                },
                {
                  v: false,
                  label: t('Start fresh'),
                  hint: t('The new company starts today; the old company keeps the past (the vehicle is archived there).'),
                },
              ].map((o) => (
                <label
                  key={String(o.v)}
                  className={cn('flex cursor-pointer gap-3 rounded-md border p-2.5', withHistory === o.v && 'border-primary bg-primary/5')}
                >
                  <input type="radio" name="history" className="mt-1" checked={withHistory === o.v} onChange={() => setWithHistory(o.v)} />
                  <span>
                    <span className="block text-sm font-medium">{o.label}</span>
                    <span className="block text-xs text-muted-foreground">{o.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={move.isPending}>
            {t('Cancel')}
          </Button>
          <Button onClick={() => move.mutate()} disabled={!target || move.isPending}>
            {move.isPending ? <Spinner /> : <ArrowRightLeftIcon />} {target ? t('Move to {{company}}', { company: target.name }) : t('Choose a company')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Super Admin "Move to company…" row action + its dialog (same pattern as usePurgeAction). */
export function useTransferAction(kind: TransferKind) {
  const { t } = useTranslation();
  const me = useMe();
  const [item, setItem] = useState<{
    id: string;
    name: string;
    companyId: string | null;
  } | null>(null);
  const isSuperAdmin = !!me?.user.isSuperAdmin;
  return {
    item: (row: { id: string; name: string; companyId: string | null }) =>
      isSuperAdmin ? (
        <DropdownMenuItem key="transfer" onSelect={() => setItem(row)}>
          <ArrowRightLeftIcon /> {t('Move to company…')}
        </DropdownMenuItem>
      ) : null,
    dialog: isSuperAdmin ? <TransferDialog kind={kind} item={item} onClose={() => setItem(null)} /> : null,
  };
}
