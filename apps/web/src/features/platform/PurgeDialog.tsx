import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PurgePreviewDto } from '@veetracer/shared';
import { Trash2Icon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useMe } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';

export type PurgeKind = PurgePreviewDto['kind'];

/**
 * Super Admin "Delete permanently": shows what goes (rows per table), asks to type the IMEI / name / e-mail, then
 * removes the item with all its history. Cannot be undone (only the backups can bring it back).
 */
function PurgeDialog({ kind, id, onClose }: { kind: PurgeKind; id: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState('');
  const preview = useQuery({
    queryKey: ['purge-preview', kind, id],
    queryFn: ({ signal }) => api.get<PurgePreviewDto>(`/admin/purge/${kind}/${id}`, undefined, signal),
    enabled: !!id,
    gcTime: 0,
  });
  const purge = useMutation({
    mutationFn: () => api.post<{ ok: true; deletedRows: number }>(`/admin/purge/${kind}/${id}`, { confirm: typed }),
    onSuccess: (r) => {
      toast.success(t('Deleted permanently ({{n}} rows).', { n: r.deletedRows.toLocaleString() }));
      void queryClient.invalidateQueries();
      close();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const close = () => {
    setTyped('');
    onClose();
  };
  const p = preview.data;
  const matches = !!p && typed.trim().toLowerCase() === p.confirm.trim().toLowerCase();

  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && !purge.isPending && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <TriangleAlertIcon className="size-5" /> {t('Delete permanently?')}
          </DialogTitle>
          <DialogDescription>{t('This removes the item and all its history. It cannot be undone; only a database backup can bring it back.')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {preview.isPending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> {t('Counting what will be deleted…')}
            </p>
          )}
          {preview.isError && <p className="text-sm text-destructive">{errorMessage(preview.error)}</p>}
          {p && (
            <>
              <p className="text-sm font-medium">{p.label}</p>
              <div className="max-h-48 overflow-y-auto rounded-md border text-sm">
                <table className="w-full">
                  <tbody>
                    {p.tables.map((r) => (
                      <tr key={r.table} className="border-b last:border-0">
                        <td className="px-3 py-1.5 text-muted-foreground">{r.table}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.rows.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-sm">
                {t('{{n}} rows in total.', { n: p.totalRows.toLocaleString() })} {t('Type {{text}} to confirm.', { text: p.confirm })}
              </p>
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={p.confirm} aria-label={t('Confirmation')} autoComplete="off" />
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={purge.isPending}>
            {t('Cancel')}
          </Button>
          <Button type="button" variant="destructive" disabled={!matches || purge.isPending} onClick={() => purge.mutate()}>
            {purge.isPending ? <Spinner /> : <Trash2Icon />} {t('Delete permanently')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Row-menu item + dialog for list pages. Renders nothing for users who aren't Super Admin. */
export function usePurgeAction(kind: PurgeKind) {
  const { t } = useTranslation();
  const me = useMe();
  const [id, setId] = useState<string | null>(null);
  const isSuperAdmin = !!me?.user.isSuperAdmin;
  return {
    item: (rowId: string) =>
      isSuperAdmin ? (
        <DropdownMenuItem key="purge" className="text-destructive focus:text-destructive" onSelect={() => setId(rowId)}>
          <Trash2Icon /> {t('Delete permanently')}
        </DropdownMenuItem>
      ) : null,
    dialog: isSuperAdmin ? <PurgeDialog kind={kind} id={id} onClose={() => setId(null)} /> : null,
  };
}
