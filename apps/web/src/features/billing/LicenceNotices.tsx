import { useQuery } from '@tanstack/react-query';
import { LICENCE_TYPE_LABELS, type LicenceBannerDto } from '@veetracer/shared';
import { CreditCardIcon, LockIcon, ShieldAlertIcon, XIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import { api, ApiError, setLicenceRequiredHandler } from '@/lib/api';

const DISMISS_KEY = 'vt:licence-banner-dismissed';

/** "N licences expire within 30 days" / "Vehicle X licence expired — renew to view" above every page. */
export function LicenceBanner() {
  const { t } = useTranslation();
  const { companyId } = useAuth();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const q = useQuery({
    queryKey: ['licences', 'banner', companyId],
    queryFn: ({ signal }) => api.get<LicenceBannerDto>('/licences/banner', undefined, signal),
    refetchInterval: 10 * 60_000,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const b = q.data;
  if (!b || b.exempt) return null;
  const locked = b.lockedVehicles;
  const show = locked.length > 0 || ((b.expiringSoon > 0 || b.inGrace > 0) && !dismissed);
  if (!show) return null;
  const parts: string[] = [];
  if (locked.length === 1) parts.push(t('Vehicle {{name}}: licence expired — renew to view its location, history and reports.', { name: locked[0].name }));
  else if (locked.length > 1) parts.push(t('{{n}} vehicles have expired licences ({{names}}) — renew to view them.', { n: locked.length, names: locked.slice(0, 3).map((v) => v.name).join(', ') + (locked.length > 3 ? '…' : '') }));
  if (b.inGrace > 0) parts.push(t('{{n}} licence(s) expired and in the grace period.', { n: b.inGrace }));
  if (b.expiringSoon > 0) parts.push(t('{{n}} licence(s) expire within 30 days.', { n: b.expiringSoon }));
  const severe = locked.length > 0 || b.inGrace > 0;
  return (
    <div role="status" className={`flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm ${severe ? 'bg-destructive/10 text-destructive' : 'bg-warning/10 text-warning'}`}>
      {severe ? <LockIcon className="size-4 shrink-0" /> : <ShieldAlertIcon className="size-4 shrink-0" />}
      <span className="min-w-0 flex-1">{parts.join(' ')}</span>
      {b.canManage && (
        <Button asChild size="sm" variant={severe ? 'destructive' : 'outline'}>
          <Link to="/admin/billing">{t('Renew licences')}</Link>
        </Button>
      )}
      {!locked.length && (
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t('Dismiss')}
          onClick={() => {
            setDismissed(true);
            try {
              sessionStorage.setItem(DISMISS_KEY, '1');
            } catch {
              /* private mode */
            }
          }}
        >
          <XIcon />
        </Button>
      )}
    </div>
  );
}

/**
 * Shown when a create (user / device / fuel sensor) needs a licence seat and none is free: "Buy licence" for admins,
 * and for the Super Admin an override with a reason (the request is retried with it and audited).
 */
export function LicenceRequiredDialog() {
  const { t } = useTranslation();
  const { me, can } = useAuth();
  const navigate = useNavigate();
  const [err, setErr] = useState<ApiError | null>(null);
  const [reason, setReason] = useState('');
  const resolver = useRef<((r: string | null) => void) | null>(null);
  const isSuperAdmin = !!me?.user.isSuperAdmin;

  useEffect(() => {
    setLicenceRequiredHandler(
      (e) =>
        new Promise<string | null>((resolve) => {
          resolver.current?.(null);
          resolver.current = resolve;
          setReason('');
          setErr(e);
        }),
    );
    return () => setLicenceRequiredHandler(null);
  }, []);

  const finish = (value: string | null) => {
    resolver.current?.(value);
    resolver.current = null;
    setErr(null);
  };

  return (
    <Dialog open={!!err} onOpenChange={(o) => !o && finish(null)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Licence required')}</DialogTitle>
          <DialogDescription>
            {err?.licenceType ? t('No free {{type}} licence is available.', { type: t(LICENCE_TYPE_LABELS[err.licenceType]).toLowerCase() }) : err?.message}{' '}
            {t('Buy a licence to add more, or renew an expired one.')}
          </DialogDescription>
        </DialogHeader>
        {isSuperAdmin && (
          <DialogBody>
            <Field label={t('Super Admin override — reason')} htmlFor="licence-override" hint={t('Allows this one create with a short complimentary licence. Recorded in the audit log.')}>
              <Input id="licence-override" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder={t('e.g. Demo unit, payment promised')} />
            </Field>
          </DialogBody>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => finish(null)}>
            {t('Cancel')}
          </Button>
          {isSuperAdmin && (
            <Button variant="secondary" disabled={reason.trim().length < 3} onClick={() => finish(reason.trim())}>
              {t('Allow anyway')}
            </Button>
          )}
          {can('billing', 'create') && (
            <Button
              onClick={() => {
                finish(null);
                navigate('/admin/billing');
              }}
            >
              <CreditCardIcon />
              {t('Buy licence')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
