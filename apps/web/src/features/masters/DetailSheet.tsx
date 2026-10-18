import { HistoryIcon, PencilIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { MasterColumn } from './types';

/** Read-only view of a record, rendered from the same column definitions as the table. */
export function DetailSheet<T>({
  title,
  row,
  label,
  columns,
  onClose,
  onEdit,
  onHistory,
}: {
  title: string;
  row: T | null;
  label: string;
  columns: MasterColumn<T>[];
  onClose: () => void;
  onEdit?: () => void;
  onHistory?: () => void;
}) {
  return (
    <Sheet open={!!row} onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle className="truncate">{label}</SheetTitle>
          <SheetDescription>{title}</SheetDescription>
        </SheetHeader>
        {row && (
          <dl className="min-h-0 flex-1 divide-y overflow-y-auto px-5">
            {columns
              .filter((c) => c.detail !== false)
              .map((c) => (
                <div key={c.id} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4 py-2.5 text-sm">
                  <dt className="text-muted-foreground">{c.header}</dt>
                  <dd className="min-w-0 break-words [&_*]:whitespace-normal">{c.cell(row)}</dd>
                </div>
              ))}
          </dl>
        )}
        {(onEdit || onHistory) && (
          <div className="flex justify-end gap-2 border-t px-5 py-3">
            {onHistory && (
              <Button variant="outline" size="sm" onClick={onHistory}>
                <HistoryIcon /> History
              </Button>
            )}
            {onEdit && (
              <Button size="sm" onClick={onEdit}>
                <PencilIcon /> Edit
              </Button>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
