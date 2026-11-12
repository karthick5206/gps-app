import { ACCESS_REASON_MAX, ACCESS_REASON_MIN } from '@veetracer/shared';
import { ShieldAlertIcon } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import { forgetAccessReason, rememberAccessReason, rememberedAccessReason, subscribeAccessReason } from '@/lib/access-reason';
import { setAccessReasonRequiredHandler } from '@/lib/api';
import { reasonScopeOf, validAccessReason } from '@/lib/transport-context';

/** The data-owner company of the current page (selected customer, else the acting company). */
function usePageReasonScope(): { companyId: string | null; scope: string | null } {
  const { companyId } = useAuth();
  const location = useLocation();
  return { companyId, scope: reasonScopeOf('/transport/passengers', location, companyId) };
}

/** The reason remembered for the page's company (re-renders when it changes; expires after 30 minutes, L8). */
export function useRememberedAccessReason(): string | null {
  const { companyId, scope } = usePageReasonScope();
  return useSyncExternalStore(subscribeAccessReason, () => rememberedAccessReason(companyId, scope), () => null);
}

function ReasonForm({ initial, onSubmit, onCancel, submitLabel }: { initial: string; onSubmit: (r: string) => void; onCancel: () => void; submitLabel: string }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState(initial);
  const valid = validAccessReason(reason);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit(valid);
      }}
    >
      <DialogBody>
        <Field label={t('Reason')} htmlFor="access-reason" hint={t('At least {{n}} characters, e.g. the support ticket number.', { n: ACCESS_REASON_MIN })}>
          <Input id="access-reason" autoFocus value={reason} maxLength={ACCESS_REASON_MAX} onChange={(e) => setReason(e.target.value)} placeholder={t('e.g. Ticket 4521: customer asked us to check a pickup point')} />
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button type="submit" disabled={!valid}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

const DESCRIPTION = "VeeTrax support needs a reason to open this company's passenger data. The reason and your name are shown in the company's sensitive-access log. It is kept for 30 minutes, for this company only.";

/**
 * Asked when the API refuses a Super Admin's passenger read without a reason (400 REASON_REQUIRED, ETMS 10 §2.2 item
 * 8). lib/api.ts retries the request with the reason and remembers it for that customer company for 30 minutes (L8).
 */
export function AccessReasonDialog() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const resolver = useRef<((r: string | null) => void) | null>(null);

  useEffect(() => {
    setAccessReasonRequiredHandler(
      () =>
        new Promise<string | null>((resolve) => {
          resolver.current?.(null);
          resolver.current = resolve;
          setOpen(true);
        }),
    );
    return () => setAccessReasonRequiredHandler(null);
  }, []);

  const finish = (value: string | null) => {
    resolver.current?.(value);
    resolver.current = null;
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && finish(null)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Reason for access')}</DialogTitle>
          <DialogDescription>{t(DESCRIPTION)}</DialogDescription>
        </DialogHeader>
        {open && <ReasonForm initial="" submitLabel={t('Continue')} onSubmit={finish} onCancel={() => finish(null)} />}
      </DialogContent>
    </Dialog>
  );
}

/** Super Admin only: the reason in use for this company, with "Change" and "Forget" (passenger pages). */
export function AccessReasonNotice() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const { companyId, scope } = usePageReasonScope();
  const reason = useRememberedAccessReason();
  const [editing, setEditing] = useState(false);
  if (!me?.user.isSuperAdmin || !reason) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
      <ShieldAlertIcon className="size-4 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0 flex-1 break-words">
        {t('Access reason shown to the company')}: <span className="font-medium">{reason}</span>
      </span>
      <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
        {t('Change reason')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => forgetAccessReason(companyId, scope)}>
        {t('Forget')}
      </Button>
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('Change reason for access')}</DialogTitle>
            <DialogDescription>{t(DESCRIPTION)}</DialogDescription>
          </DialogHeader>
          {editing && (
            <ReasonForm
              initial={reason}
              submitLabel={t('Save')}
              onCancel={() => setEditing(false)}
              onSubmit={(r) => {
                rememberAccessReason(companyId, scope, r);
                setEditing(false);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
