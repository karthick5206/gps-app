import { useQuery } from '@tanstack/react-query';
import type { ApiPlan, CreditNoteDto, InvoiceDto, LicenceOverviewDto } from '@veetracer/shared';
import { CreditCardIcon, FileTextIcon, ReceiptIcon, RefreshCwIcon, ShieldCheckIcon, WalletIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
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
}) {
  const { t } = useTranslation();
  const apiSeat = overview.apiAccess?.seat ?? null;
  const renewApi = !!initialApiPlan && !!apiSeat && apiSeat.plan === initialApiPlan;
  const [selected, setSelected] = useState<Set<string>>(() => new Set(renewApi && apiSeat ? [apiSeat.id] : []));
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
            <SeatsTable seats={overview.seats} selected={selected} onToggle={canBuy || recordPath ? toggle : undefined} />
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
