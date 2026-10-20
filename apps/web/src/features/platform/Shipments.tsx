import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeviceDto } from '@veetracer/shared';
import { FileDownIcon, TruckIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, downloadFile, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

export interface ShipmentRow {
  deviceId: string;
  uniqueId: string;
  modelName: string;
  claimCode: string | null;
  reservedName: string | null;
  reservedEmail: string | null;
  reservedMobile: string | null;
  shipmentNote: string | null;
  shippedAt: string | null;
  claimedAt: string | null;
  companyName: string | null;
  lastSeenAt: string | null;
}

const KEY = ['admin-shipments'];
const helpSheet = (ids: string[], name: string) => downloadFile(`/admin/shipments/help-sheet/pdf?ids=${ids.join(',')}`, name);

/** Device Inventory → "Ship to customer": reserve a stock device for one customer and print the help sheet for the box. */
export function ShipDialog({ device, onOpenChange }: { device: DeviceDto | null; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [v, setV] = useState({ name: '', email: '', mobile: '', note: '' });
  const ship = useMutation({
    mutationFn: () => api.post<ShipmentRow>(`/admin/shipments/${device!.id}`, { name: v.name.trim(), email: v.email.trim() || null, mobile: v.mobile.trim() || null, note: v.note.trim() || null }),
    onSuccess: async (row) => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      toast.success(t('Reserved for {{name}}. Claim code {{code}}.', { name: row.reservedName, code: row.claimCode }));
      onOpenChange(false);
      setV({ name: '', email: '', mobile: '', note: '' });
      await helpSheet([row.deviceId], `VeeTrax-help-${row.uniqueId}.pdf`).catch((e) => toast.error(errorMessage(e)));
    },
  });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: e.target.value }));
  return (
    <Dialog open={!!device} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            ship.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('Ship to customer')}</DialogTitle>
            <DialogDescription>{t('Reserves {{imei}} for this customer and prints the help sheet with its claim code and QR. Only they can add it to their account.', { imei: device?.uniqueId ?? '' })}</DialogDescription>
          </DialogHeader>
          <FormError message={ship.isError ? errorMessage(ship.error) : null} />
          <Field label={t('Customer name')} htmlFor="sh-name">
            <Input id="sh-name" value={v.name} onChange={set('name')} required minLength={2} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('Mobile')} htmlFor="sh-mobile">
              <Input id="sh-mobile" type="tel" placeholder="98765 43210" value={v.mobile} onChange={set('mobile')} />
            </Field>
            <Field label={t('Email')} htmlFor="sh-email">
              <Input id="sh-email" type="email" value={v.email} onChange={set('email')} />
            </Field>
          </div>
          <Field label={t('Courier / order note')} htmlFor="sh-note" hint={t('Printed at the bottom of the sheet, e.g. DTDC D12345678 · order 1024')}>
            <Input id="sh-note" value={v.note} onChange={set('note')} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={ship.isPending}>
              {ship.isPending ? <Spinner /> : <TruckIcon />}
              {t('Reserve and print')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function status(r: ShipmentRow, t: (k: string) => string) {
  if (r.claimedAt && r.lastSeenAt) return <Badge variant="success">{t('Live')}</Badge>;
  if (r.claimedAt) return <Badge variant="warning">{t('Claimed, no data yet')}</Badge>;
  const days = r.shippedAt ? (Date.now() - Date.parse(r.shippedAt)) / 86_400_000 : 0;
  return <Badge variant={days > 7 ? 'destructive' : 'muted'}>{days > 7 ? t('Not claimed > 7 days') : t('Shipped')}</Badge>;
}

/** Device Inventory → "Shipments": who each shipped device is for, claim status, reprint / cancel. */
export function ShipmentsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: ({ signal }) => api.get<ShipmentRow[]>('/admin/shipments', undefined, signal), enabled: open });
  const cancel = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/shipments/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-4xl">
        <SheetHeader>
          <SheetTitle>{t('Shipments')}</SheetTitle>
          <SheetDescription>{t('Devices reserved for customers: shipped → claimed → live.')}</SheetDescription>
        </SheetHeader>
        <div className="overflow-auto px-4 pb-4">
          {q.isPending && <Spinner />}
          {q.isError && <FormError message={errorMessage(q.error)} />}
          {q.data && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Customer')}</TableHead>
                  <TableHead>{t('Device')}</TableHead>
                  <TableHead>{t('Claim code')}</TableHead>
                  <TableHead>{t('Shipped')}</TableHead>
                  <TableHead>{t('Status')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {q.data.map((r) => (
                  <TableRow key={r.deviceId}>
                    <TableCell>
                      <div className="font-medium">{r.reservedName}</div>
                      <div className="text-xs text-muted-foreground">{[r.reservedMobile, r.reservedEmail].filter(Boolean).join(' · ')}</div>
                      {r.companyName && <div className="text-xs">{r.companyName}</div>}
                    </TableCell>
                    <TableCell>
                      <div className="font-mono text-xs">{r.uniqueId}</div>
                      <div className="text-xs text-muted-foreground">{r.modelName}</div>
                    </TableCell>
                    <TableCell className="font-mono">{r.claimCode ?? '—'}</TableCell>
                    <TableCell className="text-xs">
                      {formatDateTime(r.shippedAt)}
                      {r.shipmentNote && <div className="text-muted-foreground">{r.shipmentNote}</div>}
                    </TableCell>
                    <TableCell>{status(r, t)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button size="icon-sm" variant="ghost" aria-label={t('Help sheet')} onClick={() => void helpSheet([r.deviceId], `VeeTrax-help-${r.uniqueId}.pdf`).catch((e) => toast.error(errorMessage(e)))}>
                        <FileDownIcon />
                      </Button>
                      {!r.claimedAt && (
                        <Button size="icon-sm" variant="ghost" aria-label={t('Cancel shipment')} disabled={cancel.isPending} onClick={() => window.confirm(t('Cancel this reservation? The claim code stops working.')) && cancel.mutate(r.deviceId)}>
                          <XIcon />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {!q.data.length && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      {t('No shipments yet. Use "Ship to customer" on a stock device.')}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
