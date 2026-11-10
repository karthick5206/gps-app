import { useMutation } from '@tanstack/react-query';
import { ArrowRightLeftIcon, CheckCircle2Icon, SearchCheckIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api, errorMessage } from '@/lib/api';

interface LinkResult {
  serial: string;
  kind: string | null;
  from: string | null;
  to: string | null;
  note?: string;
}
interface SyncResult {
  checked: number;
  changes: LinkResult[];
}

/**
 * Super Admin: Purchases & sales keeps every tracker's place in Stock & movements (the one stock register) by itself.
 * "Check" lists differences without changing anything; "Sync" fixes them (first link of older entries, or a repair).
 */
export function RegisterLinkCard() {
  const { t } = useTranslation();
  const [result, setResult] = useState<(SyncResult & { dryRun: boolean }) | null>(null);
  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.post<SyncResult>(`/stock/sync-inventory?dryRun=${dryRun}`).then((r) => ({ ...r, dryRun })),
    onSuccess: (r) => {
      setResult(r);
      if (!r.dryRun) toast.success(t('Stock & movements updated'));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const fixable = result?.changes.filter((c) => c.kind) ?? [];
  return (
    <Card className="gap-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h3 className="text-[15px] font-bold">{t('One stock register')}</h3>
          <p className="text-sm text-muted-foreground">
            {t('Trackers bought, sold or returned here are also kept in Stock & movements, which shows where every tracker is. You do not need to enter them twice.')}{' '}
            <Link to="/platform/inventory" className="font-medium text-primary underline-offset-2 hover:underline">
              {t('Open Stock & movements')}
            </Link>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={run.isPending} onClick={() => run.mutate(true)}>
            <SearchCheckIcon /> {t('Check')}
          </Button>
          <Button disabled={run.isPending || (result?.dryRun === true && !fixable.length)} onClick={() => run.mutate(false)}>
            <ArrowRightLeftIcon /> {t('Sync now')}
          </Button>
        </div>
      </div>
      {result && (
        <div className="rounded-lg border p-3 text-sm">
          {!result.changes.length ? (
            <p className="flex items-center gap-2 text-success">
              <CheckCircle2Icon className="size-4" /> {t('All {{n}} trackers match Stock & movements.', { n: result.checked })}
            </p>
          ) : (
            <>
              <p className="mb-2 font-medium">
                {result.dryRun ? t('{{n}} of {{total}} trackers differ. Press Sync now to fix them.', { n: fixable.length, total: result.checked }) : t('{{n}} trackers updated.', { n: fixable.length })}
              </p>
              <ul className="max-h-48 space-y-0.5 overflow-auto font-mono text-xs">
                {result.changes.slice(0, 200).map((c) => (
                  <li key={c.serial}>
                    {c.serial}: {c.kind ? `${c.from ?? t('not in register')} → ${c.to}` : c.note}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
