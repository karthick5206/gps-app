import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { ROUTE_LIMITS, type BranchDto, type RouteDto, type RouteInput, type RouteSummaryDto } from '@veetracer/shared';
import { InfoIcon, LockIcon, RouteIcon, SparklesIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/features/auth/auth-context';
import { useInvalidateMaster } from '@/features/masters/FormDialog';
import { ComboboxField, SwitchField, TextField } from '@/features/masters/form-fields';
import { nullIfBlank, numericText, optionalText, requiredText, str } from '@/features/masters/form-schema';
import type { MasterFormProps } from '@/features/masters/types';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, errorMessage } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { ROUTES_ENDPOINT, useDebounced, usePathPreview, useRouteDetail } from './api';
import { RouteMap } from './RouteMap';
import { moveItem, positionsKey, suggestOffsets, validateStops, type StopDraft } from './route-stops';
import { SchedulesPanel } from './SchedulesPanel';
import { StopList } from './StopList';

const schema = z.object({
  name: requiredText(100),
  code: optionalText(50),
  description: optionalText(1000),
  branchId: z.string().nullable(),
  corridorM: numericText({ min: ROUTE_LIMITS.corridorMinM, max: ROUTE_LIMITS.corridorMaxM, required: true, integer: true }),
  isActive: z.boolean(),
});
type Values = z.infer<typeof schema>;

let keySeq = 0;
const newKey = () => `s${++keySeq}`;

function toDrafts(route: RouteDto): StopDraft[] {
  return [...route.stops]
    .sort((a, b) => a.seq - b.seq)
    .map((s) => ({ key: newKey(), name: s.name, lat: s.lat, lng: s.lng, radiusM: s.radiusM, offsetMin: s.offsetMin, waitMin: s.waitMin, geofenceId: s.geofenceId }));
}

function formatKm(m: number | null | undefined): string {
  if (m === null || m === undefined) return '—';
  return `${(m / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km`;
}

/**
 * Full-screen route editor (same shell as the geofence editor): Details, Stops (map + stop list + road path preview)
 * and, once saved, Schedules. Creating a route keeps the editor open on the new route so schedules can be added.
 */
export function RouteEditor({ record, open, onOpenChange }: MasterFormProps<RouteSummaryDto>) {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const assignedScope = me?.dataScope === 'ASSIGNED';
  const [routeId, setRouteId] = useState<string | null>(record?.id ?? null);
  const detail = useRouteDetail(routeId);
  const readOnly = (!!record && assignedScope && record.branchId === null) || (routeId ? !can('routes', 'edit') : !can('routes', 'create'));
  const invalidate = useInvalidateMaster();

  const [tab, setTab] = useState(record ? 'stops' : 'details');
  const [stops, setStops] = useState<StopDraft[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const loadedRef = useRef(false);

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: str(record?.name),
      code: str(record?.code),
      description: str(record?.description),
      branchId: record?.branchId ?? null,
      corridorM: String(record?.corridorM ?? ROUTE_LIMITS.corridorDefaultM),
      isActive: record?.isActive ?? true,
    },
  });

  // Load the stored stops once (later refetches after schedule edits must not overwrite unsaved edits).
  useEffect(() => {
    if (!detail.data || loadedRef.current) return;
    loadedRef.current = true;
    const r = detail.data;
    form.reset({ name: r.name, code: str(r.code), description: str(r.description), branchId: r.branchId, corridorM: String(r.corridorM), isActive: r.isActive });
    setStops(toDrafts(r));
  }, [detail.data, form]);

  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: open && can('branches') });

  const corridorText = form.watch('corridorM');
  const corridorM = useMemo(() => {
    const n = Number(corridorText);
    return Number.isFinite(n) && n >= ROUTE_LIMITS.corridorMinM && n <= ROUTE_LIMITS.corridorMaxM ? n : ROUTE_LIMITS.corridorDefaultM;
  }, [corridorText]);

  // ── Road path preview (debounced on stop positions) ──
  const validPoints = useMemo(() => stops.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng)), [stops]);
  const liveKey = positionsKey(validPoints);
  const debouncedKey = useDebounced(liveKey, 600);
  const debouncedPoints = useMemo(() => validPoints, [debouncedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = usePathPreview(debouncedPoints, debouncedKey, open && tab === 'stops' && validPoints.length >= 2);
  const previewCurrent = debouncedKey === liveKey && preview.isSuccess;
  const stored = detail.data && positionsKey(detail.data.stops.slice().sort((a, b) => a.seq - b.seq)) === liveKey ? detail.data : null;
  const roadPath = previewCurrent ? preview.data.path : (stored?.path ?? null);
  const distanceM = previewCurrent ? preview.data.distanceM : stored?.distanceM ?? null;
  const durationSec = previewCurrent ? preview.data.durationSec : stored?.durationSec ?? null;
  const pathUnavailable = validPoints.length >= 2 && (preview.isError || (previewCurrent && !preview.data.path));
  const legs = previewCurrent && preview.data.path && preview.data.legs.length === stops.length - 1 ? preview.data.legs : null;
  const previewLoading = validPoints.length >= 2 && (debouncedKey !== liveKey || preview.isFetching);

  const issues = useMemo(() => validateStops(stops, ROUTE_LIMITS), [stops]);
  const visibleIssues = showIssues ? issues : [];
  const listIssue = visibleIssues.find((i) => i.index === null);

  // ── Stop edits ──
  const addStop = (s: { lat: number; lng: number; name?: string }) => {
    if (readOnly) return;
    if (stops.length >= ROUTE_LIMITS.maxStops) {
      toast.error(t('A route can have at most {{n}} stops', { n: ROUTE_LIMITS.maxStops }));
      return;
    }
    setStops((prev) => {
      const last = prev[prev.length - 1];
      const offset = last && Number.isFinite(last.offsetMin) ? last.offsetMin : 0;
      return [...prev, { key: newKey(), name: s.name ?? t('Stop {{n}}', { n: prev.length + 1 }), lat: s.lat, lng: s.lng, radiusM: ROUTE_LIMITS.radiusDefaultM, offsetMin: offset, waitMin: 0, geofenceId: null }];
    });
    setSelected(stops.length);
  };
  const patchStop = (i: number, patch: Partial<StopDraft>) => setStops((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const moveStop = (i: number, delta: number) => {
    setStops((prev) => {
      const next = moveItem(prev, i, delta);
      // The start stop always arrives at 0.
      return next.length && next[0].offsetMin !== 0 ? next.map((s, j) => (j === 0 ? { ...s, offsetMin: 0 } : s)) : next;
    });
    setSelected((sel) => (sel === i ? i + delta : sel));
  };
  const removeStop = (i: number) => {
    setStops((prev) => {
      const next = prev.filter((_, j) => j !== i);
      return next.length && next[0].offsetMin !== 0 ? next.map((s, j) => (j === 0 ? { ...s, offsetMin: 0 } : s)) : next;
    });
    setSelected(null);
  };
  const suggestTimes = () => {
    if (!legs) return;
    const offsets = suggestOffsets(
      legs.map((l) => l.durationSec),
      stops.map((s) => (Number.isFinite(s.waitMin) ? s.waitMin : 0)),
    );
    setStops((prev) => prev.map((s, i) => ({ ...s, offsetMin: offsets[i] ?? s.offsetMin })));
    toast.success(t('Arrival times filled from the road path'));
  };

  // ── Save ──
  const save = useMutation({
    mutationFn: (body: RouteInput) => (routeId ? api.patch<RouteDto>(`${ROUTES_ENDPOINT}/${routeId}`, body) : api.post<RouteDto>(ROUTES_ENDPOINT, body)),
    onSuccess: (saved) => {
      invalidate(ROUTES_ENDPOINT);
      if (routeId) {
        toast.success(t('{{entity}} updated', { entity: t('Route') }));
        onOpenChange(false);
        return;
      }
      // New route: stay open on it so schedules can be added right away.
      toast.success(t('Route created. You can add schedules now.'));
      loadedRef.current = false;
      setRouteId(saved.id);
      setTab('schedules');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const submit = form.handleSubmit(
    (v) => {
      if (assignedScope && !v.branchId) {
        form.setError('branchId', { message: t('Choose one of your branches as owner') });
        setTab('details');
        return;
      }
      if (issues.length) {
        setShowIssues(true);
        setTab('stops');
        return;
      }
      save.mutate({
        name: v.name.trim(),
        code: nullIfBlank(v.code),
        description: nullIfBlank(v.description),
        branchId: v.branchId,
        corridorM: Number(v.corridorM),
        isActive: v.isActive,
        stops: stops.map((s) => ({ name: s.name.trim(), lat: s.lat, lng: s.lng, radiusM: s.radiusM, offsetMin: s.offsetMin, waitMin: s.waitMin, geofenceId: s.geofenceId ?? null })),
      });
    },
    () => setTab('details'),
  );

  const title = routeId ? t('Edit {{name}}', { name: detail.data?.name ?? record?.name ?? '' }) : t('New route');
  const loading = !!routeId && detail.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent
        className="top-0 left-0 h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-0 p-0 sm:top-1/2 sm:left-1/2 sm:h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border"
        onEscapeKeyDown={(e) => {
          // Escape in the address box clears the box, not the dialog.
          if (document.activeElement?.hasAttribute('data-place-search')) e.preventDefault();
        }}
      >
        <form noValidate onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
            <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3 pr-12">
              <div className="min-w-0 flex-1">
                <DialogTitle className="flex items-center gap-2 truncate">
                  <span className="truncate">{title}</span>
                  {readOnly && (
                    <Badge variant="muted">
                      <LockIcon /> {t('Read only')}
                    </Badge>
                  )}
                </DialogTitle>
                <DialogDescription className="text-xs">{t('Ordered stops, road path and corridor. Editing a route never changes trips already planned.')}</DialogDescription>
              </div>
              <TabsList className="order-last w-full sm:order-none sm:w-auto">
                <TabsTrigger value="details" className="flex-1 sm:flex-none">
                  {t('Details')}
                </TabsTrigger>
                <TabsTrigger value="stops" className="flex-1 sm:flex-none">
                  {t('Stops')}
                  {stops.length > 0 && <span className="text-muted-foreground tabular-nums">{stops.length}</span>}
                </TabsTrigger>
                {routeId && (
                  <TabsTrigger value="schedules" className="flex-1 sm:flex-none">
                    {t('Schedules')}
                  </TabsTrigger>
                )}
              </TabsList>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
                  {readOnly ? t('Close') : t('Cancel')}
                </Button>
                {!readOnly && (
                  <Button type="submit" disabled={save.isPending || loading}>
                    {save.isPending && <Spinner />}
                    {t('Save')}
                  </Button>
                )}
              </div>
            </header>

            {loading ? (
              <div className="flex flex-1 items-center justify-center">
                <Spinner />
              </div>
            ) : detail.isError ? (
              <div className="p-6">
                <FormError message={errorMessage(detail.error)} />
              </div>
            ) : (
              <>
                <TabsContent value="details" forceMount className="min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden">
                  <fieldset disabled={readOnly} className="mx-auto w-full max-w-2xl min-w-0 space-y-4 p-4 sm:p-6">
                    {save.error && <FormError message={errorMessage(save.error)} />}
                    <TextField form={form} name="name" label="Name" required />
                    <div className="grid gap-3 sm:grid-cols-2">
                      <TextField form={form} name="code" label="Code" placeholder="Optional" />
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
                        <Field label={t('Owner branch')}>
                          <Input value={record?.branchName ?? t('Company-wide')} disabled />
                        </Field>
                      )}
                    </div>
                    <TextField
                      form={form}
                      name="corridorM"
                      label="Corridor (m)"
                      type="number"
                      required
                      hint={t('{{min}}–{{max}} m either side of the path. Further away counts as a deviation.', { min: ROUTE_LIMITS.corridorMinM, max: ROUTE_LIMITS.corridorMaxM })}
                    />
                    <TextField form={form} name="description" label="Description" multiline />
                    <SwitchField form={form} name="isActive" label="Active" hint="Turn off to archive the route. Archived routes are kept with their trips." />
                  </fieldset>
                </TabsContent>

                <TabsContent value="stops" forceMount className="flex min-h-0 flex-1 flex-col overflow-y-auto data-[state=inactive]:hidden md:flex-row md:overflow-hidden">
                  <RouteMap
                    stops={stops}
                    path={roadPath}
                    corridorM={corridorM}
                    selected={selected}
                    onSelect={setSelected}
                    onAdd={addStop}
                    onMove={(i, lat, lng) => patchStop(i, { lat, lng })}
                    readOnly={readOnly}
                    className="h-[45vh] shrink-0 md:h-auto md:flex-1"
                  />
                  <div className="w-full min-w-0 shrink-0 space-y-3 p-4 md:w-[440px] md:overflow-y-auto md:border-l">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
                      <RouteIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span>
                        <span className="text-muted-foreground">{t('Distance')} </span>
                        <span className="font-medium tabular-nums">{formatKm(distanceM)}</span>
                      </span>
                      <span>
                        <span className="text-muted-foreground">{t('Drive time')} </span>
                        <span className="font-medium tabular-nums">{durationSec === null ? '—' : formatDuration(durationSec)}</span>
                      </span>
                      {previewLoading && <Spinner className="ml-auto" />}
                    </div>
                    {pathUnavailable && (
                      <p className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning-fg">
                        <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
                        {t('Road path unavailable — straight lines used')}
                      </p>
                    )}
                    {!readOnly && (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button variant="outline" size="sm" onClick={suggestTimes} disabled={!legs}>
                          <SparklesIcon /> {t('Suggest times')}
                        </Button>
                        <span className="text-xs text-muted-foreground">{legs ? t('Fills arrivals from drive times plus waits.') : t('Needs a road path.')}</span>
                      </div>
                    )}
                    {listIssue && <FormError message={t(listIssue.message, listIssue.vars)} />}
                    {showIssues && issues.length > 0 && !listIssue && <FormError message={t('Fix the highlighted stops before saving.')} />}
                    {stops.length === 0 ? (
                      <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">{t('No stops yet. Click the map or search a place to add the start, then the next stops in order.')}</p>
                    ) : (
                      <StopList
                        stops={stops}
                        issues={visibleIssues}
                        selected={selected}
                        onSelect={setSelected}
                        onChange={patchStop}
                        onMove={moveStop}
                        onRemove={removeStop}
                        limits={ROUTE_LIMITS}
                        readOnly={readOnly}
                      />
                    )}
                    {stops.length === 1 && <p className="text-xs text-muted-foreground">{t('Add at least one more stop: a route needs a start and an end.')}</p>}
                  </div>
                </TabsContent>

                {routeId && (
                  <TabsContent value="schedules" className="min-h-0 flex-1 overflow-y-auto">
                    {/* The schedule dialog's own form submit must not bubble (through the portal) into this form. */}
                    <div onSubmit={(e) => e.stopPropagation()}>
                      <SchedulesPanel routeId={routeId} readOnly={readOnly} />
                    </div>
                  </TabsContent>
                )}
              </>
            )}
          </Tabs>
        </form>
      </DialogContent>
    </Dialog>
  );
}
