import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  RELAY_PASS_DOWNSTREAM_PROTOCOLS,
  RELAY_PROTOCOLS,
  type CompanyDto,
  type DeviceDto,
  type RelayAuthType,
  type RelayScope,
  type RelayTargetDto,
  type RelayTargetInput,
  type RelayTargetType,
} from '@veetracer/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Combobox, MultiSelect, type Option } from '@/components/ui/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, errorMessage } from '@/lib/api';

export const RELAY_QUERY = ['platform', 'relay-targets'] as const;

export const PROTOCOL_LABELS: Record<string, string> = { gt06: 'GT06 (Concox / Jimi)', teltonika: 'Teltonika', jt808: 'JT/T 808', ais140: 'AIS-140' };

const deviceOption = (d: DeviceDto): Option => ({ value: d.id, label: d.uniqueId, description: d.companyName ?? undefined });

interface FormState {
  name: string;
  type: RelayTargetType;
  enabled: boolean;
  host: string;
  port: string;
  passDownstream: boolean;
  url: string;
  authType: RelayAuthType;
  authValue: string;
  includeAlerts: boolean;
  scope: RelayScope;
  companyId: string | null;
  deviceIds: string[];
  protocol: string;
  liveOnly: boolean;
  validOnly: boolean;
}

function initial(r: RelayTargetDto | null): FormState {
  return {
    name: r?.name ?? '',
    type: r?.type ?? 'RAW_TCP',
    enabled: r?.enabled ?? true,
    host: r?.host ?? '',
    port: r?.port ? String(r.port) : '',
    passDownstream: r?.passDownstream ?? false,
    url: r?.url ?? 'https://',
    authType: r?.authType ?? 'NONE',
    authValue: '',
    includeAlerts: r?.includeAlerts ?? false,
    scope: r?.scope ?? 'ALL',
    companyId: r?.companyId ?? null,
    deviceIds: r?.deviceIds ?? [],
    protocol: r?.protocol ?? 'ais140',
    liveOnly: r?.liveOnly ?? false,
    validOnly: r?.validOnly ?? false,
  };
}

function toBody(f: FormState, record: RelayTargetDto | null): RelayTargetInput {
  const body: RelayTargetInput = { name: f.name.trim(), type: f.type, enabled: f.enabled, scope: f.scope };
  if (f.type === 'RAW_TCP') Object.assign(body, { host: f.host.trim(), port: Number(f.port), passDownstream: f.passDownstream });
  else {
    Object.assign(body, { url: f.url.trim(), authType: f.authType, includeAlerts: f.includeAlerts, liveOnly: f.liveOnly, validOnly: f.validOnly });
    // An empty value on edit keeps the stored token / password.
    if (f.authType === 'NONE') body.authValue = '';
    else if (f.authValue || !record?.hasAuth) body.authValue = f.authValue;
  }
  if (f.scope === 'COMPANY') body.companyId = f.companyId;
  if (f.scope === 'DEVICES') body.deviceIds = f.deviceIds;
  if (f.scope === 'PROTOCOL') body.protocol = f.protocol;
  return body;
}

/** Add (record = null) or edit a data forwarding target. */
export function RelayTargetDialog({ open, onOpenChange, record }: { open: boolean; onOpenChange: (open: boolean) => void; record: RelayTargetDto | null }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [f, setF] = useState<FormState>(() => initial(record));
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setF((s) => ({ ...s, [key]: value }));
  const [companyQ, setCompanyQ] = useState('');
  const [deviceQ, setDeviceQ] = useState('');
  const companies = useEntityOptions<CompanyDto>('/admin/companies', named, { q: companyQ, enabled: open && f.scope === 'COMPANY' });
  const devices = useEntityOptions<DeviceDto>('/admin/devices', deviceOption, { q: deviceQ, enabled: open && f.scope === 'DEVICES' });

  useEffect(() => {
    if (open) setF(initial(record));
  }, [open, record]);

  const save = useMutation({
    mutationFn: () => {
      const body = toBody(f, record);
      return record ? api.patch<RelayTargetDto>(`/admin/relay-targets/${record.id}`, body) : api.post<RelayTargetDto>('/admin/relay-targets', body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RELAY_QUERY });
      toast.success(t('Forwarding target saved'));
      onOpenChange(false);
    },
  });

  const close = (o: boolean) => {
    if (save.isPending) return;
    onOpenChange(o);
    if (!o) save.reset();
  };

  const tcp = f.type === 'RAW_TCP';
  const valid =
    !!f.name.trim() &&
    (tcp ? !!f.host.trim() && Number(f.port) > 0 && Number(f.port) < 65536 : f.url.trim().length > 8) &&
    (f.scope !== 'COMPANY' || !!f.companyId) &&
    (f.scope !== 'DEVICES' || f.deviceIds.length > 0);
  const passAllowed = f.scope !== 'PROTOCOL' || RELAY_PASS_DOWNSTREAM_PROTOCOLS.includes(f.protocol);

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl">
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{record ? t('Edit forwarding target') : t('Add forwarding target')}</DialogTitle>
            <DialogDescription>{t('Send a copy of the data received from devices to another server.')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('Name')} htmlFor="rt-name" required>
                <Input id="rt-name" value={f.name} maxLength={80} onChange={(e) => set('name', e.target.value)} placeholder={t('e.g. State VLT backend')} />
              </Field>
              <Field label={t('Type')} htmlFor="rt-type" required>
                <Select value={f.type} onValueChange={(v) => set('type', v as RelayTargetType)}>
                  <SelectTrigger id="rt-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="RAW_TCP">{t('Raw TCP (mirror device bytes)')}</SelectItem>
                    <SelectItem value="HTTP_JSON">{t('HTTP JSON (decoded positions)')}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            {tcp ? (
              <>
                <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
                  <Field label={t('Host')} htmlFor="rt-host" required hint={t('Each device connection is mirrored on its own TCP connection, login first. Replies from this server are ignored.')}>
                    <Input id="rt-host" value={f.host} maxLength={253} onChange={(e) => set('host', e.target.value)} placeholder="vlt.example.gov.in" />
                  </Field>
                  <Field label={t('Port')} htmlFor="rt-port" required>
                    <Input id="rt-port" type="number" min={1} max={65535} value={f.port} onChange={(e) => set('port', e.target.value)} placeholder="5001" />
                  </Field>
                </div>
                <label className="flex items-start gap-2.5 text-sm">
                  <Checkbox className="mt-0.5" checked={f.passDownstream} disabled={!passAllowed} onCheckedChange={(v) => set('passDownstream', v === true)} />
                  <span className="grid gap-0.5">
                    <span className="font-medium">{t('Pass replies to the device')}</span>
                    <span className="text-xs text-muted-foreground">{t('Off by default. Only applied to AIS-140 devices (text ACKs); use it only when this server must send commands to the device.')}</span>
                  </span>
                </label>
              </>
            ) : (
              <>
                <Field label={t('URL')} htmlFor="rt-url" required hint={t('Must be https:// and reachable from the internet. Batches of up to 100 positions, at least every 5 seconds, signed with X-VeeTrax-Signature.')}>
                  <Input id="rt-url" type="url" value={f.url} maxLength={2000} onChange={(e) => set('url', e.target.value)} placeholder="https://partner.example.com/veetrax" />
                </Field>
                <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
                  <Field label={t('Authentication')} htmlFor="rt-auth">
                    <Select value={f.authType} onValueChange={(v) => set('authType', v as RelayAuthType)}>
                      <SelectTrigger id="rt-auth">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="NONE">{t('None')}</SelectItem>
                        <SelectItem value="BEARER">{t('Bearer token')}</SelectItem>
                        <SelectItem value="BASIC">{t('Basic (user:password)')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  {f.authType !== 'NONE' && (
                    <Field label={f.authType === 'BASIC' ? t('User:password') : t('Token')} htmlFor="rt-auth-value" hint={record?.hasAuth ? t('Leave empty to keep the saved value.') : undefined}>
                      <Input id="rt-auth-value" type="password" autoComplete="off" value={f.authValue} maxLength={2000} onChange={(e) => set('authValue', e.target.value)} />
                    </Field>
                  )}
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={f.includeAlerts} onCheckedChange={(v) => set('includeAlerts', v === true)} />
                    {t('Include alerts')}
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={f.liveOnly} onCheckedChange={(v) => set('liveOnly', v === true)} />
                    {t('Live positions only')}
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={f.validOnly} onCheckedChange={(v) => set('validOnly', v === true)} />
                    {t('Valid GPS fixes only')}
                  </label>
                </div>
              </>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('Devices')} htmlFor="rt-scope" required>
                <Select value={f.scope} onValueChange={(v) => set('scope', v as RelayScope)}>
                  <SelectTrigger id="rt-scope">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">{t('All devices')}</SelectItem>
                    <SelectItem value="COMPANY">{t('One company')}</SelectItem>
                    <SelectItem value="DEVICES">{t('Selected devices')}</SelectItem>
                    <SelectItem value="PROTOCOL">{t('One protocol')}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {f.scope === 'COMPANY' && (
                <Field label={t('Company')} htmlFor="rt-company" required>
                  <Combobox
                    id="rt-company"
                    value={f.companyId}
                    onChange={(v) => set('companyId', v)}
                    options={companies.options}
                    onSearch={setCompanyQ}
                    loading={companies.loading}
                    selectedOption={record?.companyId && record.companyName ? { value: record.companyId, label: record.companyName } : null}
                  />
                </Field>
              )}
              {f.scope === 'PROTOCOL' && (
                <Field label={t('Protocol')} htmlFor="rt-protocol" required>
                  <Select value={f.protocol} onValueChange={(v) => set('protocol', v)}>
                    <SelectTrigger id="rt-protocol">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RELAY_PROTOCOLS.map((p) => (
                        <SelectItem key={p} value={p}>
                          {PROTOCOL_LABELS[p] ?? p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </div>
            {f.scope === 'DEVICES' && (
              <Field label={t('Selected devices')} htmlFor="rt-devices" required hint={t('Search by IMEI / unique id.')}>
                <MultiSelect
                  id="rt-devices"
                  value={f.deviceIds}
                  onChange={(v) => set('deviceIds', v)}
                  options={devices.options}
                  onSearch={setDeviceQ}
                  loading={devices.loading}
                  selectedOptions={record?.devices.map((d) => ({ value: d.id, label: d.uniqueId }))}
                />
              </Field>
            )}
            <label className="flex items-center gap-2.5 text-sm">
              <Switch checked={f.enabled} onCheckedChange={(v) => set('enabled', v)} />
              {t('Enabled')}
            </label>
            <FormError message={save.error ? errorMessage(save.error) : null} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {save.isPending && <Spinner />}
              {record ? t('Save changes') : t('Add target')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
