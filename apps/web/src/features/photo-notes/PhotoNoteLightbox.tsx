import { PHOTO_NOTE_CATEGORY_LABELS, PHOTO_NOTE_MONEY_CATEGORIES, PHOTO_NOTE_SOURCE_LABELS, type PhotoNoteDto } from '@veetracer/shared';
import { ChevronLeftIcon, ChevronRightIcon, ClockIcon, MapPinIcon, PencilIcon, ReceiptIndianRupeeIcon, Trash2Icon, UserIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { formatAmount, useDeletePhotoNote } from './api';
import { EditPhotoNoteDialog, PhotoNoteToExpenseDialog } from './PhotoNoteDialogs';
import { PhotoNoteImage, usePhotoUrl } from './use-photo-url';

export const CATEGORY_BADGE: Record<PhotoNoteDto['category'], 'warning' | 'destructive' | 'success' | 'info'> = {
  BILL: 'warning',
  RECEIPT: 'destructive',
  VISIT: 'success',
  OTHER: 'info',
};

/** Who the note is about / who uploaded it: "Ravi (uploaded by Admin)". */
export function personLine(n: PhotoNoteDto, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (n.objectName && n.userName && n.objectName !== n.userName) return t('{{person}} (uploaded by {{user}})', { person: n.objectName, user: n.userName });
  return n.objectName ?? n.userName ?? '—';
}

/**
 * Full-size photos of one note (prev / next, keyboard arrows) with its note, time, address, amount, person and source;
 * edit, delete and "Send to Fuel & expenses" when allowed. Used by the Photos & notes page and the map pins.
 */
export function PhotoNoteLightbox({ note: initial, onClose }: { note: PhotoNoteDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [note, setNote] = useState(initial);
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toExpense, setToExpense] = useState(false);
  const remove = useDeletePhotoNote();
  useEffect(() => {
    setNote(initial);
    setIndex(0);
  }, [initial]);

  const photos = note.photos;
  const photo = photos[Math.min(index, photos.length - 1)];
  const { url, error } = usePhotoUrl(note.id, photo?.id ?? null, 'full');
  const count = photos.length;
  const prev = () => setIndex((i) => (i - 1 + count) % count);
  const next = () => setIndex((i) => (i + 1) % count);
  const amount = formatAmount(note.amountMinor, note.currency);
  const canExpense = PHOTO_NOTE_MONEY_CATEGORIES.includes(note.category) && !note.expenseId && can('expenses', 'create') && note.amountMinor != null && note.amountMinor > 0;
  const busy = editing || deleting || toExpense;

  return (
    <>
      <Dialog open={!busy} onOpenChange={(o) => !o && !busy && onClose()}>
        <DialogContent
          className="w-[calc(100%-1rem)] max-w-5xl gap-0 p-0 sm:max-w-5xl"
          onKeyDown={(e) => {
            if (count < 2) return;
            if (e.key === 'ArrowLeft') prev();
            else if (e.key === 'ArrowRight') next();
          }}
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
            <div className="relative flex min-h-[260px] flex-1 items-center justify-center bg-black md:min-h-[480px]">
              {url ? (
                <img src={url} alt={note.note ?? t(PHOTO_NOTE_CATEGORY_LABELS[note.category])} className="max-h-[70dvh] max-w-full object-contain" />
              ) : error ? (
                <p className="text-sm text-white/80">{t("Couldn't load the photo")}</p>
              ) : (
                <Spinner className="text-white" />
              )}
              {count > 1 && (
                <>
                  <Button variant="secondary" size="icon" className="absolute top-1/2 left-2 -translate-y-1/2 rounded-full opacity-90" onClick={prev} aria-label={t('Previous photo')}>
                    <ChevronLeftIcon />
                  </Button>
                  <Button variant="secondary" size="icon" className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full opacity-90" onClick={next} aria-label={t('Next photo')}>
                    <ChevronRightIcon />
                  </Button>
                  <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white tabular-nums">
                    {t('{{n}} of {{count}}', { n: index + 1, count })}
                  </span>
                </>
              )}
            </div>
            <div className="flex w-full shrink-0 flex-col gap-3 p-5 md:w-80 md:overflow-y-auto">
              <div className="space-y-1 pr-6">
                <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
                  <Badge variant={CATEGORY_BADGE[note.category]}>{t(PHOTO_NOTE_CATEGORY_LABELS[note.category])}</Badge>
                  {amount && <span className="font-semibold tabular-nums">{amount}</span>}
                </DialogTitle>
                <DialogDescription className="text-xs">{t('From {{source}}', { source: t(PHOTO_NOTE_SOURCE_LABELS[note.source]) })}</DialogDescription>
              </div>
              {note.note && <p className="text-sm break-words whitespace-pre-wrap">{note.note}</p>}
              <div className="space-y-2 text-sm">
                <div className="flex gap-2">
                  <ClockIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="tabular-nums">{formatDateTime(note.takenAt)}</div>
                </div>
                <div className="flex gap-2">
                  <MapPinIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    {note.address && <span className="block break-words">{note.address}</span>}
                    <span className="block text-xs text-muted-foreground tabular-nums">
                      {note.lat.toFixed(6)}, {note.lng.toFixed(6)}
                      {note.accuracyM != null && ` · ±${Math.round(note.accuracyM)} m`}
                    </span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <UserIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div>{personLine(note, t)}</div>
                </div>
                {note.expenseId && (
                  <div className="flex gap-2">
                    <ReceiptIndianRupeeIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div>{t('Added to Fuel & expenses')}</div>
                  </div>
                )}
              </div>
              {count > 1 && (
                <div className="flex flex-wrap gap-1.5">
                  {photos.map((p, i) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setIndex(i)}
                      aria-label={t('Photo {{n}}', { n: i + 1 })}
                      aria-current={i === index || undefined}
                      className={cn('overflow-hidden rounded-md border-2', i === index ? 'border-primary' : 'border-transparent opacity-80 hover:opacity-100')}
                    >
                      <PhotoNoteImage noteId={note.id} photoId={p.id} alt="" className="size-12 object-cover" />
                    </button>
                  ))}
                </div>
              )}
              {(note.canEdit || note.canDelete || canExpense) && (
                <div className="mt-auto flex flex-wrap gap-2 border-t pt-3">
                  {canExpense && (
                    <Button size="sm" variant="outline" onClick={() => setToExpense(true)}>
                      <ReceiptIndianRupeeIcon /> {t('Send to Fuel & expenses')}
                    </Button>
                  )}
                  {note.canEdit && (
                    <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                      <PencilIcon /> {t('Edit')}
                    </Button>
                  )}
                  {note.canDelete && (
                    <Button size="sm" variant="outline" className="text-destructive" onClick={() => setDeleting(true)}>
                      <Trash2Icon /> {t('Delete')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {editing && <EditPhotoNoteDialog note={note} onClose={() => setEditing(false)} onSaved={setNote} />}
      {toExpense && <PhotoNoteToExpenseDialog note={note} onClose={() => setToExpense(false)} onSaved={setNote} />}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('Delete this photo note?')}
        description={t('The note and its photos are removed for everyone.')}
        confirmLabel={t('Delete')}
        destructive
        pending={remove.isPending}
        onConfirm={() =>
          remove.mutate(note.id, {
            onSuccess: () => {
              toast.success(t('Photo note deleted'));
              setDeleting(false);
              onClose();
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
    </>
  );
}
