import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpiClaimDto } from '@veetracer/shared';
import { CheckIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

const KEY = ['licences', 'admin', 'upi-claims'];
const STATUS_VARIANT = { PENDING: 'warning', CONFIRMED: 'success', REJECTED: 'destructive' } as const;

/**
 * Super Admin: customers' "I've paid by UPI". Check the UTR and amount on the bank / UPI statement, then Confirm
 * (records the payment: licences activate, GST invoice emailed) or Reject (with a reason the customer sees).
 */
export function UpiClaimsTab() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [pendingOnly, setPendingOnly] = useState(true);
  const q = useQuery({ queryKey: [...KEY, pendingOnly], queryFn: ({ signal }) => api.get<UpiClaimDto[]>('/licences/admin/upi-claims', pendingOnly ? { status: 'PENDING' } : undefined, signal) });
  const done = () => queryClient.invalidateQueries({ queryKey: ['licences'] });
  const confirm = useMutation({
    mutationFn: (id: string) => api.post(`/licences/admin/upi-claims/${id}/confirm`, {}),
    onSuccess: () => {
      toast.success(t('Payment confirmed. Licences activated and invoice emailed.'));
      void done();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post(`/licences/admin/upi-claims/${id}/reject`, { reason }),
    onSuccess: () => void done(),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const busy = confirm.isPending || reject.isPending;

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('Check each UTR and amount on your bank / UPI statement before confirming.')}</p>
        <Button variant="outline" size="sm" onClick={() => setPendingOnly((x) => !x)}>
          {pendingOnly ? t('Show all') : t('Pending only')}
        </Button>
      </div>
      {q.isPending && <Spinner />}
      {q.isError && <FormError message={errorMessage(q.error)} />}
      {q.data && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Customer')}</TableHead>
              <TableHead>{t('Licences')}</TableHead>
              <TableHead>{t('UTR')}</TableHead>
              <TableHead>{t('Paid on')}</TableHead>
              <TableHead>{t('Status')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.data.map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <div className="font-medium">{c.ownerName}</div>
                  <div className="text-xs text-muted-foreground">
                    {c.createdByName ?? ''} · {formatDateTime(c.createdAt)}
                  </div>
                </TableCell>
                <TableCell className="text-sm">{c.summary}</TableCell>
                <TableCell className="font-mono">{c.utr}</TableCell>
                <TableCell>{c.paidOn}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[c.status]}>{t(c.status === 'PENDING' ? 'Pending' : c.status === 'CONFIRMED' ? 'Confirmed' : 'Rejected')}</Badge>
                  {c.note && <div className="text-xs text-muted-foreground">{c.note}</div>}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {c.status === 'PENDING' && can('sa_licences', 'create') && (
                    <>
                      <Button size="sm" disabled={busy} onClick={() => window.confirm(t('Confirm payment {{utr}}? Licences activate and the invoice is emailed.', { utr: c.utr })) && confirm.mutate(c.id)}>
                        <CheckIcon /> {t('Confirm')}
                      </Button>{' '}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          const reason = window.prompt(t('Reason (shown to the customer)'), t('Payment not received'));
                          if (reason !== null) reject.mutate({ id: c.id, reason });
                        }}
                      >
                        <XIcon /> {t('Reject')}
                      </Button>
                    </>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!q.data.length && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  {t('No UPI payments waiting.')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
