import { zodResolver } from '@hookform/resolvers/zod';
import type { BranchDto, GeofenceDto, GeofenceMode, LiveObject, TimeWindow, TrackedObjectDto, VehicleGroupDto } from '@veetracer/shared';
import { CrosshairIcon, LockIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Combobox, MultiSelect, type Option } from '@/components/ui/multi-select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/features/auth/auth-context';
import { liveStore } from '@/features/live/live-store';
import { useSaveMutation } from '@/features/masters/FormDialog';
import { ComboboxField, SelectField, TextField } from '@/features/masters/form-fields';
import { nullIfBlank, numberOrNull, numericText, optionalText, requiredText, str } from '@/features/masters/form-schema';
import type { MasterFormProps } from '@/features/masters/types';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { cn } from '@/lib/utils';
import { GEOFENCE_COLORS, GEOFENCES_ENDPOINT, MODE_HINT, MODE_LABEL, useAllGeofences, useCategoryOptions } from './api';
import { GeofenceMap } from './GeofenceMap';
import { GeofenceVisits } from './GeofenceVisits';
import { areaM2, clampRadius, formatArea, MAX_RADIUS_M, MIN_RADIUS_M, validateGeometry, type Geometry } from './geometry';
import { TimeWindowsEditor } from './TimeWindowsEditor';
import { validateWindow } from './time-windows';

const MODES: GeofenceMode[] = ['NORMAL', 'NO_GO', 'KEEP_IN'];

const schema = z
  .object({
    name: requiredText(100),
    category: z.string().min(1, 'Required'),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a #rrggbb colour'),
    branchId: z.string().nullable(),
    address: optionalText(300),
    description: optionalText(500),
    mode: z.enum(['NORMAL', 'NO_GO', 'KEEP_IN']),
    notifyEnter: z.boolean(),
    notifyExit: z.boolean(),
    maxStayMin: numericText({ min: 1, max: 10_080, integer: true }),
    speedLimitKph: numericText({ min: 5, max: 250, integer: true }),
    appliesAll: z.boolean(),
    branchIds: z.array(z.string()),
    groupIds: z.array(z.string()),
    objectIds: z.array(z.string()),
    isActive: z.boolean(),
  })
  .refine((v) => v.appliesAll || v.branchIds.length + v.groupIds.length + v.objectIds.length > 0, {
    path: ['objectIds'],
    message: 'Pick at least one branch, group or vehicle — or apply to all',
  });
type Values = z.infer<typeof schema>;

const objectOption = (o: TrackedObjectDto): Option => ({ value: o.id, label: o.name, description: o.plateNumber ?? undefined });

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-b px-5 py-4 last:border-b-0">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function SwitchRow({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </label>
  );
}

/** Vehicle picker fed by the live snapshot (objects with a position). */
function useVehiclePositions(enabled: boolean) {
  const [items, setItems] = useState<LiveObject[]>(() => liveStore.all());
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => setItems(liveStore.all());
    const unsub = liveStore.subscribe((e) => {
      if (e.type !== 'batch') refresh();
    });
    if (!liveStore.snapshotLoaded) liveStore.loadSnapshot().then(refresh).catch(() => undefined);
    else refresh();
    return unsub;
  }, [enabled]);
  return useMemo(() => items.filter((o) => o.lat !== null && o.lng !== null), [items]);
}

/** Full-screen geofence editor: map drawing on the left, all fields on the right, visits tab when editing. */
export function GeofenceEditor({ record, open, onOpenChange }: MasterFormProps<GeofenceDto>) {
  const { can, me } = useAuth();
  const assignedScope = me?.dataScope === 'ASSIGNED';
  // ASSIGNED users can't edit company-wide geofences (server enforces; mirror it in the UI).
  const readOnly = !!record && assignedScope && record.branchId === null;
  const [geometry, setGeometry] = useState<Geometry | null>(record?.geometry ?? null);
  const [geometryError, setGeometryError] = useState<string | null>(null);
  const [timeWindows, setTimeWindows] = useState<TimeWindow[]>(record?.timeWindows ?? []);
  const [focus, setFocus] = useState<{ lat: number; lng: number; key: number } | null>(null);
  const [tab, setTab] = useState('details');

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: str(record?.name),
      category: record?.category ?? 'OTHER',
      color: record?.color ?? GEOFENCE_COLORS[0],
      branchId: record?.branchId ?? null,
      address: str(record?.address),
      description: str(record?.description),
      mode: record?.mode ?? 'NORMAL',
      notifyEnter: record?.notifyEnter ?? true,
      notifyExit: record?.notifyExit ?? true,
      maxStayMin: str(record?.maxStayMin),
      speedLimitKph: str(record?.speedLimitKph),
      appliesAll: record?.appliesTo.all ?? true,
      branchIds: record?.appliesTo.branchIds ?? [],
      groupIds: record?.appliesTo.groupIds ?? [],
      objectIds: record?.appliesTo.objectIds ?? [],
      isActive: record?.isActive ?? true,
    },
  });
  const color = form.watch('color');
  const appliesAll = form.watch('appliesAll');

  const categories = useCategoryOptions();
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: open && can('branches') });
  const groups = useEntityOptions<VehicleGroupDto>('/vehicle-groups', named, { enabled: open && can('vehicle_groups') });
  const [objectQ, setObjectQ] = useState('');
  const objects = useEntityOptions<TrackedObjectDto>('/objects', objectOption, { q: objectQ, enabled: open && can('objects') });
  const allGeofences = useAllGeofences(open);
  const others = useMemo(() => (allGeofences.data ?? []).filter((g) => g.id !== record?.id), [allGeofences.data, record?.id]);
  const vehicles = useVehiclePositions(open && can('live_map'));
  const vehicleOptions = useMemo<Option[]>(
    () => vehicles.map((v) => ({ value: v.objectId, label: v.name, description: v.plateNumber ?? undefined })),
    [vehicles],
  );

  const save = useSaveMutation<unknown>({ endpoint: GEOFENCES_ENDPOINT, id: record?.id ?? null, entity: 'Geofence', onSaved: () => onOpenChange(false) });

  const onGeometry = (g: Geometry | null) => {
    if (readOnly) return;
    setGeometry(g);
    setGeometryError(null);
  };

  const useVehicle = (objectId: string | null) => {
    const v = vehicles.find((x) => x.objectId === objectId);
    if (!v || v.lat === null || v.lng === null) return;
    const center = { lat: v.lat, lng: v.lng };
    if (!geometry || geometry.type === 'CIRCLE') onGeometry({ type: 'CIRCLE', center, radiusM: geometry?.type === 'CIRCLE' ? geometry.radiusM : 200 });
    setFocus({ ...center, key: Date.now() });
    if (!form.getValues('name')) form.setValue('name', `${v.name} location`);
  };

  const submit = form.handleSubmit((v) => {
    const gErr = validateGeometry(geometry);
    if (gErr) {
      setGeometryError(gErr);
      return;
    }
    const twErr = timeWindows.map(validateWindow).find(Boolean);
    if (twErr) {
      setGeometryError(`Time windows: ${twErr}`);
      return;
    }
    if (assignedScope && !v.branchId) {
      form.setError('branchId', { message: 'Choose one of your branches as owner' });
      return;
    }
    save.mutate({
      name: v.name.trim(),
      category: v.category,
      geometry,
      color: v.color,
      address: nullIfBlank(v.address),
      description: nullIfBlank(v.description),
      branchId: v.branchId,
      mode: v.mode,
      notifyEnter: v.notifyEnter,
      notifyExit: v.notifyExit,
      maxStayMin: numberOrNull(v.maxStayMin),
      speedLimitKph: numberOrNull(v.speedLimitKph),
      timeWindows,
      appliesTo: v.appliesAll
        ? { all: true, branchIds: [], groupIds: [], objectIds: [] }
        : { all: false, branchIds: v.branchIds, groupIds: v.groupIds, objectIds: v.objectIds },
      isActive: v.isActive,
    });
  });

  const circle = geometry?.type === 'CIRCLE' ? geometry : null;
  const [radiusText, setRadiusText] = useState(circle ? String(circle.radiusM) : '');
  useEffect(() => {
    if (circle) setRadiusText(String(circle.radiusM));
  }, [circle?.radiusM]);

  const commitRadius = () => {
    if (!circle) return;
    const n = Number(radiusText);
    if (!Number.isFinite(n) || n <= 0) {
      setRadiusText(String(circle.radiusM));
      return;
    }
    onGeometry({ ...circle, radiusM: clampRadius(n) });
  };

  const setCenter = (key: 'lat' | 'lng', value: string) => {
    if (!circle) return;
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    onGeometry({ ...circle, center: { ...circle.center, [key]: n } });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent
        className="top-0 left-0 h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-0 p-0 sm:top-1/2 sm:left-1/2 sm:h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border"
        onEscapeKeyDown={(e) => {
          // Escape while drawing cancels the drawing, not the dialog.
          if (document.querySelector('[aria-label="Drawing tools"] [aria-pressed="true"]')) e.preventDefault();
        }}
      >
        <form noValidate onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
            <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3 pr-12">
              <div className="min-w-0 flex-1">
                <DialogTitle className="flex items-center gap-2 truncate">
                  {record ? `Edit ${record.name}` : 'New geofence'}
                  {readOnly && (
                    <Badge variant="muted">
                      <LockIcon /> Company-wide, read only
                    </Badge>
                  )}
                </DialogTitle>
                <DialogDescription className="text-xs">Draw the zone on the map, then set the rules on the right.</DialogDescription>
              </div>
              {record && (
                <TabsList>
                  <TabsTrigger value="details">Details</TabsTrigger>
                  <TabsTrigger value="visits">Visits</TabsTrigger>
                </TabsList>
              )}
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
                  {readOnly ? 'Close' : 'Cancel'}
                </Button>
                {!readOnly && (
                  <Button type="submit" disabled={save.isPending}>
                    {save.isPending && <Spinner />}
                    Save
                  </Button>
                )}
              </div>
            </header>

            <TabsContent value="details" forceMount className="flex min-h-0 flex-1 flex-col overflow-y-auto data-[state=inactive]:hidden md:flex-row md:overflow-hidden">
              <GeofenceMap
                geometry={geometry}
                onChange={onGeometry}
                color={color}
                others={others}
                focus={focus}
                readOnly={readOnly}
                className="h-[48vh] shrink-0 md:h-auto md:flex-1"
              />
              <div className="w-full shrink-0 md:w-[420px] md:overflow-y-auto md:border-l">
                {(save.error || geometryError) && (
                  <div className="px-5 pt-4">
                    <FormError message={geometryError ?? (save.error instanceof Error ? save.error.message : null)} />
                  </div>
                )}
                <fieldset disabled={readOnly} className="min-w-0">
                  <Section title="Shape" description="Draw with the tools on the map, or place a circle at a vehicle.">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      {geometry ? (
                        <>
                          <Badge variant="secondary">{geometry.type === 'CIRCLE' ? 'Circle' : geometry.type === 'RECTANGLE' ? 'Rectangle' : `Polygon · ${geometry.points.length} points`}</Badge>
                          <span className="text-muted-foreground">{formatArea(areaM2(geometry))}</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">Nothing drawn yet.</span>
                      )}
                    </div>
                    {circle && (
                      <div className="grid grid-cols-3 gap-2">
                        <Field label="Radius (m)" htmlFor="gf-radius" hint={`${MIN_RADIUS_M}–${MAX_RADIUS_M.toLocaleString()} m`}>
                          <Input
                            id="gf-radius"
                            type="number"
                            inputMode="numeric"
                            min={MIN_RADIUS_M}
                            max={MAX_RADIUS_M}
                            value={radiusText}
                            onChange={(e) => setRadiusText(e.target.value)}
                            onBlur={commitRadius}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                commitRadius();
                              }
                            }}
                          />
                        </Field>
                        <Field label="Centre lat" htmlFor="gf-lat">
                          <Input id="gf-lat" type="number" step="0.000001" defaultValue={circle.center.lat.toFixed(6)} key={`lat-${circle.center.lat}`} onBlur={(e) => setCenter('lat', e.target.value)} />
                        </Field>
                        <Field label="Centre lng" htmlFor="gf-lng">
                          <Input id="gf-lng" type="number" step="0.000001" defaultValue={circle.center.lng.toFixed(6)} key={`lng-${circle.center.lng}`} onBlur={(e) => setCenter('lng', e.target.value)} />
                        </Field>
                      </div>
                    )}
                    {can('live_map') && (
                      <Field label="Use vehicle location" hint="Centres a circle on the vehicle's last position.">
                        <div className="flex items-center gap-2">
                          <CrosshairIcon className="size-4 shrink-0 text-muted-foreground" />
                          <Combobox value={null} onChange={useVehicle} options={vehicleOptions} placeholder="Pick a vehicle…" searchPlaceholder="Search vehicles…" />
                        </div>
                      </Field>
                    )}
                  </Section>

                  <Section title="Details">
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
                          selectedOption={record?.branchId ? { value: record.branchId, label: record.branchName ?? '' } : null}
                        />
                      ) : (
                        <Field label="Owner branch">
                          <Input value={record?.branchName ?? 'Company-wide'} disabled />
                        </Field>
                      )}
                    </div>
                    <Field label="Colour">
                      <Controller
                        control={form.control}
                        name="color"
                        render={({ field }) => (
                          <div className="flex flex-wrap items-center gap-1.5">
                            {GEOFENCE_COLORS.map((c) => (
                              <button
                                key={c}
                                type="button"
                                aria-label={`Colour ${c}`}
                                aria-pressed={field.value.toLowerCase() === c}
                                onClick={() => field.onChange(c)}
                                className={cn('size-7 rounded-full border-2 transition-transform focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none', field.value.toLowerCase() === c ? 'scale-110 border-foreground' : 'border-transparent')}
                                style={{ backgroundColor: c }}
                              />
                            ))}
                            <input type="color" aria-label="Custom colour" value={field.value} onChange={(e) => field.onChange(e.target.value)} className="h-7 w-9 cursor-pointer rounded border bg-transparent" />
                          </div>
                        )}
                      />
                    </Field>
                    <TextField form={form} name="address" label="Address" placeholder="Optional" />
                    <TextField form={form} name="description" label="Description" multiline />
                  </Section>

                  <Section title="Rules">
                    <Controller
                      control={form.control}
                      name="mode"
                      render={({ field }) => (
                        <div role="radiogroup" aria-label="Mode" className="grid gap-2">
                          {MODES.map((m) => (
                            <button
                              key={m}
                              type="button"
                              role="radio"
                              aria-checked={field.value === m}
                              onClick={() => field.onChange(m)}
                              className={cn(
                                'flex items-start gap-3 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none',
                                field.value === m ? 'border-primary bg-primary/6' : 'hover:bg-accent/60',
                              )}
                            >
                              <span className={cn('mt-1 size-3.5 shrink-0 rounded-full border-2', field.value === m ? 'border-primary bg-primary shadow-[inset_0_0_0_2px] shadow-card' : 'border-input')} />
                              <span>
                                <span className="block text-sm font-medium">{MODE_LABEL[m]}</span>
                                <span className="block text-xs text-muted-foreground">{MODE_HINT[m]}</span>
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    />
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Controller control={form.control} name="notifyEnter" render={({ field }) => <SwitchRow label="Alert on entry" checked={field.value} onChange={field.onChange} disabled={readOnly} />} />
                      <Controller control={form.control} name="notifyExit" render={({ field }) => <SwitchRow label="Alert on exit" checked={field.value} onChange={field.onChange} disabled={readOnly} />} />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <TextField form={form} name="maxStayMin" label="Max stay (min)" type="number" placeholder="No limit" hint="Alert when a vehicle stays longer" />
                      <TextField form={form} name="speedLimitKph" label="Zone speed limit (km/h)" type="number" placeholder="None" hint="Overspeed inside this zone" />
                    </div>
                  </Section>

                  <Section title="Time windows" description="When the geofence is active (company timezone).">
                    <TimeWindowsEditor value={timeWindows} onChange={setTimeWindows} disabled={readOnly} />
                  </Section>

                  <Section title="Applies to">
                    <Controller
                      control={form.control}
                      name="appliesAll"
                      render={({ field }) => <SwitchRow label="All vehicles" hint="Turn off to choose branches, groups or vehicles" checked={field.value} onChange={field.onChange} disabled={readOnly} />}
                    />
                    {!appliesAll && (
                      <div className="space-y-3">
                        {can('branches') && (
                          <Field label="Branches">
                            <Controller control={form.control} name="branchIds" render={({ field }) => <MultiSelect value={field.value} onChange={field.onChange} options={branches.options} loading={branches.loading} placeholder="Any branch…" />} />
                          </Field>
                        )}
                        {can('vehicle_groups') && (
                          <Field label="Vehicle groups">
                            <Controller control={form.control} name="groupIds" render={({ field }) => <MultiSelect value={field.value} onChange={field.onChange} options={groups.options} loading={groups.loading} placeholder="Any group…" />} />
                          </Field>
                        )}
                        <Field label="Vehicles" error={form.formState.errors.objectIds?.message}>
                          <Controller
                            control={form.control}
                            name="objectIds"
                            render={({ field }) => (
                              <MultiSelect value={field.value} onChange={field.onChange} options={objects.options} loading={objects.loading} onSearch={setObjectQ} placeholder="Pick vehicles…" />
                            )}
                          />
                        </Field>
                      </div>
                    )}
                  </Section>

                  <Section title="Status">
                    <Controller control={form.control} name="isActive" render={({ field }) => <SwitchRow label="Active" hint="Inactive geofences raise no alerts" checked={field.value} onChange={field.onChange} disabled={readOnly} />} />
                  </Section>
                </fieldset>
              </div>
            </TabsContent>

            {record && (
              <TabsContent value="visits" className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
                <GeofenceVisits geofenceId={record.id} />
              </TabsContent>
            )}
          </Tabs>
        </form>
      </DialogContent>
    </Dialog>
  );
}

