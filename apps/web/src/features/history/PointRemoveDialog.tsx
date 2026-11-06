import type { PointRemoveResult } from '@veetracer/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { PointPick } from './history-map';

/**
 * Super Admin: remove one stored point from History, trips, distance and reports (e.g. a Wi-Fi spike kilometres off),
 * or restore a removed one. The point stays in the database with who, when and why, so nothing is lost.
 */
export function PointRemoveDialog({ objectId, pick, onClose }: { objectId: string; pick: PointPick | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const removed = pick?.label === 'removed';
  const run = useMutation({
    mutationFn: () => api.post<PointRemoveResult>(`/objects/${objectId}/points/${removed ? 'restore' : 'remove'}`, { t: pick!.t, reason: reason.trim() || undefined }),
    onSuccess: (r) => {
      toast.success(r.removed ? t('Point removed. Trips and distance for that day are being recalculated.') : t('Point restored.'));
      void qc.invalidateQueries({ queryKey: ['history'] });
      void qc.invalidateQueries({ queryKey: ['point-quality'] });
      setReason('');
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog
      open={!!pick}
      onOpenChange={(o) => {
        if (!o) {
          setReason('');
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{removed ? t('Restore this point?') : t('Remove this point?')}</DialogTitle>
          <DialogDescription>
            {removed
              ? t('It comes back into History, trips, distance and reports.')
              : t('It will be left out of History, trips, distance and reports. It stays saved with your name and reason, so it can be restored.')}
          </DialogDescription>
        </DialogHeader>
        {pick && (
          <DialogBody className="space-y-3 text-sm">
            <div className="rounded-md border bg-muted/40 p-3 leading-relaxed">
              <div className="font-semibold">{formatDateTime(new Date(pick.t).toISOString())}</div>
              <div>
                {Math.round(pick.speed)} km/h{pick.acc !== null && pick.acc >= 0 ? ` · ±${pick.acc} m` : ''}
              </div>
              <div className="text-muted-foreground">
                {pick.lat.toFixed(5)}, {pick.lng.toFixed(5)}
              </div>
            </div>
            {!pick.stored && <p className="text-warning">{t('This is a raw phone record, not a stored point, so it is already left out.')}</p>}
            {!removed && pick.stored && (
              <label className="block space-y-1">
                <span className="font-medium">{t('Reason')}</span>
                <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder={t('e.g. Wi-Fi location 2.5 km off')} autoFocus />
              </label>
            )}
          </DialogBody>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Cancel')}
          </Button>
          {pick?.stored && (
            <Button variant={removed ? 'default' : 'destructive'} disabled={run.isPending || (!removed && !reason.trim())} onClick={() => run.mutate()}>
              {removed ? t('Restore point') : t('Remove point')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
