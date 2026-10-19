import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_NOTIFY_BEFORE_DAYS,
  DEFAULT_NOTIFY_BEFORE_KM,
  DEFAULT_REMINDER_DAYS,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MIME_TYPES,
  type DocumentDto,
  type DriverDto,
  type ServiceReminderDto,
  type TrackedObjectDto,
} from '@veetracer/shared';
import { DownloadIcon, PaperclipIcon, XIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import type { Option } from '@/components/ui/multi-select';
import { useAuth } from '@/features/auth/auth-context';
import { FormDialog } from '@/features/masters/FormDialog';
import { ComboboxField, SelectField, SwitchField, TextField } from '@/features/masters/form-fields';
import { nullIfBlank, numberOrNull, numericText, optionalText, requiredText, str } from '@/features/masters/form-schema';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, downloadFile, errorMessage } from '@/lib/api';
import { DOCUMENTS_ENDPOINT, formatKm, SERVICES_ENDPOINT, useDocumentTypeOptions } from './status';

const objectOption = (o: TrackedObjectDto): Option => ({ value: o.id, label: o.name, description: o.plateNumber ?? undefined });

/** Refreshes every list that shows documents or service reminders. */
export function useInvalidateCompliance() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of [['master', DOCUMENTS_ENDPOINT], ['documents'], ['service-reminders'], ['service-records'], ['compliance-summary']]) void queryClient.invalidateQueries({ queryKey: key });
  };
}

export function downloadDocument(d: DocumentDto) {
  return downloadFile(`${DOCUMENTS_ENDPOINT}/${d.id}/file`, d.file?.name ?? 'document').catch((err) => toast.error(errorMessage(err)));
}

const sizeText = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

// ───────────── Document ─────────────

const docSchema = z
  .object({
    owner: z.enum(['VEHICLE', 'DRIVER']),
    objectId: z.string().nullable(),
    driverId: z.string().nullable(),
    type: z.string().min(1, 'Required'),
    number: optionalText(60),
    issuedOn: z.string(),
    expiresOn: z.string(),
    reminderDays: numericText({ min: 0, max: 365, required: true, integer: true }),
    notes: optionalText(500),
  })
  .refine((v) => (v.owner === 'VEHICLE' ? !!v.objectId : !!v.driverId), { path: ['objectId'], message: 'Required' })
  .refine((v) => !v.issuedOn || !v.expiresOn || v.issuedOn <= v.expiresOn, { path: ['expiresOn'], message: 'The expiry date is before the issue date' });
type DocValues = z.infer<typeof docSchema>;

/** Add / edit a document; the scan or photo is uploaded right after the record is saved. */
export function DocumentForm({
  record,
  open,
  onOpenChange,
  preset,
}: {
  record: DocumentDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** New document for this vehicle / driver (fixed). */
  preset?: { objectId?: string; driverId?: string; label: string };
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const invalidate = useInvalidateCompliance();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [removeFile, setRemoveFile] = useState(false);
  const [objectQ, setObjectQ] = useState('');
  const [driverQ, setDriverQ] = useState('');
  const form = useForm<DocValues>({
    resolver: zodResolver(docSchema),
    defaultValues: {
      owner: record?.owner ?? (preset?.driverId ? 'DRIVER' : 'VEHICLE'),
      objectId: record?.objectId ?? preset?.objectId ?? null,
      driverId: record?.driverId ?? preset?.driverId ?? null,
      type: record?.type ?? (preset?.driverId ? 'DRIVING_LICENCE' : ''),
      number: str(record?.number),
      issuedOn: str(record?.issuedOn),
      expiresOn: str(record?.expiresOn),
      reminderDays: str(record?.reminderDays ?? DEFAULT_REMINDER_DAYS),
      notes: str(record?.notes),
    },
  });
  const owner = form.watch('owner');
  const types = useDocumentTypeOptions(owner);
  const fixed = !!preset;
  const objects = useEntityOptions<TrackedObjectDto>('/objects', objectOption, { q: objectQ, enabled: open && !fixed && owner === 'VEHICLE' && can('objects') });
  const drivers = useEntityOptions<DriverDto>('/drivers', named, { q: driverQ, enabled: open && !fixed && owner === 'DRIVER' });

  const save = useMutation({
    mutationFn: async (v: DocValues) => {
      const body = {
        objectId: v.owner === 'VEHICLE' ? v.objectId : null,
        driverId: v.owner === 'DRIVER' ? v.driverId : null,
        type: v.type,
        number: nullIfBlank(v.number),
        issuedOn: v.issuedOn || null,
        expiresOn: v.expiresOn || null,
        reminderDays: Number(v.reminderDays),
        notes: nullIfBlank(v.notes),
      };
      const saved = record ? await api.patch<DocumentDto>(`${DOCUMENTS_ENDPOINT}/${record.id}`, body) : await api.post<DocumentDto>(DOCUMENTS_ENDPOINT, body);
      try {
        if (file) {
          const data = new FormData();
          data.append('file', file);
          await api.upload<DocumentDto>(`${DOCUMENTS_ENDPOINT}/${saved.id}/file`, data);
        } else if (removeFile && record?.file) {
          await api.delete(`${DOCUMENTS_ENDPOINT}/${saved.id}/file`);
        }
      } catch (err) {
        toast.error(t('Saved, but the file was not uploaded: {{error}}', { error: errorMessage(err) }));
      }
      return saved;
    },
    onSuccess: () => {
      toast.success(record ? t('Document updated') : t('Document added'));
      invalidate();
      onOpenChange(false);
    },
  });

  const pickFile = (f: File | null) => {
    if (!f) return;
    if (f.size > DOCUMENT_MAX_BYTES) return toast.error(t('The file is larger than 10 MB'));
    if (!(DOCUMENT_MIME_TYPES as readonly string[]).includes(f.type)) return toast.error(t('Upload a PDF or an image (JPEG, PNG, WebP, HEIC)'));
    setFile(f);
    setRemoveFile(false);
  };
  const currentFile = !removeFile && !file ? record?.file : null;

  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={record ? 'Edit document' : 'Add document'} wide pending={save.isPending} error={save.error} onSubmit={form.handleSubmit((v) => save.mutate(v))}>
      <div className="grid gap-4 sm:grid-cols-2">
        {fixed ? (
          <Field label={owner === 'DRIVER' ? t('Driver') : t('Vehicle')} className="sm:col-span-2">
            <Input value={preset.label} disabled />
          </Field>
        ) : (
          <>
            <SelectField
              form={form}
              name="owner"
              label="Belongs to"
              required
              options={[
                { value: 'VEHICLE', label: 'Vehicle' },
                { value: 'DRIVER', label: 'Driver' },
              ]}
            />
            {owner === 'VEHICLE' ? (
              <ComboboxField
                form={form}
                name="objectId"
                label="Vehicle"
                required
                options={objects.options}
                loading={objects.loading}
                onSearch={setObjectQ}
                selectedOption={record?.objectId ? { value: record.objectId, label: record.objectName ?? '' } : null}
              />
            ) : (
              <ComboboxField
                form={form}
                name="driverId"
                label="Driver"
                required
                options={drivers.options}
                loading={drivers.loading}
                onSearch={setDriverQ}
                selectedOption={record?.driverId ? { value: record.driverId, label: record.driverName ?? '' } : null}
              />
            )}
          </>
        )}
        <SelectField form={form} name="type" label="Document" required options={types.options} placeholder="Choose the document" />
        <TextField form={form} name="number" label="Number" placeholder="Policy / certificate number" />
        <TextField form={form} name="issuedOn" label="Issued on" type="date" />
        <TextField form={form} name="expiresOn" label="Expires on" type="date" hint="Leave empty for documents that don't expire." />
        <TextField form={form} name="reminderDays" label="Remind before (days)" type="number" hint="Reminder alerts start this many days before expiry." />
      </div>
      <TextField form={form} name="notes" label="Notes" multiline />
      <Field label={t('File (PDF or photo, up to 10 MB)')}>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileInput} type="file" accept={DOCUMENT_MIME_TYPES.join(',')} className="hidden" onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
          <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
            <PaperclipIcon /> {currentFile || file ? t('Replace file') : t('Attach file')}
          </Button>
          {file && (
            <span className="flex items-center gap-1 text-sm">
              {file.name} <span className="text-muted-foreground">({sizeText(file.size)})</span>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t('Remove')} onClick={() => setFile(null)}>
                <XIcon />
              </Button>
            </span>
          )}
          {currentFile && record && (
            <span className="flex items-center gap-1 text-sm">
              <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => void downloadDocument(record)}>
                <DownloadIcon /> {currentFile.name}
              </Button>
              <span className="text-muted-foreground">({sizeText(currentFile.size)})</span>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t('Remove file')} onClick={() => setRemoveFile(true)}>
                <XIcon />
              </Button>
            </span>
          )}
          {removeFile && <span className="text-sm text-muted-foreground">{t('The file will be removed when you save.')}</span>}
        </div>
      </Field>
    </FormDialog>
  );
}

// ───────────── Service reminder ─────────────

const serviceSchema = z
  .object({
    objectId: z.string().nullable(),
    title: requiredText(80),
    intervalKm: numericText({ min: 1, max: 1_000_000, integer: true }),
    intervalDays: numericText({ min: 1, max: 3650, integer: true }),
    lastDoneAt: z.string(),
    lastDoneOdometerKm: numericText({ min: 0, max: 10_000_000 }),
    notifyBeforeKm: numericText({ min: 0, max: 100_000, required: true, integer: true }),
    notifyBeforeDays: numericText({ min: 0, max: 365, required: true, integer: true }),
    notes: optionalText(500),
    isActive: z.boolean(),
  })
  .refine((v) => !!v.objectId, { path: ['objectId'], message: 'Required' })
  .refine((v) => v.intervalKm.trim() !== '' || v.intervalDays.trim() !== '', { path: ['intervalKm'], message: 'Set an interval in km, in days, or both' });
type ServiceValues = z.infer<typeof serviceSchema>;

export function ServiceForm({
  record,
  open,
  onOpenChange,
  preset,
}: {
  record: ServiceReminderDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset?: { objectId: string; label: string };
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const invalidate = useInvalidateCompliance();
  const [objectQ, setObjectQ] = useState('');
  const form = useForm<ServiceValues>({
    resolver: zodResolver(serviceSchema),
    defaultValues: {
      objectId: record?.objectId ?? preset?.objectId ?? null,
      title: str(record?.title),
      intervalKm: str(record?.intervalKm),
      intervalDays: str(record?.intervalDays),
      lastDoneAt: str(record?.lastDoneAt),
      lastDoneOdometerKm: str(record?.lastDoneOdometerKm),
      notifyBeforeKm: str(record?.notifyBeforeKm ?? DEFAULT_NOTIFY_BEFORE_KM),
      notifyBeforeDays: str(record?.notifyBeforeDays ?? DEFAULT_NOTIFY_BEFORE_DAYS),
      notes: str(record?.notes),
      isActive: record?.isActive ?? true,
    },
  });
  const objects = useEntityOptions<TrackedObjectDto>('/objects', objectOption, { q: objectQ, enabled: open && !preset && can('objects') });
  const save = useMutation({
    mutationFn: (v: ServiceValues) => {
      const body = {
        objectId: v.objectId,
        title: v.title.trim(),
        intervalKm: numberOrNull(v.intervalKm),
        intervalDays: numberOrNull(v.intervalDays),
        ...(record || v.lastDoneAt ? { lastDoneAt: v.lastDoneAt || null } : {}),
        ...(record || v.lastDoneOdometerKm.trim() ? { lastDoneOdometerKm: numberOrNull(v.lastDoneOdometerKm) } : {}),
        notifyBeforeKm: Number(v.notifyBeforeKm),
        notifyBeforeDays: Number(v.notifyBeforeDays),
        notes: nullIfBlank(v.notes),
        isActive: v.isActive,
      };
      return record ? api.patch<ServiceReminderDto>(`${SERVICES_ENDPOINT}/${record.id}`, body) : api.post<ServiceReminderDto>(SERVICES_ENDPOINT, body);
    },
    onSuccess: () => {
      toast.success(record ? t('Service reminder updated') : t('Service reminder added'));
      invalidate();
      onOpenChange(false);
    },
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={record ? 'Edit service reminder' : 'Add service reminder'}
      description="Due by date, by odometer, or whichever comes first. The odometer is the distance recorded by VeeTrax plus the vehicle's odometer offset."
      wide
      pending={save.isPending}
      error={save.error}
      onSubmit={form.handleSubmit((v) => save.mutate(v))}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {preset ? (
          <Field label={t('Vehicle')}>
            <Input value={preset.label} disabled />
          </Field>
        ) : (
          <ComboboxField
            form={form}
            name="objectId"
            label="Vehicle"
            required
            options={objects.options}
            loading={objects.loading}
            onSearch={setObjectQ}
            selectedOption={record ? { value: record.objectId, label: record.objectName } : null}
          />
        )}
        <TextField form={form} name="title" label="Service" required placeholder="e.g. Engine oil" />
        <TextField form={form} name="intervalKm" label="Every (km)" type="number" placeholder="e.g. 10000" />
        <TextField form={form} name="intervalDays" label="Every (days)" type="number" placeholder="e.g. 180" />
        <TextField form={form} name="lastDoneAt" label="Last done on" type="date" hint={record ? undefined : 'Empty = today'} />
        <TextField form={form} name="lastDoneOdometerKm" label="Last done at (km)" type="number" hint={record ? undefined : 'Empty = odometer now'} />
        <TextField form={form} name="notifyBeforeKm" label="Remind before (km)" type="number" />
        <TextField form={form} name="notifyBeforeDays" label="Remind before (days)" type="number" />
      </div>
      <TextField form={form} name="notes" label="Notes" multiline />
      <SwitchField form={form} name="isActive" label="Active" hint="Inactive reminders raise no alerts." />
    </FormDialog>
  );
}

/** Records a completed service and rolls the reminder forward. */
export function MarkDoneDialog({ reminder, onOpenChange }: { reminder: ServiceReminderDto | null; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const invalidate = useInvalidateCompliance();
  const today = new Date().toLocaleDateString('en-CA');
  const [doneAt, setDoneAt] = useState(today);
  const [odometer, setOdometer] = useState('');
  const [cost, setCost] = useState('');
  const [notes, setNotes] = useState('');
  const [endMaintenance, setEndMaintenance] = useState(true);
  const [lastId, setLastId] = useState<string | null>(null);
  if (reminder && reminder.id !== lastId) {
    setLastId(reminder.id);
    setDoneAt(today);
    setOdometer(reminder.odometerKm !== null ? String(Math.round(reminder.odometerKm)) : '');
    setCost('');
    setNotes('');
    setEndMaintenance(true);
  }
  const done = useMutation({
    mutationFn: () =>
      api.post<ServiceReminderDto>(`${SERVICES_ENDPOINT}/${reminder!.id}/done`, {
        doneAt,
        odometerKm: numberOrNull(odometer),
        cost: numberOrNull(cost),
        notes: nullIfBlank(notes),
        endMaintenance: reminder!.inMaintenance && can('objects', 'edit') ? endMaintenance : false,
      }),
    onSuccess: (r) => {
      toast.success(t('{{title}} done on {{vehicle}}', { title: r.title, vehicle: r.objectName }));
      invalidate();
      onOpenChange(false);
    },
  });
  const odoInvalid = odometer.trim() !== '' && !(Number(odometer) >= 0);
  const costInvalid = cost.trim() !== '' && !(Number(cost) >= 0);
  return (
    <FormDialog
      open={!!reminder}
      onOpenChange={onOpenChange}
      title="Mark service done"
      description={reminder ? `${reminder.title} · ${reminder.objectName}` : undefined}
      submitLabel="Mark done"
      pending={done.isPending}
      error={done.error}
      onSubmit={(e) => {
        e.preventDefault();
        if (!odoInvalid && !costInvalid && doneAt) done.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('Done on')} htmlFor="sd-date" required>
          <Input id="sd-date" type="date" max={today} value={doneAt} onChange={(e) => setDoneAt(e.target.value)} />
        </Field>
        <Field label={t('Odometer (km)')} htmlFor="sd-odo" hint={reminder ? t('Now: {{km}}', { km: formatKm(reminder.odometerKm) }) : undefined} error={odoInvalid ? t('Enter a number') : undefined}>
          <Input id="sd-odo" type="number" min={0} value={odometer} onChange={(e) => setOdometer(e.target.value)} />
        </Field>
        <Field label={t('Cost (₹)')} htmlFor="sd-cost" error={costInvalid ? t('Enter a number') : undefined}>
          <Input id="sd-cost" type="number" min={0} step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} />
        </Field>
      </div>
      <Field label={t('Notes')} htmlFor="sd-notes">
        <Textarea id="sd-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('Workshop, parts replaced…')} />
      </Field>
      {reminder?.inMaintenance && can('objects', 'edit') && (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={endMaintenance} onCheckedChange={(v) => setEndMaintenance(v === true)} />
          {t('Also end maintenance for this vehicle (alerts resume)')}
        </label>
      )}
    </FormDialog>
  );
}
