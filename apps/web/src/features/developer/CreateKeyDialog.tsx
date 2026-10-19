import { useMutation, useQueryClient } from '@tanstack/react-query';
import { API_SCOPE_DEFS, type ApiScope, type BranchDto, type CreatedApiKey } from '@veetracer/shared';
import { KeyRoundIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Combobox } from '@/components/ui/multi-select';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, errorMessage } from '@/lib/api';
import { KEYS_QUERY, SecretBox } from './shared';

const DEFAULT_SCOPES = API_SCOPE_DEFS.filter((d) => !d.sensitive).map((d) => d.scope);

export function CreateKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>(DEFAULT_SCOPES);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [ips, setIps] = useState('');
  const [expires, setExpires] = useState('');
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: open && can('branches') });

  const reset = () => {
    setName('');
    setScopes(DEFAULT_SCOPES);
    setBranchId(null);
    setIps('');
    setExpires('');
    setCreated(null);
    create.reset();
  };

  const create = useMutation({
    mutationFn: () =>
      api.post<CreatedApiKey>('/developer/api-keys', {
        name: name.trim(),
        scopes,
        branchId,
        ipAllowList: ips.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
        expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
      }),
    onSuccess: (res) => {
      setCreated(res);
      void queryClient.invalidateQueries({ queryKey: KEYS_QUERY });
    },
  });

  const toggle = (scope: ApiScope, on: boolean) => setScopes((s) => (on ? [...s, scope] : s.filter((x) => x !== scope)));
  const close = (o: boolean) => {
    if (create.isPending) return;
    onOpenChange(o);
    if (!o) setTimeout(reset, 200);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-xl">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('API key created')}</DialogTitle>
              <DialogDescription>{t('Copy the key now. For your security it is shown only once and cannot be retrieved later.')}</DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-3">
              <SecretBox value={created.secret} />
              <p className="flex items-start gap-2 text-sm text-warning">
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                {t('Store it in your system’s secret store. Anyone with this key can read your fleet data.')}
              </p>
            </DialogBody>
            <DialogFooter>
              <Button onClick={() => close(false)}>{t('Done')}</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('Create API key')}</DialogTitle>
              <DialogDescription>{t('Keys let your own software (ERP, dispatch, BI) read VeeTrax data over the REST API.')}</DialogDescription>
            </DialogHeader>
            <DialogBody className="grid gap-4">
              <Field label={t('Name')} htmlFor="key-name" required>
                <Input id="key-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={t('e.g. SAP integration')} />
              </Field>
              <Field label={t('Scopes')} required>
                <div className="grid gap-2">
                  {API_SCOPE_DEFS.map((d) => (
                    <label key={d.scope} className="flex cursor-pointer items-start gap-2.5 rounded-md p-1 hover:bg-accent/50">
                      <Checkbox className="mt-0.5" checked={scopes.includes(d.scope)} onCheckedChange={(v) => toggle(d.scope, v === true)} />
                      <span className="grid gap-0.5">
                        <span className="text-sm font-medium">
                          {t(d.label)} <code className="ml-1 text-xs text-muted-foreground">{d.scope}</code>
                        </span>
                        <span className="text-xs text-muted-foreground">{t(d.description)}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('Branch')} hint={t('Leave empty for the whole company.')}>
                  <Combobox value={branchId} onChange={setBranchId} options={branches.options} placeholder={t('Whole company')} />
                </Field>
                <Field label={t('Expires on')} htmlFor="key-exp" hint={t('Optional.')}>
                  <Input id="key-exp" type="date" value={expires} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setExpires(e.target.value)} />
                </Field>
              </div>
              <Field label={t('Allowed IP addresses')} htmlFor="key-ips" hint={t('Optional. One per line or comma-separated; CIDR ranges allowed (e.g. 203.0.113.0/24).')}>
                <Textarea id="key-ips" rows={2} value={ips} onChange={(e) => setIps(e.target.value)} placeholder="203.0.113.10" />
              </Field>
              <FormError message={create.error ? errorMessage(create.error) : null} />
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                {t('Cancel')}
              </Button>
              <Button type="submit" disabled={!name.trim() || !scopes.length || create.isPending}>
                {create.isPending ? <Spinner /> : <KeyRoundIcon />}
                {t('Create key')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
