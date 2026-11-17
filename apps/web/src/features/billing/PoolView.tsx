import { useMutation, useQuery } from '@tanstack/react-query';
import type { ApiPlan, CreditNoteDto, InvoiceDto, LicenceOverviewDto } from '@veetracer/shared';
import { CalendarClockIcon, CreditCardIcon, FileTextIcon, ReceiptIcon, RefreshCwIcon, ShieldCheckIcon, WalletIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api';
import { BillingProfileForm } from './BillingProfileForm';
import { BuyDialog } from './BuyDialog';
import { CreditNotesTable, InvoicesTable, SeatSummaryCards, SeatsTable } from './shared';

/**
 * One licence pool (company or partner): seat summary, seat list with renewal selection, buy / renew (online or the
 * offline instructions) or — for a Super Admin / partner — record an offline payment, invoices and billing details.
 */
export function PoolView({
  overview,
  basePath,
  profilePath,
  invoicesPath,
  pdfPath,
  creditNotesPath,
  creditNotePdfPath,
  recordPath,
  canBuy,
  canEditProfile,
  onChanged,
  extraTabs,
  extraActions,
  initialApiPlan,
  datesPath,
}: {
  overview: LicenceOverviewDto;
  basePath: string;
  profilePath: string;
  invoicesPath: string;
  pdfPath: (id: string) => string;
  /** Credit notes of this pool (listed under the invoices). */
  creditNotesPath?: string;
  creditNotePdfPath?: (id: string) => string;
  recordPath?: string;
  canBuy: boolean;
  canEditProfile: boolean;
  onChanged: () => void;
  extraTabs?: { value: string; label: string; content: ReactNode }[];
  extraActions?: ReactNode;
  /** From the Developer API page: open the buy dialog with this plan, or with the API seat selected to renew it. */
  initialApiPlan?: ApiPlan | null;
  /** Super Admin: PATCH endpoint to change the start / end date of the selected licences. */
  datesPath?: string;
}) {
  const { t } = useTranslation();
  const apiSeat = overview.apiAccess?.seat ?? null;
  const renewApi = !!initialApiPlan && !!apiSeat && apiSeat.plan === initialApiPlan;
  const [selected, setSelected] = useState<Set<string>>(() => new Set(renewApi && apiSeat ? [apiSeat.id] : []));
  const [datesOpen, setDatesOpen] = useState(false);
  const [dialog, setDialog] = useState<'pay' | 'record' | null>(() => (initialApiPlan && canBuy ? 'pay' : null));
  const invoices = useQuery({ queryKey: [invoicesPath], queryFn: ({ signal }) => api.get<InvoiceDto[]>(invoicesPath, undefined, signal) });
  const creditNotes = useQuery({
    queryKey: [creditNotesPath],
    queryFn: ({ signal }) => api.get<CreditNoteDto[]>(creditNotesPath!, undefined, signal),
    enabled: !!creditNotesPath,
  });
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const done = () => {
    setSelected(new Set());
    onChanged();
    void invoices.refetch();
  };
  const expiringIds = overview.seats.filter((s) => s.status !== 'ACTIVE').map((s) => s.id);

  return (
    <div className="space-y-4">
      <SeatSummaryCards summary={overview.summary} />
      <div className="flex flex-wrap items-center gap-2">
        {canBuy && (
          <Button onClick={() => setDialog('pay')}>
            <CreditCardIcon />
            {selected.size ? t('Renew {{n}} selected', { n: selected.size }) : t('Buy licences')}
          </Button>
        )}
        {recordPath && (
          <Button variant="outline" onClick={() => setDialog('record')}>
            <ReceiptIcon />
            {selected.size ? t('Record renewal payment ({{n}})', { n: selected.size }) : t('Record offline payment')}
          </Button>
        )}
        {expiringIds.length > 0 && (canBuy || recordPath) && (
          <Button variant="ghost" onClick={() => setSelected(new Set(expiringIds))}>
            <RefreshCwIcon />
            {t('Select expiring / expired ({{n}})', { n: expiringIds.length })}
          </Button>
        )}
        {datesPath && selected.size > 0 && (
          <Button variant="outline" onClick={() => setDatesOpen(true)}>
            <CalendarClockIcon />
            {t('Change dates ({{n}})', { n: selected.size })}
          </Button>
        )}
        {extraActions}
        <span className="ml-auto text-xs text-muted-foreground">
          {t('GST {{rate}}% included · grace period {{days}} days', { rate: overview.gstRatePct, days: overview.graceDays })}
        </span>
      </div>
      {!overview.billing.complete && (canBuy || recordPath) && <FormError message={t('Fill in the billing details (name, address, state and e-mail) before buying')} />}
      <Tabs defaultValue="seats">
        <TabsList>
          <TabsTrigger value="seats">
            <ShieldCheckIcon className="size-4" />
            {t('Licences')}
          </TabsTrigger>
          <TabsTrigger value="invoices">
            <FileTextIcon className="size-4" />
            {t('Invoices')}
          </TabsTrigger>
          <TabsTrigger value="billing">
            <WalletIcon className="size-4" />
            {t('Billing details')}
          </TabsTrigger>
          {extraTabs?.map((x) => (
            <TabsTrigger key={x.value} value={x.value}>
              {x.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="seats" className="mt-4">
          <Card className="overflow-hidden p-0">
            <SeatsTable seats={overview.seats} selected={selected} onToggle={canBuy || recordPath || datesPath ? toggle : undefined} />
          </Card>
        </TabsContent>
        <TabsContent value="invoices" className="mt-4">
          <Card className="overflow-hidden p-0">
            {invoices.isPending ? <Skeleton className="m-4 h-24" /> : invoices.isError ? <FormError message={errorMessage(invoices.error)} /> : <InvoicesTable invoices={invoices.data} pdfPath={pdfPath} />}
          </Card>
          {creditNotePdfPath && !!creditNotes.data?.length && (
            <div className="mt-4 space-y-2">
              <h3 className="text-sm font-semibold">{t('Credit notes')}</h3>
              <Card className="overflow-hidden p-0">
                <CreditNotesTable notes={creditNotes.data} pdfPath={creditNotePdfPath} />
              </Card>
            </div>
          )}
        </TabsContent>
        <TabsContent value="billing" className="mt-4">
          <Card className="p-4">
            <BillingProfileForm profile={overview.billing} path={profilePath} canEdit={canEditProfile} onSaved={onChanged} />
          </Card>
        </TabsContent>
        {extraTabs?.map((x) => (
          <TabsContent key={x.value} value={x.value} className="mt-4">
            {x.content}
          </TabsContent>
        ))}
      </Tabs>
      {datesOpen && datesPath && (
        <SeatDatesDialog
          path={datesPath}
          seats={overview.seats.filter((x) => selected.has(x.id))}
          onClose={() => setDatesOpen(false)}
          onDone={() => {
            setDatesOpen(false);
            done();
          }}
        />
      )}
      {dialog && (
        <BuyDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          overview={overview}
          basePath={basePath}
          recordPath={recordPath}
          renewSeatIds={[...selected]}
          initialApiPlan={renewApi ? null : initialApiPlan}
          mode={dialog}
          onDone={done}
        />
      )}
    </div>
  );
}

const dayOf = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Super Admin: new start and / or end date for the selected licences (empty = keep), with a reason (audited per seat). */
function SeatDatesDialog({ path, seats, onClose, onDone }: { path: string; seats: LicenceOverviewDto['seats']; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const one = seats.length === 1 ? seats[0] : null;
  const [from, setFrom] = useState(one ? dayOf(one.activatedAt) : '');
  const [until, setUntil] = useState(one ? dayOf(one.expiresAt) : '');
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api.patch<{ updated: number }>(path, {
        seatIds: seats.map((x) => x.id),
        activatedAt: from && (!one || from !== dayOf(one.activatedAt)) ? from : null,
        expiresAt: until && (!one || until !== dayOf(one.expiresAt)) ? until : null,
        reason: reason.trim(),
      }),
    onSuccess: (r) => {
      toast.success(t('Dates changed for {{n}} licence(s)', { n: r.updated }));
      onDone();
    },
  });
  const changed = one ? from !== dayOf(one.activatedAt) || until !== dayOf(one.expiresAt) : !!(from || until);
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Change licence dates')}</DialogTitle>
          <DialogDescription>
            {one
              ? (one.subject?.name ?? t('Free (unassigned)'))
              : t('{{n}} licences selected. Leave a date empty to keep each licence’s own date.', { n: seats.length })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('Valid from')} htmlFor="seat-from">
              <Input id="seat-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label={t('Expires on')} htmlFor="seat-until">
              <Input id="seat-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
            </Field>
          </div>
          <Field label={t('Reason')} htmlFor="seat-reason" required hint={t('Recorded in the audit log of the company.')}>
            <Input id="seat-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder={t('e.g. Payment received, licence from installation date')} />
          </Field>
          <FormError message={save.error ? errorMessage(save.error) : null} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            {t('Cancel')}
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !changed || reason.trim().length < 3}>
            {save.isPending ? <Spinner /> : <CalendarClockIcon />}
            {t('Save dates')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
