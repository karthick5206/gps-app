import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_PLAN_LABELS, API_PLANS, LICENCE_TYPE_LABELS, SEAT_LICENCE_TYPES, toPaise, type ApiPlan, type ApiPlans, type LicencePricingDto, type SeatLicenceType } from '@veetracer/shared';
import { SaveIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';
import { TYPE_ICONS } from '../shared';

const QUERY = ['licences', 'settings', 'pricing'];

/** Plan fields as typed (strings); maxVehicles '' = unlimited. */
type PlanForm = Record<ApiPlan, { price: string; maxVehicles: string; ratePerMinute: string; ratePerDay: string; maxWebhooks: string }>;
const toForm = (plans: ApiPlans): PlanForm =>
  Object.fromEntries(
    API_PLANS.map((pl) => [
      pl,
      { price: String(plans[pl].pricePaise / 100), maxVehicles: plans[pl].maxVehicles === null ? '' : String(plans[pl].maxVehicles), ratePerMinute: String(plans[pl].ratePerMinute), ratePerDay: String(plans[pl].ratePerDay), maxWebhooks: String(plans[pl].maxWebhooks) },
    ]),
  ) as PlanForm;
const fromForm = (f: PlanForm): ApiPlans =>
  Object.fromEntries(
    API_PLANS.map((pl) => [
      pl,
      {
        pricePaise: toPaise(Number(f[pl].price) || 0),
        maxVehicles: f[pl].maxVehicles.trim() === '' ? null : Math.max(1, Math.floor(Number(f[pl].maxVehicles) || 1)),
        ratePerMinute: Math.max(1, Math.floor(Number(f[pl].ratePerMinute) || 1)),
        ratePerDay: Math.max(1, Math.floor(Number(f[pl].ratePerDay) || 1)),
        maxWebhooks: Math.max(0, Math.floor(Number(f[pl].maxWebhooks) || 0)),
      },
    ]),
  ) as ApiPlans;

/** Platform Settings → Licence pricing: yearly GST-inclusive price per type, GST rate, grace and override days. */
export function PricingSettings() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: QUERY, queryFn: ({ signal }) => api.get<LicencePricingDto>('/licences/settings/pricing', undefined, signal) });
  const [prices, setPrices] = useState<Record<SeatLicenceType, string>>({ USER: '', GPS_DEVICE: '', DASHCAM: '', FUEL_SENSOR: '' });
  const [plans, setPlans] = useState<PlanForm | null>(null);
  const [gst, setGst] = useState('18');
  const [grace, setGrace] = useState('15');
  const [override, setOverride] = useState('30');
  useEffect(() => {
    if (!q.data) return;
    setPrices(Object.fromEntries(SEAT_LICENCE_TYPES.map((ty) => [ty, String(q.data.pricesPaise[ty] / 100)])) as Record<SeatLicenceType, string>);
    setPlans(toForm(q.data.apiPlans));
    setGst(String(q.data.gstRatePct));
    setGrace(String(q.data.graceDays));
    setOverride(String(q.data.overrideDays));
  }, [q.data]);
  const save = useMutation({
    mutationFn: () =>
      api.put<LicencePricingDto>('/licences/settings/pricing', {
        pricesPaise: Object.fromEntries(SEAT_LICENCE_TYPES.map((ty) => [ty, toPaise(Number(prices[ty]) || 0)])),
        apiPlans: plans ? fromForm(plans) : q.data?.apiPlans,
        gstRatePct: Number(gst),
        graceDays: Math.floor(Number(grace)),
        overrideDays: Math.floor(Number(override)),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(QUERY, data);
      toast.success(t('Licence pricing saved'));
    },
  });
  const editable = can('sa_platform_settings', 'edit');
  if (q.isPending) return <Skeleton className="h-64 w-full" />;
  if (q.isError) return <FormError message={errorMessage(q.error)} />;
  return (
    <Card className="max-w-3xl p-4">
      <form
        className="grid gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div>
          <h3 className="font-medium">{t('Yearly price per licence (₹, GST inclusive)')}</h3>
          <p className="text-sm text-muted-foreground">{t('Partners pay these prices unless a partner price is set (Licences & Invoices → Partners). A price of 0 blocks purchases of that type.')}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {SEAT_LICENCE_TYPES.map((ty) => {
            const Icon = TYPE_ICONS[ty];
            return (
              <Field key={ty} label={t(LICENCE_TYPE_LABELS[ty])} htmlFor={`price-${ty}`}>
                <div className="flex items-center gap-2">
                  <Icon className="size-4 text-muted-foreground" />
                  <Input id={`price-${ty}`} type="number" min={0} step="0.01" value={prices[ty]} disabled={!editable} onChange={(e) => setPrices((p) => ({ ...p, [ty]: e.target.value }))} />
                </div>
              </Field>
            );
          })}
        </div>
        {plans && (
          <div className="grid gap-3">
            <div>
              <h3 className="font-medium">{t('Developer API plans')}</h3>
              <p className="text-sm text-muted-foreground">{t('One per company per year (₹, GST inclusive). Requests per minute apply to each API key (a key can only be set lower); requests per day count all keys of the company. Leave vehicles empty for unlimited.')}</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="py-1 pr-2 font-medium">{t('Plan')}</th>
                    <th className="py-1 pr-2 font-medium">{t('Price (₹/year)')}</th>
                    <th className="py-1 pr-2 font-medium">{t('Vehicles')}</th>
                    <th className="py-1 pr-2 font-medium">{t('Requests / min')}</th>
                    <th className="py-1 pr-2 font-medium">{t('Requests / day')}</th>
                    <th className="py-1 font-medium">{t('Webhooks')}</th>
                  </tr>
                </thead>
                <tbody>
                  {API_PLANS.map((pl) => (
                    <tr key={pl}>
                      <td className="py-1 pr-2 font-medium">{t(API_PLAN_LABELS[pl])}</td>
                      {(['price', 'maxVehicles', 'ratePerMinute', 'ratePerDay', 'maxWebhooks'] as const).map((k) => (
                        <td key={k} className="py-1 pr-2">
                          <Input
                            aria-label={`${t(API_PLAN_LABELS[pl])} ${k}`}
                            type="number"
                            min={k === 'maxWebhooks' || k === 'price' ? 0 : 1}
                            step={k === 'price' ? '0.01' : '1'}
                            placeholder={k === 'maxVehicles' ? t('Unlimited') : undefined}
                            value={plans[pl][k]}
                            disabled={!editable}
                            onChange={(e) => setPlans((f) => (f ? { ...f, [pl]: { ...f[pl], [k]: e.target.value } } : f))}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t('GST rate (%)')} htmlFor="gst-rate">
            <Input id="gst-rate" type="number" min={0} max={40} step="0.01" value={gst} disabled={!editable} onChange={(e) => setGst(e.target.value)} />
          </Field>
          <Field label={t('Grace period (days)')} htmlFor="grace-days" hint={t('After expiry, viewing continues this long.')}>
            <Input id="grace-days" type="number" min={0} max={90} value={grace} disabled={!editable} onChange={(e) => setGrace(e.target.value)} />
          </Field>
          <Field label={t('Override validity (days)')} htmlFor="override-days" hint={t('Seat granted when you allow a create without a licence.')}>
            <Input id="override-days" type="number" min={1} max={365} value={override} disabled={!editable} onChange={(e) => setOverride(e.target.value)} />
          </Field>
        </div>
        <FormError message={save.error ? errorMessage(save.error) : null} />
        {editable && (
          <div>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? <Spinner /> : <SaveIcon />}
              {t('Save pricing')}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}
