import {
  EXPENSE_KIND_LABELS,
  EXPENSE_KINDS,
  PHOTO_NOTE_CATEGORIES,
  PHOTO_NOTE_CATEGORY_LABELS,
  PHOTO_NOTE_MONEY_CATEGORIES,
  PHOTO_NOTE_NOTE_MAX,
  type ExpenseKind,
  type PhotoNoteCategory,
  type PhotoNoteDto,
} from '@veetracer/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Combobox } from '@/components/ui/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { errorMessage } from '@/lib/api';
import { formatAmount, rupeesToMinor, usePhotoNoteToExpense, useUpdatePhotoNote } from './api';

export function CategorySelect({ id, value, onChange }: { id?: string; value: PhotoNoteCategory; onChange: (c: PhotoNoteCategory) => void }) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={(v) => onChange(v as PhotoNoteCategory)}>
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PHOTO_NOTE_CATEGORIES.map((c) => (
          <SelectItem key={c} value={c}>
            {t(PHOTO_NOTE_CATEGORY_LABELS[c])}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Object picker (server-side search over the tracked objects). */
export function ObjectPicker({ id, value, onChange, placeholder }: { id?: string; value: string | null; onChange: (v: string | null) => void; placeholder: string }) {
  const [q, setQ] = useState('');
  const objects = useEntityOptions<{ id: string; name: string }>('/objects', named, { q });
  return <Combobox id={id} value={value} onChange={onChange} options={objects.options} onSearch={setQ} loading={objects.loading} placeholder={placeholder} />;
}

const minorToRupees = (m: number | null) => (m == null ? '' : String(m / 100));

/** Change the note, category and amount of a photo note. */
export function EditPhotoNoteDialog({ note, onClose, onSaved }: { note: PhotoNoteDto; onClose: () => void; onSaved?: (n: PhotoNoteDto) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(note.note ?? '');
  const [category, setCategory] = useState<PhotoNoteCategory>(note.category);
  const [amount, setAmount] = useState(minorToRupees(note.amountMinor));
  const update = useUpdatePhotoNote();
  const money = PHOTO_NOTE_MONEY_CATEGORIES.includes(category);
  const amountMinor = money ? rupeesToMinor(amount) : null;
  const amountInvalid = money && amount.trim() !== '' && amountMinor === null;

  const save = () =>
    update.mutate(
      { id: note.id, patch: { note: text.trim() || null, category, amountMinor, currency: amountMinor != null ? (note.currency ?? 'INR') : null } },
      {
        onSuccess: (n) => {
          toast.success(t('Photo note saved'));
          onSaved?.(n);
          onClose();
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Edit photo note')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Field label={t('Category')} htmlFor="pn-edit-category">
            <CategorySelect id="pn-edit-category" value={category} onChange={setCategory} />
          </Field>
          {money && (
            <Field label={t('Amount (₹)')} htmlFor="pn-edit-amount" error={amountInvalid ? t('Enter a valid amount') : undefined}>
              <Input id="pn-edit-amount" type="number" inputMode="decimal" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
          )}
          <Field label={t('Note')} htmlFor="pn-edit-note">
            <Textarea id="pn-edit-note" value={text} maxLength={PHOTO_NOTE_NOTE_MAX} onChange={(e) => setText(e.target.value)} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button onClick={save} disabled={update.isPending || amountInvalid}>
            {update.isPending && <Spinner />} {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Send to Fuel & expenses": creates an expense from a bill / receipt note. */
export function PhotoNoteToExpenseDialog({ note, onClose, onSaved }: { note: PhotoNoteDto; onClose: () => void; onSaved?: (n: PhotoNoteDto) => void }) {
  const { t } = useTranslation();
  const [objectId, setObjectId] = useState<string | null>(note.objectId);
  const [kind, setKind] = useState<ExpenseKind>('OTHER');
  const [vendor, setVendor] = useState('');
  const send = usePhotoNoteToExpense();
  const amount = formatAmount(note.amountMinor, note.currency);
  const valid = !!objectId && note.amountMinor != null && note.amountMinor > 0;

  const submit = () =>
    send.mutate(
      { id: note.id, input: { objectId: note.objectId ? undefined : (objectId ?? undefined), kind, vendor: vendor.trim() || undefined } },
      {
        onSuccess: (n) => {
          toast.success(t('Added to Fuel & expenses'));
          onSaved?.(n);
          onClose();
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Send to Fuel & expenses')}</DialogTitle>
          <DialogDescription>{amount ? t('An expense of {{amount}} is created with this photo as the bill.', { amount }) : t('Add an amount to the note first.')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {!note.objectId && (
            <Field label={t('Vehicle')} htmlFor="pn-exp-object">
              <ObjectPicker id="pn-exp-object" value={objectId} onChange={setObjectId} placeholder={t('Choose a vehicle')} />
            </Field>
          )}
          <Field label={t('Type')} htmlFor="pn-exp-kind">
            <Select value={kind} onValueChange={(v) => setKind(v as ExpenseKind)}>
              <SelectTrigger id="pn-exp-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPENSE_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(EXPENSE_KIND_LABELS[k])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('Fuel station / vendor (optional)')} htmlFor="pn-exp-vendor">
            <Input id="pn-exp-vendor" value={vendor} maxLength={120} onChange={(e) => setVendor(e.target.value)} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button onClick={submit} disabled={!valid || send.isPending}>
            {send.isPending && <Spinner />} {t('Create expense')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
