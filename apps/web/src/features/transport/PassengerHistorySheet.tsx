import { HistoryIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FormError } from '@/components/form-error';
import { EmptyState } from '@/components/ui/empty-state';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { ToneBadge } from './passenger-ui';
import { historyDetails, historyEntrySummary, historyFieldRows } from './people-format';
import { usePassengerHistory } from './use-people';

const FIXED_VALUES = new Set(['—', 'Yes', 'No', 'Changed (value hidden)']);

/**
 * History of one passenger (GET /transport/passengers/:id/history): profile changes, consent records, login changes and,
 * for the corporate admin, who viewed the record. The server redacts per role: home, health and emergency-contact values
 * are never shown, dispatchers see no address fields and providers only their minimal view. Opening it is audited.
 */
export function PassengerHistorySheet({ target, onClose }: { target: { id: string; label: string } | null; onClose: () => void }) {
  const { t } = useTranslation();
  const history = usePassengerHistory(target?.id);
  // Only the fixed words are translated; field values (codes, numbers, ids) are shown as they are.
  const tv = (v: string) => (FIXED_VALUES.has(v) ? t(v) : v);

  return (
    <Sheet open={!!target} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{t('History')}</SheetTitle>
          <SheetDescription className="truncate">{target?.label}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <p className="mb-4 text-xs text-muted-foreground">{t('Home address, health and emergency contact values are never shown here, only that they changed.')}</p>
          {history.isPending && (
            <div className="space-y-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          )}
          {history.isError && <FormError message={errorMessage(history.error)} />}
          {history.data?.length === 0 && <EmptyState icon={HistoryIcon} title={t('No history yet')} description={t('Changes to this record will appear here.')} />}
          {history.data && history.data.length > 0 && (
            <ol className="relative space-y-5 border-l pl-5">
              {history.data.map((h) => {
                const s = historyEntrySummary(h);
                const rows = historyFieldRows(h.changes);
                const details = historyDetails(h.changes);
                return (
                  <li key={h.id} className="relative space-y-2">
                    <span className="absolute top-1.5 -left-[25px] size-2.5 rounded-full border-2 border-card bg-primary" aria-hidden />
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <ToneBadge tone={s.tone}>{t(s.title)}</ToneBadge>
                      {s.detail && <span className="text-sm">{t(s.detail)}</span>}
                      <span className="font-medium">{h.userName ?? (h.userId ? t('Unknown user') : t('Not shown'))}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">{formatDateTime(h.createdAt)}</span>
                    </div>
                    {rows.length > 0 && (
                      <div className="overflow-x-auto rounded-lg border text-xs">
                        <table className="w-full">
                          <thead className="bg-muted/60 text-muted-foreground">
                            <tr>
                              <th scope="col" className="px-2 py-1.5 text-left font-medium">
                                {t('Field')}
                              </th>
                              <th scope="col" className="px-2 py-1.5 text-left font-medium">
                                {t('Before')}
                              </th>
                              <th scope="col" className="px-2 py-1.5 text-left font-medium">
                                {t('After')}
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((r) => (
                              <tr key={r.field} className="border-t align-top">
                                <th scope="row" className="px-2 py-1.5 text-left font-medium">
                                  {t(r.label)}
                                </th>
                                <td className="px-2 py-1.5 break-all text-muted-foreground">{tv(r.before)}</td>
                                <td className="px-2 py-1.5 break-all">{tv(r.after)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {details.length > 0 && (
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        {details.map((d) => (
                          <div key={d.key} className="contents">
                            <dt className="font-medium">{d.key}</dt>
                            <dd className="break-all">{d.value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
