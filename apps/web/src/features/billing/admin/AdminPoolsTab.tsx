import { useMutation, useQuery } from '@tanstack/react-query';
import { LICENCE_TYPE_LABELS, LICENCE_TYPES, type LicenceOverviewDto, type LicenceType } from '@veetracer/shared';
import { GiftIcon, SearchIcon, ShieldCheckIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';
import { freeByType } from '../BillingPage';
import { CustomersPanel, type CustomerRow } from '../CustomersPanel';
import { PoolView } from '../PoolView';

export interface PoolRow {
  kind: 'COMPANY' | 'PARTNER';
  id: string;
  name: string;
  partnerName: string | null;
  total: number;
  used: number;
  free: number;
  expiring: number;
  expired: number;
}

export const POOLS_QUERY = ['licences', 'admin', 'pools'];

function GrantDialog({ base, onClose, onDone }: { base: string; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [type, setType] = useState<LicenceType>('GPS_DEVICE');
  const [quantity, setQuantity] = useState(1);
  const [days, setDays] = useState(30);
  const [reason, setReason] = useState('');
  const grant = useMutation({
    mutationFn: () => api.post(`${base}/grant`, { type, quantity, days, reason: reason.trim() }),
    onSuccess: () => {
      toast.success(t('Complimentary licences granted'));
      onDone();
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !grant.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Grant complimentary licences')}</DialogTitle>
          <DialogDescription>{t('Free seats without an invoice (trials, replacements). Recorded in the audit log with the reason.')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          <Field label={t('Licence type')} htmlFor="grant-type">
            <Select value={type} onValueChange={(v) => setType(v as LicenceType)}>
              <SelectTrigger id="grant-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LICENCE_TYPES.map((ty) => (
                  <SelectItem key={ty} value={ty}>
                    {t(LICENCE_TYPE_LABELS[ty])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('Quantity')} htmlFor="grant-qty">
              <Input id="grant-qty" type="number" min={1} max={1000} value={quantity} onChange={(e) => setQuantity(Math.max(1, Math.floor(Number(e.target.value) || 1)))} />
            </Field>
            <Field label={t('Valid for (days)')} htmlFor="grant-days">
              <Input id="grant-days" type="number" min={1} max={3660} value={days} onChange={(e) => setDays(Math.max(1, Math.floor(Number(e.target.value) || 1)))} />
            </Field>
          </div>
          <Field label={t('Reason')} htmlFor="grant-reason" required>
            <Input id="grant-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <FormError message={grant.error ? errorMessage(grant.error) : null} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={grant.isPending}>
            {t('Cancel')}
          </Button>
          <Button onClick={() => grant.mutate()} disabled={grant.isPending || reason.trim().length < 3}>
            {grant.isPending ? <Spinner /> : <GiftIcon />}
            {t('Grant')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One pool opened by the Super Admin. */
export function AdminPoolDialog({ pool, onClose, onOpenPool, onChanged }: { pool: { kind: 'COMPANY' | 'PARTNER'; id: string; name: string }; onClose: () => void; onOpenPool: (p: { kind: 'COMPANY'; id: string; name: string }) => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [granting, setGranting] = useState(false);
  const base = `/licences/admin/pools/${pool.kind.toLowerCase()}/${pool.id}`;
  const q = useQuery({ queryKey: [base], queryFn: ({ signal }) => api.get<LicenceOverviewDto & { customers?: CustomerRow[] }>(base, undefined, signal) });
  const refresh = () => {
    void q.refetch();
    onChanged();
  };
  const invoicesPath = `/licences/admin/invoices?${pool.kind === 'COMPANY' ? 'companyId' : 'partnerId'}=${pool.id}`;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-6xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {pool.name} <Badge variant="secondary">{pool.kind === 'COMPANY' ? t('Company') : t('Partner')}</Badge>
          </DialogTitle>
        </DialogHeader>
        {q.isPending ? (
          <Skeleton className="h-64 w-full" />
        ) : q.isError ? (
          <FormError message={errorMessage(q.error)} />
        ) : (
          <PoolView
            overview={q.data}
            basePath={base}
            profilePath={`${base}/billing-profile`}
            invoicesPath={invoicesPath}
            pdfPath={(id) => `/licences/admin/invoices/${id}/pdf`}
            recordPath={can('sa_licences', 'create') ? `${base}/payments` : undefined}
            canBuy={false}
            canEditProfile={can('sa_licences', 'edit')}
            onChanged={refresh}
            extraActions={
              can('sa_licences', 'create') && (
                <Button variant="ghost" onClick={() => setGranting(true)}>
                  <GiftIcon />
                  {t('Grant complimentary')}
                </Button>
              )
            }
            extraTabs={
              q.data.customers
                ? [
                    {
                      value: 'customers',
                      label: t('Customers'),
                      content: (
                        <CustomersPanel
                          customers={q.data.customers}
                          partnerFree={freeByType(q.data)}
                          allocatePath={`/licences/admin/partners/${pool.id}/allocate`}
                          onOpen={(id, name) => onOpenPool({ kind: 'COMPANY', id, name })}
                          onChanged={refresh}
                        />
                      ),
                    },
                  ]
                : undefined
            }
          />
        )}
        {granting && <GrantDialog base={base} onClose={() => setGranting(false)} onDone={refresh} />}
      </DialogContent>
    </Dialog>
  );
}

export function AdminPoolsTab({ pools, loading, error, onChanged }: { pools: PoolRow[]; loading: boolean; error: unknown; onChanged: () => void }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<{ kind: 'COMPANY' | 'PARTNER'; id: string; name: string } | null>(null);
  const rows = useMemo(() => pools.filter((p) => !search.trim() || p.name.toLowerCase().includes(search.trim().toLowerCase())), [pools, search]);
  return (
    <div className="space-y-3">
      <div className="relative max-w-sm">
        <SearchIcon className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
        <Input className="pl-8" placeholder={t('Search companies and partners')} value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {!!error && <FormError message={errorMessage(error)} />}
      <Card className="overflow-hidden p-0">
        {loading ? (
          <Skeleton className="m-4 h-40" />
        ) : !rows.length ? (
          <EmptyState icon={ShieldCheckIcon} title={t('No licence pools')} description={t('Companies and partners appear here.')} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Name')}</TableHead>
                <TableHead>{t('Type')}</TableHead>
                <TableHead>{t('Partner')}</TableHead>
                <TableHead className="text-right">{t('In use')}</TableHead>
                <TableHead className="text-right">{t('Free')}</TableHead>
                <TableHead className="text-right">{t('Expiring')}</TableHead>
                <TableHead className="text-right">{t('Expired')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={`${p.kind}:${p.id}`} className="cursor-pointer" onClick={() => setOpen(p)}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell>
                    <Badge variant={p.kind === 'PARTNER' ? 'default' : 'secondary'}>{p.kind === 'PARTNER' ? t('Partner') : t('Company')}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{p.partnerName ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.used} / {p.total}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{p.free}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.expiring ? <Badge variant="warning">{p.expiring}</Badge> : 0}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.expired ? <Badge variant="destructive">{p.expired}</Badge> : 0}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      {open && <AdminPoolDialog key={`${open.kind}:${open.id}`} pool={open} onClose={() => setOpen(null)} onOpenPool={setOpen} onChanged={onChanged} />}
    </div>
  );
}
