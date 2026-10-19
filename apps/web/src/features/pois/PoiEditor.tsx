import { zodResolver } from '@hookform/resolvers/zod';
import { POI_DEFAULT_COLOR, POI_DEFAULT_RADIUS_M, POI_MAX_RADIUS_M, POI_MIN_RADIUS_M, type BranchDto, type PoiDto } from '@veetracer/shared';
import { useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import { FormDialog, useSaveMutation } from '@/features/masters/FormDialog';
import { ComboboxField, SelectField, SwitchField, TextField } from '@/features/masters/form-fields';
import { nullIfBlank, numericText, optionalText, requiredText, str } from '@/features/masters/form-schema';
import type { MasterFormProps } from '@/features/masters/types';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { cn } from '@/lib/utils';
import { POI_COLORS, POIS_ENDPOINT, usePoiCategoryOptions } from './api';
import { PoiMap } from './PoiMap';

const schema = z.object({
  name: requiredText(100),
  category: z.string().min(1, 'Required'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a #rrggbb colour'),
  radiusM: numericText({ min: POI_MIN_RADIUS_M, max: POI_MAX_RADIUS_M, required: true, integer: true }),
  lat: numericText({ min: -90, max: 90, required: true }),
  lng: numericText({ min: -180, max: 180, required: true }),
  branchId: z.string().nullable(),
  address: optionalText(300),
  description: optionalText(1000),
  isActive: z.boolean(),
});
type Values = z.infer<typeof schema>;

/** Create / edit a point of interest: details on one side, a click-to-place map with the radius on the other. */
export function PoiEditor({ record, open, onOpenChange }: MasterFormProps<PoiDto>) {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const assignedScope = me?.dataScope === 'ASSIGNED';
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: str(record?.name),
      category: record?.category ?? 'OTHER',
      color: record?.color ?? POI_DEFAULT_COLOR,
      radiusM: str(record?.radiusM ?? POI_DEFAULT_RADIUS_M),
      lat: record ? record.lat.toFixed(6) : '',
      lng: record ? record.lng.toFixed(6) : '',
      branchId: record?.branchId ?? null,
      address: str(record?.address),
      description: str(record?.description),
      isActive: record?.isActive ?? true,
    },
  });
  const categories = usePoiCategoryOptions();
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: open && can('branches') });
  const save = useSaveMutation<unknown>({ endpoint: POIS_ENDPOINT, id: record?.id ?? null, entity: 'POI', onSaved: () => onOpenChange(false) });

  const [latText, lngText, radiusText, color] = form.watch(['lat', 'lng', 'radiusM', 'color']);
  const position = useMemo(() => {
    const lat = Number(latText);
    const lng = Number(lngText);
    if (latText.trim() === '' || lngText.trim() === '' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
  }, [latText, lngText]);
  const radius = Math.min(POI_MAX_RADIUS_M, Math.max(0, Number(radiusText) || 0));

  const place = (p: { lat: number; lng: number }) => {
    form.setValue('lat', p.lat.toFixed(6), { shouldValidate: form.formState.isSubmitted, shouldDirty: true });
    form.setValue('lng', p.lng.toFixed(6), { shouldValidate: form.formState.isSubmitted, shouldDirty: true });
  };

  const submit = form.handleSubmit((v) => {
    if (assignedScope && !v.branchId) {
      form.setError('branchId', { message: t('Choose one of your branches as owner') });
      return;
    }
    save.mutate({
      name: v.name.trim(),
      category: v.category,
      color: v.color,
      radiusM: Number(v.radiusM),
      lat: Number(v.lat),
      lng: Number(v.lng),
      branchId: v.branchId,
      address: nullIfBlank(v.address),
      description: nullIfBlank(v.description),
      isActive: v.isActive,
    });
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={record ? 'Edit point of interest' : 'Add point of interest'}
      description="Click the map to place the point; vehicles stopping within the radius count as visits."
      onSubmit={submit}
      pending={save.isPending}
      error={save.error}
      wide
    >
      <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
        <div className="space-y-3">
          <PoiMap position={position} radiusM={radius} color={color} onChange={place} className="h-64 md:h-80" />
          <div className="grid grid-cols-3 gap-2">
            <TextField form={form} name="lat" label="Latitude" type="number" required />
            <TextField form={form} name="lng" label="Longitude" type="number" required />
            <TextField form={form} name="radiusM" label="Radius (m)" type="number" required hint={`${POI_MIN_RADIUS_M}–${POI_MAX_RADIUS_M.toLocaleString()} m`} />
          </div>
        </div>
        <div className="space-y-3">
          <TextField form={form} name="name" label="Name" required />
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField form={form} name="category" label="Category" options={categories.options} required />
            {can('branches') ? (
              <ComboboxField
                form={form}
                name="branchId"
                label="Owner branch"
                options={branches.options}
                loading={branches.loading}
                placeholder={assignedScope ? 'Choose a branch' : 'Company-wide'}
                hint={assignedScope ? undefined : 'Empty = shared company-wide'}
                required={assignedScope}
                selectedOption={record?.branchId ? { value: record.branchId, label: record.branchName ?? '' } : null}
              />
            ) : (
              <Field label={t('Owner branch')}>
                <Input value={record?.branchName ?? t('Company-wide')} disabled />
              </Field>
            )}
          </div>
          <Field label={t('Colour')}>
            <Controller
              control={form.control}
              name="color"
              render={({ field }) => (
                <div className="flex flex-wrap items-center gap-1.5">
                  {POI_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={t('Colour {{color}}', { color: c })}
                      aria-pressed={field.value.toLowerCase() === c}
                      onClick={() => field.onChange(c)}
                      className={cn('size-7 rounded-full border-2 transition-transform focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none', field.value.toLowerCase() === c ? 'scale-110 border-foreground' : 'border-transparent')}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                  <input type="color" aria-label={t('Custom colour')} value={field.value} onChange={(e) => field.onChange(e.target.value)} className="h-7 w-9 cursor-pointer rounded border bg-transparent" />
                </div>
              )}
            />
          </Field>
          <TextField form={form} name="address" label="Address" placeholder="Optional" />
          <TextField form={form} name="description" label="Description" multiline />
          <SwitchField form={form} name="isActive" label="Active" hint="Inactive POIs are hidden from the map and reports" />
        </div>
      </div>
    </FormDialog>
  );
}
