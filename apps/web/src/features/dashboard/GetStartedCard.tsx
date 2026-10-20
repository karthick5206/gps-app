import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MOBILE_TRACKER_PROTOCOL, normalizeMobile, type DeviceModelDto, type Paginated } from '@veetracer/shared';
import { CreditCardIcon, PackageCheckIcon, SmartphoneIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { api, errorMessage } from '@/lib/api';

/** Adds a phone (VeeTrax Tracker app) for a person: device with the mobile number + the person it tracks. */
function TrackPhoneDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [mobile, setMobile] = useState('');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const models = useQuery({
    queryKey: ['device-models', 'mobile'],
    queryFn: ({ signal }) => api.get<Paginated<DeviceModelDto>>('/device-models', { pageSize: 200 }, signal),
    enabled: open,
  });
  const add = useMutation({
    mutationFn: async () => {
      const model = models.data?.items.find((m) => m.protocol === MOBILE_TRACKER_PROTOCOL);
      if (!model) throw new Error(t('Phone tracking is not available yet. Contact VeeTrax support.'));
      const device = await api.post<{ id: string }>('/devices', { modelId: model.id, uniqueId: normalizeMobile(mobile), isActive: true });
      await api.post('/objects', { name: name.trim(), type: 'PERSON', deviceId: device.id });
    },
    onSuccess: () => {
      toast.success(t('Added. Install VeeTrax Tracker on that phone and activate it with the same number.'));
      void queryClient.invalidateQueries();
      onOpenChange(false);
    },
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!normalizeMobile(mobile)) return setProblem(t('Enter the 10-digit mobile number of the phone'));
    if (!name.trim()) return setProblem(t('Give it a name, e.g. My car or Amma'));
    setProblem(null);
    add.mutate();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t('Track a phone')}</DialogTitle>
            <DialogDescription>{t('Your phone, or a family member’s. They install VeeTrax Tracker and activate it with this number.')}</DialogDescription>
          </DialogHeader>
          <FormError message={problem ?? (add.isError ? errorMessage(add.error) : null)} />
          <Field label={t('Mobile number')} htmlFor="tp-mobile">
            <Input id="tp-mobile" type="tel" inputMode="tel" placeholder="98765 43210" value={mobile} onChange={(e) => setMobile(e.target.value)} />
          </Field>
          <Field label={t('Name')} htmlFor="tp-name">
            <Input id="tp-name" placeholder={t('e.g. Me, Amma, Ravi')} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={add.isPending}>
              {add.isPending && <Spinner />}
              {t('Add phone')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Personal accounts without anything tracked yet: the three ways to start. */
export function GetStartedCard() {
  const { t } = useTranslation();
  const [phone, setPhone] = useState(false);
  const step = (icon: React.ReactNode, title: string, text: string, action: React.ReactNode) => (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <div className="flex items-center gap-2 font-medium">
        {icon} {title}
      </div>
      <p className="flex-1 text-sm text-muted-foreground">{text}</p>
      {action}
    </div>
  );
  return (
    <Card className="space-y-4 p-4">
      <div>
        <h2 className="text-lg font-semibold">{t('Get started')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('Add what you want to track. Each tracker or phone needs a yearly licence.')}{' '}
          <Link to="/guide" className="font-medium text-primary hover:underline">
            {t('Step-by-step guide')}
          </Link>
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {step(
          <CreditCardIcon className="size-4" />,
          t('1. Buy licences'),
          t('Choose how many trackers and phones. Pay online or by UPI / cash; we activate them once paid.'),
          <Button asChild variant="outline">
            <Link to="/admin/billing">{t('Billing & Licences')}</Link>
          </Button>,
        )}
        {step(
          <PackageCheckIcon className="size-4" />,
          t('2. Add a GPS tracker'),
          t('Use the IMEI and claim code from the help sheet in the box, or a tracker you bought elsewhere.'),
          <Button asChild>
            <Link to="/claim">{t('Add a tracker')}</Link>
          </Button>,
        )}
        {step(
          <SmartphoneIcon className="size-4" />,
          t('…or track a phone'),
          t('Share a phone’s location with the VeeTrax Tracker app, for yourself or family.'),
          <Button variant="outline" onClick={() => setPhone(true)}>
            {t('Track a phone')}
          </Button>,
        )}
      </div>
      <TrackPhoneDialog open={phone} onOpenChange={setPhone} />
    </Card>
  );
}
