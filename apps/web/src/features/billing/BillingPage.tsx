import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiPlan, LICENCE_TYPES, type LicenceOverviewDto, type LicenceType } from '@veetracer/shared';
import { BuildingIcon, HandshakeIcon, InfoIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/features/auth/auth-context';
import { api, ApiError, errorMessage } from '@/lib/api';
import { CustomersPanel, type CustomerRow } from './CustomersPanel';
import { PoolView } from './PoolView';

type PartnerOverview = LicenceOverviewDto & { customers: CustomerRow[] };

export const freeByType = (o: LicenceOverviewDto): Record<LicenceType, number> =>
  Object.fromEntries(LICENCE_TYPES.map((ty) => [ty, o.summary.find((s) => s.type === ty)?.free ?? 0])) as Record<LicenceType, number>;

function Loading() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/** A partner's customer, opened from the reseller tab: record payments, invoices, billing details. */
function CustomerDialog({ customer, onClose }: { customer: { id: string; name: string }; onClose: () => void }) {
  const { can } = useAuth();
  const base = `/licences/partner/customers/${customer.id}`;
  const q = useQuery({ queryKey: [base, 'overview'], queryFn: ({ signal }) => api.get<LicenceOverviewDto>(`${base}/overview`, undefined, signal) });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-6xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{customer.name}</DialogTitle>
        </DialogHeader>
        {q.isPending ? (
          <Loading />
        ) : q.isError ? (
          <FormError message={errorMessage(q.error)} />
        ) : (
          <PoolView
            overview={q.data}
            basePath={base}
            profilePath={`${base}/billing-profile`}
            invoicesPath={`${base}/invoices`}
            pdfPath={(id) => `${base}/invoices/${id}/pdf`}
            recordPath={can('billing', 'create') ? `${base}/payments` : undefined}
            canBuy={false}
            canEditProfile={can('billing', 'edit')}
            onChanged={() => void q.refetch()}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Administration → Billing & Licences: the company's licences, buying / renewing, invoices; partners also get their reseller pool. */
export function BillingPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  // ?apiPlan=STANDARD (Developer API page → buy / renew / upgrade): the buy dialog opens with that plan.
  const [params] = useSearchParams();
  const apiPlanParam = params.get('apiPlan');
  const initialApiPlan = isApiPlan(apiPlanParam) ? apiPlanParam : null;
  const company = useQuery({ queryKey: ['licences', 'overview'], queryFn: ({ signal }) => api.get<LicenceOverviewDto>('/licences/overview', undefined, signal), retry: false });
  const partner = useQuery({ queryKey: ['licences', 'partner'], queryFn: ({ signal }) => api.get<PartnerOverview>('/licences/partner/overview', undefined, signal), retry: false });
  const isPartner = partner.isSuccess;
  const platform = company.error instanceof ApiError && company.error.status === 400;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['licences'] });
  };

  const companyView = company.isPending ? (
    <Loading />
  ) : platform ? (
    <Card className="flex items-start gap-3 p-4 text-sm">
      <InfoIcon className="mt-0.5 size-4 text-primary" />
      {t('The platform company does not need licences. Manage customer licences under Platform → Licences & Invoices.')}
    </Card>
  ) : company.isError ? (
    <FormError message={errorMessage(company.error)} />
  ) : (
    <PoolView
      overview={company.data}
      basePath="/licences"
      profilePath="/licences/billing-profile"
      invoicesPath="/licences/invoices"
      pdfPath={(id) => `/licences/invoices/${id}/pdf`}
      creditNotesPath="/licences/credit-notes"
      initialApiPlan={initialApiPlan}
      creditNotePdfPath={(id) => `/licences/credit-notes/${id}/pdf`}
      canBuy={can('billing', 'create')}
      canEditProfile={can('billing', 'edit')}
      onChanged={refresh}
    />
  );

  return (
    <div className="w-full space-y-6 p-4 sm:p-6">
      <PageHeader title={t('Billing & Licences')} description={t('Licences for users, GPS devices, dashcams and fuel sensors — each runs 12 months from activation.')} />
      {isPartner ? (
        <Tabs defaultValue="company">
          <TabsList>
            <TabsTrigger value="company">
              <BuildingIcon className="size-4" />
              {t('My company')}
            </TabsTrigger>
            <TabsTrigger value="partner">
              <HandshakeIcon className="size-4" />
              {t('Reseller pool')}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="company" className="mt-4">
            {companyView}
          </TabsContent>
          <TabsContent value="partner" className="mt-4">
            <PoolView
              overview={partner.data}
              basePath="/licences/partner"
              profilePath="/licences/partner/billing-profile"
              invoicesPath="/licences/partner/invoices"
              pdfPath={(id) => `/licences/partner/invoices/${id}/pdf`}
              creditNotesPath="/licences/partner/credit-notes"
              creditNotePdfPath={(id) => `/licences/partner/credit-notes/${id}/pdf`}
              canBuy={can('billing', 'create')}
              canEditProfile={can('billing', 'edit')}
              onChanged={refresh}
              extraTabs={[
                {
                  value: 'customers',
                  label: t('Customers'),
                  content: (
                    <CustomersPanel
                      customers={partner.data.customers}
                      partnerFree={freeByType(partner.data)}
                      allocatePath="/licences/partner/allocate"
                      onOpen={(id, name) => setCustomer({ id, name })}
                      onChanged={refresh}
                    />
                  ),
                },
              ]}
            />
          </TabsContent>
        </Tabs>
      ) : (
        companyView
      )}
      {customer && <CustomerDialog customer={customer} onClose={() => setCustomer(null)} />}
    </div>
  );
}
