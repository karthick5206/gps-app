import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

/** A confirm dialog that asks for a reason (required unless `optional`). Strings are translated by the caller. */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  confirmLabel,
  destructive,
  optional = false,
  pending,
  error,
  children,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  label: string;
  confirmLabel: string;
  destructive?: boolean;
  optional?: boolean;
  pending?: boolean;
  error?: string | null;
  children?: ReactNode;
  onConfirm: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (open) {
      setReason('');
      setTried(false);
    }
  }, [open]);
  const missing = !optional && !reason.trim();
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent>
        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setTried(true);
            if (!missing) onConfirm(reason.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
          </DialogHeader>
          <DialogBody className="space-y-4">
            {error && <FormError message={error} />}
            <Field label={label} htmlFor="reason-text" required={!optional} error={tried && missing ? t('Give a reason') : undefined}>
              <Textarea id="reason-text" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={3} autoFocus />
            </Field>
            {children}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => onOpenChange(false)} disabled={pending}>
              {t('Back')}
            </Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={pending}>
              {pending && <Spinner />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
