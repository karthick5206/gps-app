import { useQuery } from '@tanstack/react-query';
import type { AuditLogDto } from '@veetracer/shared';
import { HistoryIcon } from 'lucide-react';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { ChangesView } from './ChangesView';

const ACTION_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  CREATE: 'success',
  UPDATE: 'warning',
  DELETE: 'destructive',
};

export function HistorySheet({ endpoint, target, onClose }: { endpoint: string; target: { id: string; label: string } | null; onClose: () => void }) {
  const history = useQuery({
    queryKey: ['history', endpoint, target?.id],
    queryFn: ({ signal }) => api.get<AuditLogDto[]>(`${endpoint}/${target!.id}/history`, undefined, signal),
    enabled: !!target,
  });

  return (
    <Sheet open={!!target} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>History</SheetTitle>
          <SheetDescription className="truncate">{target?.label}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {history.isPending && (
            <div className="space-y-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          )}
          {history.isError && <FormError message={errorMessage(history.error)} />}
          {history.data?.length === 0 && <EmptyState icon={HistoryIcon} title="No history yet" description="Changes to this record will appear here." />}
          {history.data && history.data.length > 0 && (
            <ol className="relative space-y-5 border-l pl-5">
              {history.data.map((h) => (
                <li key={h.id} className="relative space-y-2">
                  <span className="absolute top-1.5 -left-[25px] size-2.5 rounded-full border-2 border-card bg-primary" />
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant={ACTION_VARIANT[h.action] ?? 'secondary'}>{h.action}</Badge>
                    <span className="font-medium">{h.userName ?? 'System'}</span>
                    <span className="text-xs text-muted-foreground">{formatDateTime(h.createdAt)}</span>
                  </div>
                  <ChangesView changes={h.changes} />
                </li>
              ))}
            </ol>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
