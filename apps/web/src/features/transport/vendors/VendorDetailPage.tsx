import { pickRateCard, type TransportRateCardDto, type TransportVendorDto } from '@veetracer/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftIcon, CarFrontIcon, IdCardIcon, MapPinnedIcon, ReceiptIndianRupeeIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';
import { RateCardsSheet } from './RateCardsSheet';
import { BranchesTab, DriversTab, RatesTab, VehiclesTab } from './VendorSetupSheet';

function Section({ icon: Icon, title, children }: { icon: typeof CarFrontIcon; title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-4">
      <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
        <Icon className="size-4 text-primary" aria-hidden /> {title}
      </h2>
      {children}
    </section>
  );
}

/** "₹450 / trip" for the card a vehicle of this type would be billed on today (all-branch cards; branch-wise ones are in Advanced). */
function rateText(cards: TransportRateCardDto[], category: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  const card = pickRateCard(cards, new Date().toISOString().slice(0, 10), null, category);
  if (!card) return t('No rate yet: add it under Rates');
  const p = card.params;
  switch (card.model) {
    case 'TRIP':
      return `₹${p.perTrip ?? 0} / ${t('trip')}`;
    case 'KM':
      return `₹${p.perKm ?? 0} / km${p.minKm ? ` (${t('min {{n}} km', { n: p.minKm })})` : ''}`;
    case 'SLAB':
      return `₹${p.baseFare ?? 0} ${t('for')} ${p.baseKm ?? 0} km, ₹${p.perKmAfter ?? 0} / km`;
    case 'MONTHLY':
      return `₹${p.monthlyFee ?? 0} / ${t('month')} (${p.includedKm ?? 0} km)`;
    case 'PACKAGE':
      return `₹${p.fare ?? 0} ${t('package')} (${p.hours ?? 0} h / ${p.km ?? 0} km)`;
    case 'SEAT':
      return `₹${p.perSeat ?? 0} / ${t('employee')}`;
  }
}

/**
 * Masters → Vendors → one vendor (v1.16.12): everything on one page, no tabs — details, branches served, vehicles with
 * type, seats and the rate each will be billed at, drivers, and rates per vehicle type. Advanced rate cards (branch-wise,
 * slab, monthly, package, add-ons) open in a side panel.
 */
export function VendorDetailPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const { can, me } = useAuth();
  const [advanced, setAdvanced] = useState<TransportVendorDto | null>(null);
  const vendor = useQuery({ queryKey: ['vendor', id], queryFn: ({ signal }) => api.get<TransportVendorDto>(`/transport/vendors/${id}`, undefined, signal) });
  const cards = useQuery({ queryKey: ['rate-cards', id], queryFn: ({ signal }) => api.get<TransportRateCardDto[]>(`/transport/vendors/${id}/rate-cards`, undefined, signal) });
  const v = vendor.data;
  return (
    <div className="flex w-full min-w-0 flex-col gap-4 p-4 sm:p-6">
      <Link to="/vendors" className="flex items-center gap-1 text-sm font-medium text-primary hover:underline">
        <ArrowLeftIcon className="size-4" /> {t('Vendors')}
      </Link>
      {vendor.isError && <FormError message={errorMessage(vendor.error)} />}
      {!v ? (
        <Skeleton className="h-64 w-full rounded-xl" />
      ) : (
        <>
          <header className="rounded-xl border bg-card p-4">
            <h1 className="text-2xl font-semibold tracking-tight">{v.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {[v.gstin && `GSTIN ${v.gstin}`, v.pan && `PAN ${v.pan}`, v.contactName, v.phone, v.email].filter(Boolean).join(' · ') || t('No contact details yet')}
            </p>
            {(v.bankName || v.bankAccount) && (
              <p className="text-sm text-muted-foreground">
                {t('Bank')}: {[v.bankName, v.bankAccount, v.ifsc, v.upiId].filter(Boolean).join(' · ')}
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">{t('Edit name, GST, contact and bank from the Vendors list (Edit).')}</p>
          </header>

          <Section icon={MapPinnedIcon} title={t('Branches served')}>
            <BranchesTab vendor={v} />
          </Section>

          <Section icon={CarFrontIcon} title={t('Vehicles')}>
            <VehiclesTab vendor={v} rateOf={(cat) => rateText(cards.data ?? [], cat, t)} />
          </Section>

          {can('drivers') && (
            <Section icon={IdCardIcon} title={t('Drivers')}>
              <DriversTab vendor={v} />
            </Section>
          )}

          <Section icon={ReceiptIndianRupeeIcon} title={t('Rates by vehicle type')}>
            <RatesTab vendor={v} onAdvanced={() => setAdvanced(v)} />
          </Section>

          {me?.company.features.includes('etms') && can('etms_billing') && (
            <div className="flex justify-end">
              <Button variant="outline" asChild>
                <Link to="/transport/billing">
                  <ReceiptIndianRupeeIcon /> {t('Vendor billing')}
                </Link>
              </Button>
            </div>
          )}
        </>
      )}
      <RateCardsSheet vendor={advanced} onClose={() => setAdvanced(null)} />
    </div>
  );
}
