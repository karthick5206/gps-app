import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FormEventHandler, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Invalidates list, option and history caches of a master after a write. */
export function useInvalidateMaster() {
  const queryClient = useQueryClient();
  return (endpoint: string) => {
    queryClient.invalidateQueries({ queryKey: ['master', endpoint] });
    queryClient.invalidateQueries({ queryKey: ['options', endpoint] });
    queryClient.invalidateQueries({ queryKey: ['history', endpoint] });
  };
}

/** POST (create) or PATCH /:id (edit) with toast + cache invalidation; closes the dialog on success. */
export function useSaveMutation<TBody>({
  endpoint,
  id,
  entity,
  onSaved,
}: {
  endpoint: string;
  id: string | null;
  entity: string;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const invalidate = useInvalidateMaster();
  return useMutation({
    mutationFn: (body: TBody) => (id ? api.patch<unknown>(`${endpoint}/${id}`, body) : api.post<unknown>(endpoint, body)),
    onSuccess: () => {
      toast.success(id ? t('{{entity}} updated', { entity: t(entity) }) : t('{{entity}} created', { entity: t(entity) }));
      invalidate(endpoint);
      onSaved();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
}

export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  onSubmit,
  pending,
  error,
  submitLabel = 'Save',
  wide = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  onSubmit: FormEventHandler<HTMLFormElement>;
  pending: boolean;
  error?: unknown;
  submitLabel?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className={cn(wide ? 'max-w-3xl' : 'max-w-lg')}>
        <DialogHeader>
          <DialogTitle>{t(title)}</DialogTitle>
          {description ? <DialogDescription>{t(description)}</DialogDescription> : <DialogDescription className="sr-only">{t(title)}</DialogDescription>}
        </DialogHeader>
        <form noValidate onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col gap-4">
          <DialogBody className="space-y-4">
            {error ? <FormError message={errorMessage(error)} /> : null}
            {children}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              {t('Cancel')}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner />}
              {t(submitLabel)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
