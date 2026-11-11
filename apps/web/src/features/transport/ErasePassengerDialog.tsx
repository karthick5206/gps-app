import type { PassengerDto } from '@veetracer/shared';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage } from '@/lib/api';
import { useErasePassenger } from './use-people';

/**
 * "Erase personal data" of an archived passenger (security review M5, WP 2.6). Follows the documented default of owner
 * decision L5, pending owner confirmation of L5: name, contacts, home and pickup, emergency contacts and accessibility
 * notes are anonymised in place; statistics and the consent history (without the identity) stay; the login is disabled
 * and unlinked. Irreversible, so the admin types the employee code to confirm. Corporate admin only (the server checks).
 */
export function ErasePassengerDialog({ passenger, open, onOpenChange }: { passenger: Pick<PassengerDto, 'id' | 'employeeCode' | 'displayName'>; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [typed, setTyped] = useState('');
  const erase = useErasePassenger();
  const matches = typed.trim() === passenger.employeeCode;
  const close = (o: boolean) => {
    if (erase.isPending) return;
    if (!o) {
      setTyped('');
      erase.reset();
    }
    onOpenChange(o);
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Erase personal data?')}</DialogTitle>
          <DialogDescription>{t('This cannot be undone.')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3 text-sm">
          <ul className="list-disc space-y-1 pl-5">
            <li>{t('Removed: name, employee code, phone and email, home address and point, pickup stop, emergency contacts and accessibility notes.')}</li>
            <li>{t('Kept without the identity: trip statistics, branch and office, and the consent history (that consent was given, its version and channel).')}</li>
            <li>{t('The app login is disabled and unlinked; a login used only for transport is anonymised too.')}</li>
          </ul>
          <p className="text-xs text-muted-foreground">{t('Rule pending the owner’s confirmation (decision L5): anonymise in place, keep statistics.')}</p>
          <Field label={t('Type the employee code {{code}} to confirm', { code: passenger.employeeCode })} htmlFor={`${id}-confirm`}>
            <Input id={`${id}-confirm`} autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono" />
          </Field>
          <FormError message={erase.error ? errorMessage(erase.error) : null} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={erase.isPending}>
            {t('Cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={!matches || erase.isPending}
            onClick={() =>
              erase.mutate(
                { id: passenger.id, input: { confirm: typed.trim() } },
                {
                  onSuccess: () => {
                    toast.success(t('Personal data erased'));
                    close(false);
                  },
                },
              )
            }
          >
            {erase.isPending && <Spinner />}
            {t('Erase personal data')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
