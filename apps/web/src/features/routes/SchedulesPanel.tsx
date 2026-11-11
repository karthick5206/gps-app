import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { PLANNED_TRIP_TIMING, type DriverDto, type RouteScheduleDto, type RouteScheduleInput, type TrackedObjectDto } from '@veetracer/shared';
import { AlertTriangleIcon, CalendarClockIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { Option } from '@/components/ui/multi-select';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import { FormDialog, useInvalidateMaster } from '@/features/masters/FormDialog';
import { ComboboxField, SwitchField } from '@/features/masters/form-fields';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ROUTES_ENDPOINT, useRouteSchedules } from './api';
import { formatDays, minutesToTime, timeToMinutes, toggleDay, WEEK_DISPLAY_ORDER, weekdayNames } from './schedule-days';

const objectOption = (o: TrackedObjectDto): Option => ({ value: o.id, label: o.name, description: o.plateNumber ?? undefined });

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const schema = z
  .object({
    days: z.array(z.number().int().min(0).max(6)).min(1, 'Choose at least one day'),
    start: z.string().refine((v) => timeToMinutes(v) !== null, 'Enter a time (HH:MM)'),
    objectId: z.string().nullable(),
    driverId: z.string().nullable(),
    validFrom: z.string().refine((v) => v === '' || DATE.test(v), 'Enter a date'),
    validTo: z.string().refine((v) => v === '' || DATE.test(v), 'Enter a date'),
    isActive: z.boolean(),
  })
  .refine((v) => !v.validFrom || !v.validTo || v.validFrom <= v.validTo, { path: ['validTo'], message: 'Valid to must not be before valid from' });
type Values = z.infer<typeof schema>;

/** Day names in the UI language (index 0 = Sunday) plus the words formatDays needs. */
function useDayWords() {
  const { t, i18n } = useTranslation();
  return useMemo(() => {
    let names: string[];
    try {
      names = weekdayNames(i18n.language || 'en');
    } catch {
      names = weekdayNames('en');
    }
    return { names, everyDay: t('Every day'), weekdays: t('Mon–Fri'), weekends: t('Weekends') };
  }, [i18n.language, t]);
}

function DayChips({ value, onChange, invalid }: { value: number[]; onChange: (days: number[]) => void; invalid?: boolean }) {
  const { t } = useTranslation();
  const words = useDayWords();
  return (
    <div role="group" aria-label={t('Days')} className={cn('flex flex-wrap gap-1.5', invalid && 'rounded-lg ring-1 ring-destructive/60')}>
      {WEEK_DISPLAY_ORDER.map((d) => {
        const on = value.includes(d);
        return (
          <button
            key={d}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(toggleDay(value, d))}
            className={cn(
              'h-8 min-w-11 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              on ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {words.names[d]}
          </button>
        );
      })}
    </div>
  );
}

function ScheduleForm({ routeId, schedule, open, onOpenChange }: { routeId: string; schedule: RouteScheduleDto | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const invalidate = useInvalidateMaster();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      days: schedule?.days ?? [1, 2, 3, 4, 5],
      start: schedule ? minutesToTime(schedule.startMin) : '08:00',
      objectId: schedule?.objectId ?? null,
      driverId: schedule?.driverId ?? null,
      validFrom: schedule?.validFrom ?? '',
      validTo: schedule?.validTo ?? '',
      isActive: schedule?.isActive ?? true,
    },
  });
  const [objectQ, setObjectQ] = useState('');
  const [driverQ, setDriverQ] = useState('');
  const objects = useEntityOptions<TrackedObjectDto>('/objects', objectOption, { q: objectQ, enabled: open && can('objects') });
  const drivers = useEntityOptions<DriverDto>('/drivers', named, { q: driverQ, enabled: open && can('drivers') });
  const objectId = form.watch('objectId');

  const save = useMutation({
    mutationFn: (body: RouteScheduleInput) =>
      schedule ? api.patch<RouteScheduleDto>(`${ROUTES_ENDPOINT}/${routeId}/schedules/${schedule.id}`, body) : api.post<RouteScheduleDto>(`${ROUTES_ENDPOINT}/${routeId}/schedules`, body),
    onSuccess: () => {
      toast.success(schedule ? t('Schedule updated') : t('Schedule added'));
      invalidate(ROUTES_ENDPOINT);
      onOpenChange(false);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const submit = form.handleSubmit((v) =>
    save.mutate({
      days: v.days,
      startMin: timeToMinutes(v.start) ?? 0,
      objectId: v.objectId,
      driverId: v.driverId,
      validFrom: v.validFrom || null,
      validTo: v.validTo || null,
      isActive: v.isActive,
    }),
  );
  const errors = form.formState.errors;

  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={schedule ? 'Edit schedule' : 'Add schedule'} onSubmit={submit} pending={save.isPending} error={save.error}>
      <Field label={t('Days')} required error={errors.days?.message ? t(errors.days.message) : undefined}>
        <Controller control={form.control} name="days" render={({ field }) => <DayChips value={field.value} onChange={field.onChange} invalid={!!errors.days} />} />
      </Field>
      <Field label={t('Start time')} htmlFor="sch-start" required hint={t('Company timezone')} error={errors.start?.message ? t(errors.start.message) : undefined}>
        <Input id="sch-start" type="time" step={60} aria-invalid={!!errors.start || undefined} {...form.register('start')} className="w-36" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <ComboboxField
          form={form}
          name="objectId"
          label="Vehicle"
          options={objects.options}
          loading={objects.loading}
          onSearch={setObjectQ}
          placeholder="Pick a vehicle…"
          hint="Needed to generate trips automatically"
          selectedOption={schedule?.objectId ? { value: schedule.objectId, label: schedule.objectName ?? '' } : null}
        />
        <ComboboxField
          form={form}
          name="driverId"
          label="Driver"
          options={drivers.options}
          loading={drivers.loading}
          onSearch={setDriverQ}
          placeholder="Optional"
          selectedOption={schedule?.driverId ? { value: schedule.driverId, label: schedule.driverName ?? '' } : null}
        />
      </div>
      {!objectId && (
        <p className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning-fg">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          {t('Without a vehicle this schedule creates no trips. Add one now or later.')}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Valid from')} htmlFor="sch-from" error={errors.validFrom?.message ? t(errors.validFrom.message) : undefined}>
          <Input id="sch-from" type="date" {...form.register('validFrom')} />
        </Field>
        <Field label={t('Valid to')} htmlFor="sch-to" error={errors.validTo?.message ? t(errors.validTo.message) : undefined}>
          <Input id="sch-to" type="date" aria-invalid={!!errors.validTo || undefined} {...form.register('validTo')} />
        </Field>
      </div>
      <SwitchField form={form} name="isActive" label="Active" hint="Inactive schedules create no trips" />
    </FormDialog>
  );
}

/** Schedules of a saved route: each active schedule with a vehicle creates planned trips on its days. */
export function SchedulesPanel({ routeId, readOnly }: { routeId: string; readOnly: boolean }) {
  const { t } = useTranslation();
  const words = useDayWords();
  const invalidate = useInvalidateMaster();
  const list = useRouteSchedules(routeId);
  const [editing, setEditing] = useState<RouteScheduleDto | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<RouteScheduleDto | null>(null);

  const remove = useMutation({
    mutationFn: (s: RouteScheduleDto) => api.delete<unknown>(`${ROUTES_ENDPOINT}/${routeId}/schedules/${s.id}`),
    onSuccess: () => {
      toast.success(t('Schedule deleted'));
      setDeleting(null);
      invalidate(ROUTES_ENDPOINT);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const rows = list.data ?? [];

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{t('Schedules')}</h3>
          <p className="text-xs text-muted-foreground">
            {t('Active schedules with a vehicle create planned trips on the chosen days, {{h}} h ahead (company timezone).', { h: PLANNED_TRIP_TIMING.generateAheadHours })}
          </p>
        </div>
        {!readOnly && (
          <Button onClick={() => setEditing(null)}>
            <PlusIcon /> {t('Add schedule')}
          </Button>
        )}
      </div>

      {list.isError && <FormError message={errorMessage(list.error)} />}
      {list.isPending && (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}
      {list.isSuccess && rows.length === 0 && (
        <EmptyState
          icon={CalendarClockIcon}
          title={t('No schedules yet')}
          description={t('Add a schedule to create trips on this route automatically. You can also create single trips under Planned trips.')}
        />
      )}
      <ul className="space-y-2">
        {rows.map((s) => (
          <li key={s.id} className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-card p-3', !s.isActive && 'opacity-70')}>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                <span className="tabular-nums">{minutesToTime(s.startMin)}</span>
                <span>·</span>
                <span>{formatDays(s.days, words)}</span>
                {!s.isActive && <Badge variant="muted">{t('Inactive')}</Badge>}
              </p>
              <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                {s.objectName ? (
                  <span>{s.objectName}</span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-warning-fg">
                    <AlertTriangleIcon className="size-3" /> {t('No vehicle — no trips are created')}
                  </span>
                )}
                {s.driverName && <span>{s.driverName}</span>}
                {(s.validFrom || s.validTo) && <span>{t('Valid {{from}} → {{to}}', { from: s.validFrom ?? '…', to: s.validTo ?? '…' })}</span>}
              </p>
            </div>
            {!readOnly && (
              <div className="flex gap-1">
                <Button variant="ghost" size="icon-sm" aria-label={t('Edit schedule')} onClick={() => setEditing(s)}>
                  <PencilIcon />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label={t('Delete schedule')} onClick={() => setDeleting(s)} className="text-muted-foreground hover:text-destructive">
                  <Trash2Icon />
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {editing !== undefined && <ScheduleForm routeId={routeId} schedule={editing} open onOpenChange={(o) => !o && setEditing(undefined)} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('Delete schedule?')}
        description={t('Trips already created stay as they are; no new trips are created from this schedule.')}
        confirmLabel={t('Delete')}
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}
