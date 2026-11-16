import {
  PHOTO_NOTE_MAX_BYTES,
  PHOTO_NOTE_MAX_PHOTOS,
  PHOTO_NOTE_MIME_TYPES,
  PHOTO_NOTE_MONEY_CATEGORIES,
  PHOTO_NOTE_NOTE_MAX,
  type PhotoNoteCategory,
} from '@veetracer/shared';
import { ImagePlusIcon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { isMissingLocationError, rupeesToMinor, useCreatePhotoNote } from './api';
import { LocationPickerMap } from './LocationPickerMap';
import { CategorySelect, ObjectPicker } from './PhotoNoteDialogs';

type LocationMode = 'exif' | 'map';
const MAX_MB = Math.round(PHOTO_NOTE_MAX_BYTES / (1024 * 1024));

/** Thumbnails of the chosen files (object URLs revoked when the list changes or the dialog closes). */
function usePreviews(files: File[]): string[] {
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  return urls;
}

/** "Add photo note": 1–5 photos, category, note, amount (bills / receipts), optional object and the place. */
export function AddPhotoNoteDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const create = useCreatePhotoNote();
  const fileInput = useRef<HTMLInputElement>(null);
  // One key per dialog: a retry after a network error returns the note already saved instead of a duplicate.
  const clientId = useRef(crypto.randomUUID());
  const [files, setFiles] = useState<File[]>([]);
  const [category, setCategory] = useState<PhotoNoteCategory>('VISIT');
  const [note, setNote] = useState('');
  const [amount, setAmount] = useState('');
  const [objectId, setObjectId] = useState<string | null>(null);
  const [mode, setMode] = useState<LocationMode>('exif');
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(null);
  const [locationMissing, setLocationMissing] = useState(false);
  const previews = usePreviews(files);
  const money = PHOTO_NOTE_MONEY_CATEGORIES.includes(category);
  const amountMinor = money ? rupeesToMinor(amount) : null;
  const amountInvalid = money && amount.trim() !== '' && amountMinor === null;
  const valid = files.length > 0 && !amountInvalid && (mode === 'exif' || !!position);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      if (!(PHOTO_NOTE_MIME_TYPES as readonly string[]).includes(f.type)) {
        toast.error(t('{{name}}: only JPEG, PNG or WebP photos can be added.', { name: f.name }));
        continue;
      }
      if (f.size > PHOTO_NOTE_MAX_BYTES) {
        toast.error(t('{{name}} is larger than {{mb}} MB.', { name: f.name, mb: MAX_MB }));
        continue;
      }
      if (next.length >= PHOTO_NOTE_MAX_PHOTOS) {
        toast.error(t('Up to {{count}} photos per note.', { count: PHOTO_NOTE_MAX_PHOTOS }));
        break;
      }
      next.push(f);
    }
    setFiles(next);
    if (fileInput.current) fileInput.current.value = '';
  };

  const save = () =>
    create.mutate(
      {
        photos: files,
        clientId: clientId.current,
        category,
        objectId,
        note,
        amountMinor,
        currency: 'INR',
        location: mode === 'map' ? position : null,
      },
      {
        onSuccess: () => {
          toast.success(t('Photo note saved'));
          onClose();
        },
        onError: (e) => {
          if (isMissingLocationError(e)) {
            setMode('map');
            setLocationMissing(true);
            toast.error(t('The photo has no location. Pick the place on the map.'));
          } else toast.error(errorMessage(e));
        },
      },
    );

  return (
    <Dialog open onOpenChange={(o) => !o && !create.isPending && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('Add photo note')}</DialogTitle>
          <DialogDescription>{t('Save photos of a place with a note, for example a bill, a receipt or a customer visit.')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Field label={t('Photos')} hint={t('Up to {{count}} JPEG, PNG or WebP photos, {{mb}} MB each.', { count: PHOTO_NOTE_MAX_PHOTOS, mb: MAX_MB })}>
            <div className="flex flex-wrap gap-2">
              {files.map((f, i) => (
                <div key={`${f.name}-${i}`} className="relative size-20 overflow-hidden rounded-md border">
                  <img src={previews[i]} alt={f.name} className="size-full object-cover" />
                  <button
                    type="button"
                    onClick={() => setFiles(files.filter((_, j) => j !== i))}
                    aria-label={t('Remove photo')}
                    className="absolute top-1 right-1 rounded-full bg-black/60 p-0.5 text-white hover:bg-black/80"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </div>
              ))}
              {files.length < PHOTO_NOTE_MAX_PHOTOS && (
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  className="flex size-20 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-xs text-muted-foreground hover:bg-accent"
                >
                  <ImagePlusIcon className="size-5" />
                  {t('Add photo')}
                </button>
              )}
            </div>
            <input ref={fileInput} type="file" accept={PHOTO_NOTE_MIME_TYPES.join(',')} multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('Category')} htmlFor="pn-category">
              <CategorySelect id="pn-category" value={category} onChange={setCategory} />
            </Field>
            {money && (
              <Field label={t('Amount (₹)')} htmlFor="pn-amount" error={amountInvalid ? t('Enter a valid amount') : undefined}>
                <Input id="pn-amount" type="number" inputMode="decimal" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </Field>
            )}
          </div>
          <Field label={t('Note (optional)')} htmlFor="pn-note">
            <Textarea id="pn-note" value={note} maxLength={PHOTO_NOTE_NOTE_MAX} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Field label={t('Vehicle or person (optional)')} htmlFor="pn-object">
            <ObjectPicker id="pn-object" value={objectId} onChange={setObjectId} placeholder={t('Choose a vehicle or person')} />
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t('Location')}</legend>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('Location')}>
              {(
                [
                  ['exif', t("Use the photo's location (EXIF)")],
                  ['map', t('Pick on the map')],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={mode === value}
                  onClick={() => setMode(value)}
                  className={cn('rounded-lg border px-3 py-1.5 text-sm', mode === value ? 'border-primary bg-primary/10 font-medium text-primary' : 'hover:bg-accent')}
                >
                  {label}
                </button>
              ))}
            </div>
            {mode === 'exif' ? (
              <p className="text-xs text-muted-foreground">{t('The place is read from the GPS data saved in the photo. If the photo has none, you will be asked to pick it on the map.')}</p>
            ) : (
              <>
                {locationMissing && <p className="text-xs text-destructive">{t('The photo has no location. Pick the place on the map.')}</p>}
                <LocationPickerMap position={position} onChange={setPosition} />
                {position && (
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {position.lat.toFixed(6)}, {position.lng.toFixed(6)}
                  </p>
                )}
              </>
            )}
          </fieldset>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>
            {t('Cancel')}
          </Button>
          <Button onClick={save} disabled={!valid || create.isPending}>
            {create.isPending && <Spinner />} {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
