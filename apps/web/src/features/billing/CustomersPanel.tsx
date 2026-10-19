import { useMutation } from '@tanstack/react-query';
import { LICENCE_TYPE_LABELS, LICENCE_TYPES, type LicenceType, type SeatSummaryDto } from '@veetracer/shared';
import { ArrowRightLeftIcon, BuildingIcon, ExternalLinkIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { formatDay } from './shared';

export interface CustomerRow {
  companyId: string;
  name: string;
  summary: SeatSummaryDto[];
  expiring: { seatId: string; type: LicenceType; subject: string; expiresAt: string }[];
}

/** A partner's customers: seats in use, what expires soon, allocation from the partner pool. */
export function CustomersPanel({
  customers,
  partnerFree,
  allocatePath,
  onOpen,
  onChanged,
}: {
  customers: CustomerRow[];
  partnerFree: Record<LicenceType, number>;
  allocatePath: string;
  onOpen?: (companyId: string, name: string) => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<CustomerRow | null>(null);
  const [type, setType] = useState<LicenceType>('GPS_DEVICE');
  const [quantity, setQuantity] = useState(1);
  const allocate = useMutation({
    mutationFn: () => api.post<{ allocated: number }>(allocatePath, { companyId: target!.companyId, type, quantity }),
    onSuccess: (r) => {
      toast.success(t('{{n}} licence(s) allocated', { n: r.allocated }));
      setTarget(null);
      onChanged();
    },
  });
  if (!customers.length) return <EmptyState icon={BuildingIcon} title={t('No customers yet')} description={t('Companies linked to your partner account appear here.')} />;
  return (
    <>
      <Card className="overflow-hidden p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Customer')}</TableHead>
              {LICENCE_TYPES.map((ty) => (
                <TableHead key={ty} className="text-right">
                  {t(LICENCE_TYPE_LABELS[ty])}
                </TableHead>
              ))}
              <TableHead>{t('Expiring within 30 days')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {customers.map((c) => (
              <TableRow key={c.companyId}>
                <TableCell className="font-medium">{c.name}</TableCell>
                {LICENCE_TYPES.map((ty) => {
                  const s = c.summary.find((x) => x.type === ty);
                  return (
                    <TableCell key={ty} className="text-right tabular-nums">
                      {s ? `${s.used} / ${s.total}` : '0 / 0'}
                    </TableCell>
                  );
                })}
                <TableCell className="max-w-72">
                  {c.expiring.length ? (
                    <div className="flex flex-wrap gap-1">
                      {c.expiring.slice(0, 4).map((e) => (
                        <Badge key={e.seatId} variant={Date.parse(e.expiresAt) < Date.now() ? 'destructive' : 'warning'} title={`${t(LICENCE_TYPE_LABELS[e.type])} · ${e.subject}`}>
                          {e.subject} · {formatDay(e.expiresAt)}
                        </Badge>
                      ))}
                      {c.expiring.length > 4 && <Badge variant="muted">+{c.expiring.length - 4}</Badge>}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  <Button size="sm" variant="outline" onClick={() => setTarget(c)}>
                    <ArrowRightLeftIcon />
                    {t('Allocate')}
                  </Button>
                  {onOpen && (
                    <Button size="sm" variant="ghost" onClick={() => onOpen(c.companyId, c.name)}>
                      <ExternalLinkIcon />
                      {t('Open')}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <Dialog open={!!target} onOpenChange={(o) => !o && !allocate.isPending && setTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('Allocate licences to {{name}}', { name: target?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t('Free seats move from your pool to the customer; each keeps its own expiry date.')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            <Field label={t('Licence type')} htmlFor="alloc-type">
              <Select value={type} onValueChange={(v) => setType(v as LicenceType)}>
                <SelectTrigger id="alloc-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LICENCE_TYPES.map((ty) => (
                    <SelectItem key={ty} value={ty}>
                      {t(LICENCE_TYPE_LABELS[ty])} ({t('{{n}} free', { n: partnerFree[ty] ?? 0 })})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('Quantity')} htmlFor="alloc-qty">
              <Input id="alloc-qty" type="number" min={1} max={partnerFree[type] || 1} value={quantity} onChange={(e) => setQuantity(Math.max(1, Math.floor(Number(e.target.value) || 1)))} />
            </Field>
            <FormError message={allocate.error ? errorMessage(allocate.error) : null} />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)} disabled={allocate.isPending}>
              {t('Cancel')}
            </Button>
            <Button onClick={() => allocate.mutate()} disabled={allocate.isPending || !(partnerFree[type] > 0)}>
              {allocate.isPending ? <Spinner /> : <ArrowRightLeftIcon />}
              {t('Allocate')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
