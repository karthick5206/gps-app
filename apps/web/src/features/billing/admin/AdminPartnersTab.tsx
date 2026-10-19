import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LICENCE_TYPE_LABELS, LICENCE_TYPES, toPaise, type LicenceType } from '@veetracer/shared';
import { HandshakeIcon, LinkIcon, PencilIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/multi-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';
import { rupees } from '../shared';
import type { PoolRow } from './AdminPoolsTab';

interface PartnerRow {
  id: string;
  name: string;
  slug: string;
  homeCompanyId: string | null;
  homeCompanyName: string | null;
  customers: number;
  pricesPaise: Record<LicenceType, number | null>;
}

const PARTNERS_QUERY = ['licences', 'admin', 'partners'];

function PartnerDialog({ partner, companies, onClose }: { partner: PartnerRow | null; companies: { value: string; label: string }[]; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(partner?.name ?? '');
  const [home, setHome] = useState<string | null>(partner?.homeCompanyId ?? null);
  const [prices, setPrices] = useState<Record<LicenceType, string>>(
    Object.fromEntries(LICENCE_TYPES.map((ty) => [ty, partner?.pricesPaise[ty] != null ? String((partner.pricesPaise[ty] as number) / 100) : ''])) as Record<LicenceType, string>,
  );
  const save = useMutation({
    mutationFn: () => {
      const pricesPaise = Object.fromEntries(LICENCE_TYPES.map((ty) => [ty, prices[ty].trim() === '' ? null : toPaise(Number(prices[ty]))]));
      return partner ? api.patch(`/licences/admin/partners/${partner.id}`, { name: name.trim(), homeCompanyId: home, pricesPaise }) : api.post('/licences/admin/partners', { name: name.trim(), homeCompanyId: home });
    },
    onSuccess: () => {
      toast.success(t('Partner saved'));
      void queryClient.invalidateQueries({ queryKey: ['licences', 'admin'] });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{partner ? t('Edit partner') : t('New partner')}</DialogTitle>
          <DialogDescription>{t('A partner (reseller) buys licences in bulk and allocates them to its customers. Its own company account’s admins manage the partner pool.')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          <Field label={t('Name')} htmlFor="partner-name" required>
            <Input id="partner-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('Partner’s own company account')} hint={t('Admins of this company see the reseller pool in Billing & Licences.')}>
            <Combobox value={home} onChange={setHome} options={companies} placeholder={t('None')} />
          </Field>
          {partner && (
            <Field label={t('Partner prices (₹ per year, incl. GST)')} hint={t('Leave empty to use the platform price.')}>
              <div className="grid grid-cols-2 gap-2">
                {LICENCE_TYPES.map((ty) => (
                  <label key={ty} className="grid gap-1 text-xs">
                    {t(LICENCE_TYPE_LABELS[ty])}
                    <Input type="number" min={0} step="0.01" value={prices[ty]} onChange={(e) => setPrices((p) => ({ ...p, [ty]: e.target.value }))} />
                  </label>
                ))}
              </div>
            </Field>
          )}
          <FormError message={save.error ? errorMessage(save.error) : null} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            {t('Cancel')}
          </Button>
          <Button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending}>
            {save.isPending && <Spinner />}
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LinkCompanyDialog({ partners, companies, onClose }: { partners: PartnerRow[]; companies: { value: string; label: string }[]; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [company, setCompany] = useState<string | null>(null);
  const [partner, setPartner] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.patch(`/licences/admin/companies/${company}/partner`, { partnerId: partner }),
    onSuccess: () => {
      toast.success(t('Company linked to partner'));
      void queryClient.invalidateQueries({ queryKey: ['licences', 'admin'] });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Link a customer to a partner')}</DialogTitle>
          <DialogDescription>{t('The partner can then allocate licences to this company and record its payments.')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          <Field label={t('Company')}>
            <Combobox value={company} onChange={setCompany} options={companies} placeholder={t('Select company')} />
          </Field>
          <Field label={t('Partner')}>
            <Combobox value={partner} onChange={setPartner} options={partners.map((p) => ({ value: p.id, label: p.name }))} placeholder={t('Select partner')} />
          </Field>
          <FormError message={save.error ? errorMessage(save.error) : null} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            {t('Cancel')}
          </Button>
          <Button onClick={() => save.mutate()} disabled={!company || !partner || save.isPending}>
            {save.isPending && <Spinner />}
            {t('Link')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AdminPartnersTab({ pools }: { pools: PoolRow[] }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [editing, setEditing] = useState<PartnerRow | 'new' | null>(null);
  const [linking, setLinking] = useState(false);
  const q = useQuery({ queryKey: PARTNERS_QUERY, queryFn: ({ signal }) => api.get<PartnerRow[]>('/licences/admin/partners', undefined, signal) });
  const companies = pools.filter((p) => p.kind === 'COMPANY').map((p) => ({ value: p.id, label: p.name }));
  return (
    <div className="space-y-3">
      {can('sa_licences', 'create') && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setEditing('new')}>
            <PlusIcon />
            {t('New partner')}
          </Button>
          <Button variant="outline" onClick={() => setLinking(true)}>
            <LinkIcon />
            {t('Link customer to partner')}
          </Button>
        </div>
      )}
      {q.isError && <FormError message={errorMessage(q.error)} />}
      <Card className="overflow-hidden p-0">
        {q.isPending ? (
          <Skeleton className="m-4 h-32" />
        ) : !q.data?.length ? (
          <EmptyState icon={HandshakeIcon} title={t('No partners')} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Partner')}</TableHead>
                <TableHead>{t('Own company account')}</TableHead>
                <TableHead className="text-right">{t('Customers')}</TableHead>
                <TableHead>{t('Price overrides')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(q.data ?? []).map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell>{p.homeCompanyName ?? <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.customers}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {LICENCE_TYPES.filter((ty) => p.pricesPaise[ty] != null)
                      .map((ty) => `${t(LICENCE_TYPE_LABELS[ty])}: ${rupees(p.pricesPaise[ty] as number)}`)
                      .join(' · ') || t('Platform prices')}
                  </TableCell>
                  <TableCell className="text-right">
                    {can('sa_licences', 'edit') && (
                      <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                        <PencilIcon />
                        {t('Edit')}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      {editing && <PartnerDialog partner={editing === 'new' ? null : editing} companies={companies} onClose={() => setEditing(null)} />}
      {linking && q.data && <LinkCompanyDialog partners={q.data} companies={companies} onClose={() => setLinking(false)} />}
    </div>
  );
}
