import { useMutation, useQuery } from '@tanstack/react-query';
import { SIM_STATUS_LABELS, type Paginated, type SimAssignmentDto, type SimCardDto, type SimEventDto, type SimUsageDto } from '@veetracer/shared';
import { CalendarClockIcon, CpuIcon, ListChecksIcon, ReceiptIndianRupeeIcon, TriangleAlertIcon, UnplugIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import { daysLeft, formatRupees, renewalText } from '@/features/inventory/inventory-format';
import { InfoRow } from '@/features/inventory/shared';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { RenewalBadge, SimStatusBadge, useInvalidateSims } from './sim-shared';

export type SimAction = 'status' | 'assign' | 'renew' | 'usage';

const EVENT_LABELS: Record<SimEventDto['kind'], string> = {
  REGISTER: 'Registered',
  STATUS: 'Status change',
  ASSIGN: 'Fitted to device',
  UNASSIGN: 'Taken out of device',
  RENEW: 'Renewed',
  EDIT: 'Edited',
  USAGE: 'Usage entry',
};

export function SimDetailSheet({ simId, onClose, onAction }: { simId: string | null; onClose: () => void; onAction: (a: SimAction, sim: SimCardDto) => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const invalidate = useInvalidateSims();
  const sim = useQuery({ queryKey: ['sims', 'one', simId], queryFn: () => api.get<SimCardDto>(`/sims/${simId}`), enabled: !!simId });
  const events = useQuery({ queryKey: ['sims', 'events', simId], queryFn: () => api.get<Paginated<SimEventDto>>('/sims/events', { simId, pageSize: 100 }), enabled: !!simId });
  const assignments = useQuery({ queryKey: ['sims', 'assignments', simId], queryFn: () => api.get<SimAssignmentDto[]>(`/sims/${simId}/assignments`), enabled: !!simId });
  const usage = useQuery({ queryKey: ['sims', 'usage', simId], queryFn: () => api.get<SimUsageDto[]>(`/sims/${simId}/usage`), enabled: !!simId });
  const unassign = useMutation({
    mutationFn: () => api.post<SimCardDto>(`/sims/${simId}/unassign`, {}),
    onSuccess: () => {
      toast.success(t('SIM taken out of the device'));
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const s = sim.data;
  const canEdit = can('sa_sim_cards', 'edit');
  const totalCost = (usage.data ?? []).reduce((a, u) => a + (u.costPaise ?? 0), 0);
  return (
    <Sheet open={!!simId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="font-mono">{s?.iccid ?? t('SIM')}</SheetTitle>
          <SheetDescription>{s ? [s.msisdn ? `+${s.msisdn}` : null, s.provider.name, s.plan?.name].filter(Boolean).join(' · ') : t('Loading…')}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {!s ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <SimStatusBadge status={s.status} />
                {s.reconcile.map((f) => (
                  <Badge key={f} variant="warning">
                    <TriangleAlertIcon /> {f === 'ICCID_DIFFERS' ? t('Tracker reports another ICCID') : t('Device SIM number differs')}
                  </Badge>
                ))}
              </div>
              {canEdit && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => onAction('status', s)}>
                    <ListChecksIcon /> {t('Change status')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onAction('assign', s)}>
                    <CpuIcon /> {s.device ? t('Move to device') : t('Fit to device')}
                  </Button>
                  {s.device && (
                    <Button size="sm" variant="outline" onClick={() => unassign.mutate()} disabled={unassign.isPending}>
                      <UnplugIcon /> {t('Take out')}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => onAction('renew', s)}>
                    <CalendarClockIcon /> {t('Renew')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onAction('usage', s)}>
                    <ReceiptIndianRupeeIcon /> {t('Add usage')}
                  </Button>
                </div>
              )}
              <dl className="divide-y">
                <InfoRow label="Device">{s.device ? `${s.device.uniqueId}${s.device.companyName ? ` · ${s.device.companyName}` : ''}` : '—'}</InfoRow>
                {s.device && <InfoRow label="Tracker ICCID">{s.device.reportedIccid ?? '—'}</InfoRow>}
                {s.device && <InfoRow label="Device SIM no.">{s.device.simNumber ?? '—'}</InfoRow>}
                <InfoRow label="Renewal due">
                  <span className="inline-flex items-center gap-2">
                    <RenewalBadge state={s.renewalState} date={s.renewalDueAt} />
                    <span className="text-xs text-muted-foreground">{t(renewalText(daysLeft(s.renewalDueAt)))}</span>
                  </span>
                </InfoRow>
                <InfoRow label="Activated">{s.activatedAt ? formatDateTime(s.activatedAt) : '—'}</InfoRow>
                <InfoRow label="Plan cost">{s.plan ? `${formatRupees(s.plan.costPaise)} / ${s.plan.validityDays} ${t('days')}` : '—'}</InfoRow>
                <InfoRow label="Ownership">{t(s.ownership === 'CUSTOMER' ? 'Customer (BYO)' : s.ownership.charAt(0) + s.ownership.slice(1).toLowerCase())}</InfoRow>
                <InfoRow label="Location">{s.location ? `${s.location.code} · ${s.location.name}` : '—'}</InfoRow>
                <InfoRow label="IMSI">{s.imsi ?? '—'}</InfoRow>
                {s.note && <InfoRow label="Note">{s.note}</InfoRow>}
              </dl>
            </>
          )}
          <section>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t('Device history')}</h3>
            {!assignments.data?.length ? (
              <p className="text-sm text-muted-foreground">{t('Never fitted to a device.')}</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {assignments.data.map((a) => (
                  <li key={a.id} className="flex flex-wrap justify-between gap-2">
                    <span className="font-mono text-xs">{a.deviceRef}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(a.fromTime)} → {a.toTime ? formatDateTime(a.toTime) : t('now')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3 className="mb-2 flex items-center justify-between text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              <span>{t('Usage & cost entries')}</span>
              {totalCost > 0 && <span className="normal-case">{t('Total {{c}}', { c: formatRupees(totalCost) })}</span>}
            </h3>
            {!usage.data?.length ? (
              <p className="text-sm text-muted-foreground">{t('No entries yet.')}</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-1 font-medium">{t('Period')}</th>
                    <th className="py-1 font-medium">{t('Data')}</th>
                    <th className="py-1 font-medium">{t('SMS')}</th>
                    <th className="py-1 text-right font-medium">{t('Cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.data.map((u) => (
                    <tr key={u.id} className="border-t">
                      <td className="py-1">
                        {u.periodStart} → {u.periodEnd}
                      </td>
                      <td className="py-1 tabular-nums">{u.dataMb ?? '—'} MB</td>
                      <td className="py-1 tabular-nums">{u.smsCount ?? '—'}</td>
                      <td className="py-1 text-right tabular-nums">{formatRupees(u.costPaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t('History')}</h3>
            {!events.data?.items.length ? (
              <p className="text-sm text-muted-foreground">{t('No history yet.')}</p>
            ) : (
              <ol className="relative space-y-3 border-l pl-4">
                {events.data.items.map((e) => (
                  <li key={e.id} className="relative">
                    <span className="absolute top-1.5 -left-[21px] size-2.5 rounded-full bg-primary ring-4 ring-card" aria-hidden />
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{t(EVENT_LABELS[e.kind])}</span>
                      {e.fromStatus && e.toStatus && e.fromStatus !== e.toStatus && (
                        <span className="text-xs text-muted-foreground">
                          {t(SIM_STATUS_LABELS[e.fromStatus])} → {t(SIM_STATUS_LABELS[e.toStatus])}
                        </span>
                      )}
                      {e.deviceRef && <span className="font-mono text-xs text-muted-foreground">{e.deviceRef}</span>}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(e.at)}
                      {e.createdByName ? ` · ${e.createdByName}` : ''}
                    </p>
                    {(e.reason || e.note) && <p className="text-xs">{[e.reason, e.note].filter(Boolean).join(' · ')}</p>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
