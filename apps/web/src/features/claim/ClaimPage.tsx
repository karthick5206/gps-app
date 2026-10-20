import { useMutation, useQuery } from '@tanstack/react-query';
import { MOBILE_TRACKER_PROTOCOL, type DeviceModelDto, type ObjectType, type Paginated } from '@veetracer/shared';
import { CheckCircle2Icon, PackageCheckIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { api, errorMessage } from '@/lib/api';

type Lookup = { status: 'MINE' | 'TAKEN' | 'NEEDS_CODE' | 'STOCK' | 'SEEN' | 'NOT_SEEN'; model?: string; protocol?: string; lastSeenAt?: string };
const TYPES: { value: ObjectType; label: string }[] = [
  { value: 'VEHICLE', label: 'Vehicle' },
  { value: 'PERSON', label: 'Person' },
  { value: 'ASSET', label: 'Asset' },
  { value: 'PET', label: 'Pet' },
];

/**
 * Add a tracker to my account: from the help sheet in the box (IMEI + claim code; the QR fills both in), or one
 * bought elsewhere once it has connected to VeeTrax. Then name what it tracks.
 */
export function ClaimPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const [imei, setImei] = useState(params.get('imei') ?? '');
  const [code, setCode] = useState(params.get('code') ?? '');
  const [modelId, setModelId] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<ObjectType>('VEHICLE');
  const [problem, setProblem] = useState<string | null>(null);

  const id = imei.trim();
  const lookup = useQuery({
    queryKey: ['claim-lookup', id],
    queryFn: ({ signal }) => api.get<Lookup>(`/devices/claim/${encodeURIComponent(id)}`, undefined, signal),
    enabled: /^[A-Za-z0-9_-]{8,32}$/.test(id),
    retry: false,
  });
  const models = useQuery({
    queryKey: ['device-models', 'claim'],
    queryFn: ({ signal }) => api.get<Paginated<DeviceModelDto>>('/device-models', { pageSize: 200 }, signal),
    enabled: lookup.data?.status === 'SEEN',
  });
  const status = lookup.data?.status;
  const byod = status === 'SEEN';

  const claim = useMutation({
    mutationFn: async () => {
      const r = await api.post<{ deviceId: string }>('/devices/claim', { uniqueId: id, claimCode: byod ? undefined : code, modelId: byod ? modelId : undefined });
      await api.post('/objects', { name: name.trim(), type, deviceId: r.deviceId });
      return r;
    },
  });

  if (claim.isSuccess) {
    return (
      <div className="mx-auto max-w-lg p-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2Icon className="size-5 text-success" /> {t('Tracker added')}
            </CardTitle>
            <CardDescription>{t('{{name}} will appear on the live map as soon as the tracker connects.', { name: name.trim() })}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button asChild>
              <Link to="/live">{t('Open live map')}</Link>
            </Button>
            <Button variant="outline" onClick={() => window.location.assign('/claim')}>
              {t('Add another')}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!id) return setProblem(t('Enter the IMEI printed on the tracker'));
    if (!byod && !code.trim()) return setProblem(t('Enter the claim code printed on the help sheet in the box'));
    if (byod && !modelId) return setProblem(t('Choose the tracker model'));
    if (!name.trim()) return setProblem(t('Give it a name, e.g. My car or Amma'));
    setProblem(null);
    claim.mutate();
  };

  const hint =
    status === 'MINE'
      ? t('This tracker is already in your account.')
      : status === 'TAKEN'
        ? t('This tracker is registered to another account. Contact VeeTrax support.')
        : status === 'SEEN'
          ? t('We can hear this tracker. Choose its model to add it.')
          : status === 'NOT_SEEN'
            ? t('Not found yet. If you bought it elsewhere, set its server first (see the setup steps), power it on and try again in a few minutes.')
            : null;
  const blocked = status === 'MINE' || status === 'TAKEN' || status === 'NOT_SEEN';

  return (
    <div className="mx-auto max-w-lg p-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PackageCheckIcon className="size-5" /> {t('Add a tracker')}
          </CardTitle>
          <CardDescription>{t('Enter the IMEI and claim code from the help sheet in the box, or scan its QR code.')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" noValidate onSubmit={submit}>
            <FormError message={problem ?? (claim.isError ? errorMessage(claim.error) : null)} />
            <Field label={t('IMEI')} htmlFor="cl-imei" hint={hint ?? undefined}>
              <Input id="cl-imei" inputMode="numeric" value={imei} onChange={(e) => setImei(e.target.value)} placeholder="868120000000001" />
            </Field>
            {!byod && (
              <Field label={t('Claim code')} htmlFor="cl-code">
                <Input id="cl-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="7K4-Q2M" className="tracking-widest uppercase" />
              </Field>
            )}
            {byod && (
              <Field label={t('Model')} htmlFor="cl-model">
                <Select value={modelId || undefined} onValueChange={setModelId}>
                  <SelectTrigger id="cl-model">
                    <SelectValue placeholder={t('Choose the tracker model')} />
                  </SelectTrigger>
                  <SelectContent>
                    {(models.data?.items ?? [])
                      .filter((m) => m.protocol !== MOBILE_TRACKER_PROTOCOL && m.protocol.toLowerCase() === (lookup.data?.protocol ?? '').toLowerCase())
                      .concat((models.data?.items ?? []).filter((m) => m.protocol !== MOBILE_TRACKER_PROTOCOL && m.protocol.toLowerCase() !== (lookup.data?.protocol ?? '').toLowerCase()))
                      .map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.brand} {m.model}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('Name')} htmlFor="cl-name">
                <Input id="cl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('e.g. My car')} />
              </Field>
              <Field label={t('It tracks a')} htmlFor="cl-type">
                <Select value={type} onValueChange={(v) => setType(v as ObjectType)}>
                  <SelectTrigger id="cl-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TYPES.map((x) => (
                      <SelectItem key={x.value} value={x.value}>
                        {t(x.label)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Button type="submit" className="w-full" disabled={claim.isPending || blocked}>
              {claim.isPending && <Spinner />}
              {t('Add tracker')}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t('Each tracker needs a yearly licence.')}{' '}
              <Link to="/admin/billing" className="text-primary hover:underline">
                {t('Billing & Licences')}
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
