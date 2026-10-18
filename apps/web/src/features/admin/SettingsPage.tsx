import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_THRESHOLDS, type CompanySummary } from '@veetracer/shared';
import { SaveIcon } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { ComboboxField, TextField } from '@/features/masters/form-fields';
import { numericText, requiredText } from '@/features/masters/form-schema';
import { api, errorMessage } from '@/lib/api';
import { timezoneOptions } from './timezones';

const SETTINGS_KEY = ['settings'] as const;

const schema = z.object({
  name: requiredText(120),
  timezone: z.string({ invalid_type_error: 'Required' }).min(1, 'Required'),
  runningSpeedKph: numericText({ min: 1, max: 50, required: true }),
  idleAfterSec: numericText({ min: 10, max: 3600, required: true, integer: true }),
  offlineAfterSec: numericText({ min: 60, max: 86400, required: true, integer: true }),
  driftRadiusM: numericText({ min: 0, max: 500, required: true }),
});
type Values = z.infer<typeof schema>;

function toValues(c: CompanySummary): Values {
  const t = { ...DEFAULT_THRESHOLDS, ...c.thresholds };
  return {
    name: c.name,
    timezone: c.timezone,
    runningSpeedKph: String(t.runningSpeedKph),
    idleAfterSec: String(t.idleAfterSec),
    offlineAfterSec: String(t.offlineAfterSec),
    driftRadiusM: String(t.driftRadiusM),
  };
}

export function SettingsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const editable = can('settings', 'edit');
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: ({ signal }) => api.get<{ company: CompanySummary }>('/settings', undefined, signal),
  });
  const form = useForm<Values>({ resolver: zodResolver(schema), disabled: !editable });
  const tzOptions = useMemo(timezoneOptions, []);

  useEffect(() => {
    if (settings.data) form.reset(toValues(settings.data.company));
  }, [settings.data, form]);

  const save = useMutation({
    mutationFn: (v: Values) =>
      api.patch<{ company: CompanySummary }>('/settings', {
        name: v.name,
        timezone: v.timezone,
        thresholds: {
          runningSpeedKph: Number(v.runningSpeedKph),
          idleAfterSec: Number(v.idleAfterSec),
          offlineAfterSec: Number(v.offlineAfterSec),
          driftRadiusM: Number(v.driftRadiusM),
        },
      }),
    onSuccess: (res) => {
      toast.success(t('Settings saved'));
      queryClient.setQueryData(SETTINGS_KEY, res);
      queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const company = settings.data?.company;

  return (
    <div className="w-full space-y-6 p-4 sm:p-6">
      <PageHeader
        title={t('Company Settings')}
        description={t('Company profile and the thresholds used to compute vehicle status.')}
        actions={company && <Badge variant={company.status === 'ACTIVE' ? 'success' : 'destructive'}>{company.status === 'ACTIVE' ? t('Active') : t('Suspended')}</Badge>}
      />
      {settings.isError && <FormError message={errorMessage(settings.error)} />}
      {settings.isPending ? (
        <Card className="space-y-4 p-6">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-2/3" />
        </Card>
      ) : (
        company && (
          <form noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-6 xl:grid-cols-2 xl:items-start">
            <Card>
              <CardHeader>
                <CardTitle>{t('Profile')}</CardTitle>
                <CardDescription>{company.accountType === 'BUSINESS' ? t('Business account') : t('Individual account')}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <TextField form={form} name="name" label="Company name" required />
                <ComboboxField form={form} name="timezone" label="Time zone" required options={tzOptions} disabled={!editable} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t('Status thresholds')}</CardTitle>
                <CardDescription>{t('How the live map decides Running, Idle and Offline. Changes apply to new positions.')}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <TextField form={form} name="runningSpeedKph" label="Running above (km/h)" type="number" required hint="Slower is treated as stationary." />
                <TextField form={form} name="idleAfterSec" label="Idle after (seconds)" type="number" required hint="Ignition on and stationary for this long." />
                <TextField form={form} name="offlineAfterSec" label="Offline after (seconds)" type="number" required hint="No data received for this long." />
                <TextField form={form} name="driftRadiusM" label="Parked drift radius (m)" type="number" required hint="GPS wander under this distance is ignored." />
              </CardContent>
            </Card>
            {editable && (
              <div className="flex justify-end gap-2 xl:col-span-2">
                <Button variant="outline" disabled={!form.formState.isDirty || save.isPending} onClick={() => form.reset(toValues(company))}>
                  {t('Reset')}
                </Button>
                <Button type="submit" disabled={!form.formState.isDirty || save.isPending}>
                  {save.isPending ? <Spinner /> : <SaveIcon />}
                  {t('Save changes')}
                </Button>
              </div>
            )}
          </form>
        )
      )}
    </div>
  );
}
