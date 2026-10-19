import { useMutation } from '@tanstack/react-query';
import { POI_DEFAULT_RADIUS_M, POI_IMPORT_MAX_BYTES, POI_MAX_RADIUS_M, POI_MIN_RADIUS_M, type BranchDto, type PoiImportItem, type PoiImportPreview, type PoiImportResult } from '@veetracer/shared';
import { AlertTriangleIcon, FileUpIcon, UploadIcon } from 'lucide-react';
import { useMemo, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Combobox, type Option } from '@/components/ui/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { GEOFENCES_ENDPOINT, useCategoryOptions } from '@/features/geofences/api';
import { useInvalidateMaster } from '@/features/masters/FormDialog';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { POIS_ENDPOINT, usePoiCategoryOptions } from './api';

const ACCEPT = '.kml,.kmz,.gpx,.geojson,.json,.csv';
const FORMAT_LABEL: Record<PoiImportPreview['format'], string> = { kml: 'KML', kmz: 'KMZ', gpx: 'GPX', geojson: 'GeoJSON', csv: 'CSV' };

function CategorySelect({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: Option[]; label: string }) {
  const { t } = useTranslation();
  return (
    <Select value={value || '__none'} onValueChange={(v) => onChange(v === '__none' ? '' : v)}>
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none">{t('From file / Other')}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Two-step import of POIs (points) and geofences (areas) from KML / KMZ / GPX / GeoJSON / CSV: preview, pick, commit. */
export function PoiImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const invalidate = useInvalidateMaster();
  const assigned = me?.dataScope === 'ASSIGNED';
  const canGeofences = can('geofences', 'create');
  const poiCategories = usePoiCategoryOptions();
  const geofenceCategories = useCategoryOptions();
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: open && can('branches') });

  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<PoiImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<PoiImportResult | null>(null);
  const [category, setCategory] = useState('');
  const [geofenceCategory, setGeofenceCategory] = useState('');
  const [branchId, setBranchId] = useState<string | null>(null);
  const [radiusText, setRadiusText] = useState(String(POI_DEFAULT_RADIUS_M));
  const [dragging, setDragging] = useState(false);

  const selectable = (i: PoiImportItem) => !i.error && i.kind !== null && (i.kind === 'POI' || canGeofences);
  const selectableItems = useMemo(() => (preview?.items ?? []).filter(selectable), [preview, canGeofences]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = useMemo(() => selectableItems.filter((i) => selected.has(i.index)), [selectableItems, selected]);
  const radius = Number(radiusText);
  const radiusValid = Number.isInteger(radius) && radius >= POI_MIN_RADIUS_M && radius <= POI_MAX_RADIUS_M;

  const reset = () => {
    setFileName(null);
    setPreview(null);
    setSelected(new Set());
    setResult(null);
    upload.reset();
    commit.reset();
  };

  const upload = useMutation({
    mutationFn: (f: File) => {
      if (f.size > POI_IMPORT_MAX_BYTES) throw new Error(t('The file is larger than {{size}} MB', { size: POI_IMPORT_MAX_BYTES / 1024 / 1024 }));
      const form = new FormData();
      form.append('file', f, f.name);
      return api.upload<PoiImportPreview>(`${POIS_ENDPOINT}/import/preview`, form);
    },
    onSuccess: (p) => {
      setPreview(p);
      setSelected(new Set(p.items.filter(selectable).map((i) => i.index)));
    },
  });

  const commit = useMutation({
    mutationFn: () =>
      api.post<PoiImportResult>(`${POIS_ENDPOINT}/import/commit`, {
        items: chosen.map(({ error: _e, warning: _w, ...item }) => item),
        category: category || undefined,
        geofenceCategory: geofenceCategory || undefined,
        branchId: branchId ?? undefined,
        radiusM: radiusValid ? radius : undefined,
      }),
    onSuccess: (res) => {
      setResult(res);
      invalidate(POIS_ENDPOINT);
      if (res.geofences) invalidate(GEOFENCES_ENDPOINT);
      if (res.pois || res.geofences) toast.success(t('Imported {{pois}} POI(s) and {{geofences}} geofence(s)', { pois: res.pois, geofences: res.geofences }));
      if (res.failed.length) toast.warning(t('{{count}} item(s) could not be imported', { count: res.failed.length }));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const pick = (f: File | undefined) => {
    reset();
    if (!f) return;
    setFileName(f.name);
    upload.mutate(f);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files?.[0]);
  };

  const toggle = (index: number, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });

  const allChecked = selectableItems.length > 0 && chosen.length === selectableItems.length;
  const headerState: boolean | 'indeterminate' = allChecked ? true : chosen.length ? 'indeterminate' : false;
  const busy = upload.isPending || commit.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('Import places')}</DialogTitle>
          <DialogDescription>{t('KML, KMZ, GPX, GeoJSON or CSV (name, lat, lng, radius). Points become POIs, areas become geofences.')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              'flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors hover:bg-accent/50 focus-within:ring-[3px] focus-within:ring-ring/40',
              dragging && 'border-primary bg-primary/6',
            )}
          >
            {upload.isPending ? <Spinner className="size-8" /> : <FileUpIcon className="size-8 text-primary" />}
            <span className="text-sm font-medium">{fileName ?? t('Drop a file here or click to choose')}</span>
            <span className="text-xs text-muted-foreground">{t('.kml, .kmz, .gpx, .geojson, .json or .csv — up to {{size}} MB. Nothing is saved until you import.', { size: POI_IMPORT_MAX_BYTES / 1024 / 1024 })}</span>
            <input type="file" accept={ACCEPT} className="sr-only" disabled={busy} onChange={(e) => pick(e.target.files?.[0] ?? undefined)} />
          </label>

          {upload.error && <FormError message={errorMessage(upload.error)} />}

          {preview && !result && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('POI category')} hint={t('Used when an item has no known category')}>
                  <CategorySelect value={category} onChange={setCategory} options={poiCategories.options} label={t('POI category')} />
                </Field>
                <Field label={t('Default radius (m)')} hint={`${POI_MIN_RADIUS_M}–${POI_MAX_RADIUS_M.toLocaleString()} m`} error={radiusValid ? undefined : t('Must be between {{min}} and {{max}}', { min: POI_MIN_RADIUS_M, max: POI_MAX_RADIUS_M })}>
                  <Input type="number" inputMode="numeric" min={POI_MIN_RADIUS_M} max={POI_MAX_RADIUS_M} value={radiusText} onChange={(e) => setRadiusText(e.target.value)} />
                </Field>
                {preview.counts.geofences > 0 && canGeofences && (
                  <Field label={t('Geofence category')} hint={t('Used when an area has no known category')}>
                    <CategorySelect value={geofenceCategory} onChange={setGeofenceCategory} options={geofenceCategories.options} label={t('Geofence category')} />
                  </Field>
                )}
                {can('branches') && (
                  <Field label={t('Owner branch')} hint={assigned ? t('Required for your role') : t('Empty = company-wide')}>
                    <Combobox value={branchId} onChange={setBranchId} options={branches.options} loading={branches.loading} placeholder={assigned ? t('Choose a branch') : t('Company-wide')} />
                  </Field>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="secondary">{FORMAT_LABEL[preview.format]}</Badge>
                <span>{t('{{count}} POI(s)', { count: preview.counts.pois })}</span>
                <span className="text-muted-foreground">·</span>
                <span>{t('{{count}} geofence(s)', { count: preview.counts.geofences })}</span>
                {preview.counts.errors > 0 && (
                  <>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-destructive">{t('{{count}} error(s)', { count: preview.counts.errors })}</span>
                  </>
                )}
                <span className="ml-auto font-medium">{t('{{count}} selected', { count: chosen.length })}</span>
              </div>
              {!canGeofences && preview.counts.geofences > 0 && (
                <p className="text-xs text-warning">{t('You are not allowed to create geofences, so areas in this file cannot be imported.')}</p>
              )}

              <div className="max-h-[45vh] overflow-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-muted text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="w-10 px-3 py-2">
                        <Checkbox
                          checked={headerState}
                          onCheckedChange={(v) => setSelected(v === true ? new Set(selectableItems.map((i) => i.index)) : new Set())}
                          aria-label={t('Select all')}
                          disabled={!selectableItems.length}
                        />
                      </th>
                      <th className="px-2 py-2 font-medium">#</th>
                      <th className="px-2 py-2 font-medium">{t('Name')}</th>
                      <th className="px-2 py-2 font-medium">{t('Type')}</th>
                      <th className="px-2 py-2 font-medium">{t('Details')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.items.map((item) => {
                      const ok = selectable(item);
                      return (
                        <tr key={item.index} className={cn('border-t', !ok && 'bg-muted/40 text-muted-foreground')}>
                          <td className="px-3 py-1.5">
                            <Checkbox checked={ok && selected.has(item.index)} disabled={!ok} onCheckedChange={(v) => toggle(item.index, v === true)} aria-label={t('Select {{name}}', { name: item.name || `#${item.index}` })} />
                          </td>
                          <td className="px-2 py-1.5 text-xs tabular-nums text-muted-foreground">{item.index}</td>
                          <td className="max-w-56 px-2 py-1.5">
                            <span className="flex items-center gap-2">
                              {item.color && <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} aria-hidden />}
                              <span className="truncate" title={item.name}>{item.name || '—'}</span>
                            </span>
                          </td>
                          <td className="px-2 py-1.5">
                            {item.kind === 'POI' ? <Badge variant="default">{t('POI')}</Badge> : item.kind === 'GEOFENCE' ? <Badge variant="secondary">{t('Geofence')}</Badge> : <Badge variant="destructive">{t('Error')}</Badge>}
                          </td>
                          <td className="px-2 py-1.5 text-xs">
                            {item.error ? (
                              <span className="text-destructive">{item.error}</span>
                            ) : (
                              <span className="space-y-0.5">
                                <span className="block text-muted-foreground">
                                  {item.kind === 'POI' && item.lat !== undefined && item.lng !== undefined
                                    ? `${item.lat.toFixed(5)}, ${item.lng.toFixed(5)}${item.radiusM ? ` · ${item.radiusM} m` : ''}`
                                    : item.geometry
                                      ? item.geometry.type === 'CIRCLE'
                                        ? t('Circle · {{radius}} m', { radius: item.geometry.radiusM })
                                        : t('Polygon · {{count}} points', { count: item.geometry.points.length })
                                      : null}
                                  {item.category ? ` · ${item.category}` : ''}
                                </span>
                                {item.warning && (
                                  <span className="flex items-center gap-1 text-warning">
                                    <AlertTriangleIcon className="size-3 shrink-0" /> {item.warning}
                                  </span>
                                )}
                                {item.kind === 'GEOFENCE' && !canGeofences && <span className="block text-warning">{t('Needs geofence create permission')}</span>}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {result && (
            <div className="space-y-1 rounded-lg border border-success/30 bg-success/8 p-3 text-sm">
              <p className="font-medium text-success">{t('Imported {{pois}} POI(s) and {{geofences}} geofence(s)', { pois: result.pois, geofences: result.geofences })}</p>
              {result.failed.length > 0 && (
                <>
                  <p className="text-xs text-destructive">{t('{{count}} item(s) could not be imported', { count: result.failed.length })}</p>
                  <ul className="max-h-40 list-disc space-y-0.5 overflow-auto pl-4 text-xs text-destructive">
                    {result.failed.slice(0, 50).map((f) => (
                      <li key={f.index}>
                        #{f.index} {f.name}: {f.message}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onOpenChange(false); }} disabled={busy}>
            {result ? t('Close') : t('Cancel')}
          </Button>
          {result ? (
            <Button variant="outline" onClick={reset}>
              <FileUpIcon /> {t('Import another file')}
            </Button>
          ) : (
            <Button onClick={() => commit.mutate()} disabled={!preview || !chosen.length || busy || !radiusValid || (assigned && !branchId)}>
              {commit.isPending ? <Spinner /> : <UploadIcon />}
              {chosen.length ? t('Import {{count}} selected', { count: chosen.length }) : t('Import')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
