import { useMutation, useQuery } from '@tanstack/react-query';
import { INVENTORY_STATUS_LABELS, statusHoldsLocation, type DeviceStockDto, type Paginated, type StockMovementDto } from '@veetracer/shared';
import { ArrowRightLeftIcon, ListChecksIcon, RefreshCwIcon, ReplaceIcon, ShieldCheckIcon, SlidersHorizontalIcon, TriangleAlertIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { formatRupees } from './inventory-format';
import { InfoRow, LicenceBadge, MOVEMENT_KIND_COLOR, MOVEMENT_KIND_LABELS, StockStatusBadge, useInvalidateInventory } from './shared';

export type StockAction = 'status' | 'transfer' | 'adjust' | 'replace';

/** Device stock drawer: facts, read-only licence / assignment, actions and the movement history. */
export function StockDetailSheet({ deviceId, onClose, onAction }: { deviceId: string | null; onClose: () => void; onAction: (a: StockAction, row: DeviceStockDto) => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const invalidate = useInvalidateInventory();
  const stock = useQuery({
    queryKey: ['inventory', 'stock', deviceId],
    queryFn: () => api.get<DeviceStockDto>(`/inventory/stock/${deviceId}`),
    enabled: !!deviceId,
  });
  const moves = useQuery({
    queryKey: ['inventory', 'movements', deviceId],
    queryFn: () => api.get<Paginated<StockMovementDto>>(`/inventory/stock/${deviceId}/movements`, { pageSize: 100 }),
    enabled: !!deviceId,
  });
  const sync = useMutation({
    mutationFn: () => api.post<DeviceStockDto>(`/inventory/stock/${deviceId}/sync`, {}),
    onSuccess: () => {
      toast.success(t('Status aligned with the assignment'));
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const row = stock.data;
  const canEdit = can('sa_inventory', 'edit');
  return (
    <Sheet open={!!deviceId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="font-mono">{row?.uniqueId ?? t('Device')}</SheetTitle>
          <SheetDescription>{row ? `${row.modelName}${row.serialNumber ? ` · S/N ${row.serialNumber}` : ''}` : t('Loading…')}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {!row ? (
            <div className="space-y-2">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StockStatusBadge status={row.status} />
                {row.mismatch && (
                  <Badge variant="warning">
                    <TriangleAlertIcon /> {t('Assignment says {{s}}', { s: t(INVENTORY_STATUS_LABELS[row.derivedStatus]) })}
                  </Badge>
                )}
                {!row.deviceActive && <Badge variant="muted">{t('Deactivated')}</Badge>}
              </div>
              {canEdit && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => onAction('status', row)}>
                    <ListChecksIcon /> {t('Change status')}
                  </Button>
                  {statusHoldsLocation(row.status) && (
                    <Button size="sm" variant="outline" onClick={() => onAction('transfer', row)}>
                      <ArrowRightLeftIcon /> {t('Transfer')}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => onAction('adjust', row)}>
                    <SlidersHorizontalIcon /> {t('Adjust')}
                  </Button>
                  {row.object && (
                    <Button size="sm" variant="outline" onClick={() => onAction('replace', row)}>
                      <ReplaceIcon /> {t('Replace on vehicle')}
                    </Button>
                  )}
                  {row.mismatch && (
                    <Button size="sm" onClick={() => sync.mutate()} disabled={sync.isPending}>
                      <RefreshCwIcon /> {t('Sync with assignment')}
                    </Button>
                  )}
                </div>
              )}
              <section>
                <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t('Stock')}</h3>
                <dl className="divide-y">
                  <InfoRow label="Location">{row.location ? `${row.location.code} · ${row.location.name}` : <span className="text-muted-foreground">{t('At customer')}</span>}</InfoRow>
                  {row.holderPartner && <InfoRow label="Held by partner">{row.holderPartner.name}</InfoRow>}
                  <InfoRow label="Supplier">{row.supplierName ?? '—'}</InfoRow>
                  <InfoRow label="Unit cost">{formatRupees(row.unitCostPaise)}</InfoRow>
                  <InfoRow label="Warranty until">{row.warrantyUntil ?? '—'}</InfoRow>
                  <InfoRow label="Condition">{row.condition ? t(row.condition.charAt(0) + row.condition.slice(1).toLowerCase()) : '—'}</InfoRow>
                  <InfoRow label="Status since">{formatDateTime(row.statusChangedAt)}</InfoRow>
                  {row.note && <InfoRow label="Note">{row.note}</InfoRow>}
                </dl>
              </section>
              <section>
                <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  <ShieldCheckIcon className="size-3.5" /> {t('Assignment & licence (read-only)')}
                </h3>
                <dl className="divide-y">
                  <InfoRow label="Customer">{row.company?.name ?? <span className="text-muted-foreground">{t('Platform stock')}</span>}</InfoRow>
                  <InfoRow label="Vehicle">{row.object?.name ?? '—'}</InfoRow>
                  <InfoRow label="Licence">
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <LicenceBadge licence={row.licence} />
                      {row.licence.type && <span className="text-xs text-muted-foreground">{row.licence.type}</span>}
                      {row.licence.expiresAt && <span className="text-xs text-muted-foreground">{t('until {{d}}', { d: row.licence.expiresAt.slice(0, 10) })}</span>}
                    </span>
                  </InfoRow>
                </dl>
                <p className="mt-1 text-xs text-muted-foreground">{t('Customer, vehicle and licence change only in Device Inventory, the vehicle form, Transfer or Claim. Inventory actions never change a licence seat.')}</p>
              </section>
            </>
          )}
          <section>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t('Movement history')}</h3>
            {moves.isPending ? (
              <Skeleton className="h-24 w-full" />
            ) : !moves.data?.items.length ? (
              <p className="text-sm text-muted-foreground">{t('No movements yet.')}</p>
            ) : (
              <ol className="relative space-y-3 border-l pl-4">
                {moves.data.items.map((m) => (
                  <li key={m.id} className="relative">
                    <span className="absolute top-1.5 -left-[21px] size-2.5 rounded-full ring-4 ring-card" style={{ backgroundColor: MOVEMENT_KIND_COLOR[m.kind] }} aria-hidden />
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      <span className="font-medium">{t(MOVEMENT_KIND_LABELS[m.kind])}</span>
                      {m.fromStatus && m.fromStatus !== m.toStatus && (
                        <>
                          <StockStatusBadge status={m.fromStatus} />
                          <span className="text-muted-foreground">→</span>
                        </>
                      )}
                      <StockStatusBadge status={m.toStatus} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(m.at)}
                      {m.createdByName ? ` · ${m.createdByName}` : ''}
                      {(m.fromLocation || m.toLocation) && m.fromLocation?.id !== m.toLocation?.id ? ` · ${m.fromLocation?.code ?? '—'} → ${m.toLocation?.code ?? '—'}` : ''}
                      {m.objectName ? ` · ${m.objectName}` : ''}
                    </p>
                    {(m.reason || m.reference || m.note) && (
                      <p className="mt-0.5 text-xs">
                        {m.reason && <span>{m.reason}</span>}
                        {m.reference && <span className="ml-1 font-mono text-muted-foreground">[{m.reference}]</span>}
                        {m.note && <span className="ml-1 text-muted-foreground">{m.note}</span>}
                      </p>
                    )}
                    {m.changes && (
                      <ul className="mt-0.5 text-xs text-muted-foreground">
                        {Object.entries(m.changes).map(([k, v]) => (
                          <li key={k}>
                            {k}: {String(v.from ?? '—')} → {String(v.to ?? '—')}
                          </li>
                        ))}
                      </ul>
                    )}
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
