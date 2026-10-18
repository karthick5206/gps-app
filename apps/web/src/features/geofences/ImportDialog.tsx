import { useMutation } from '@tanstack/react-query';
import { FileUpIcon, UploadIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import type { BranchDto } from '@veetracer/shared';
import { Field } from '@/components/ui/field';
import { Combobox } from '@/components/ui/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/features/auth/auth-context';
import { useInvalidateMaster } from '@/features/masters/FormDialog';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, errorMessage } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { GEOFENCES_ENDPOINT, useCategoryOptions } from './api';
import { previewCsv, previewGeoJson, type ImportPreview } from './import-parse';

interface ImportResult {
  created: number;
  failed: ({ index?: number; name?: string; row?: number; error?: string; message?: string } | string)[];
}

function failureText(f: ImportResult['failed'][number]): string {
  if (typeof f === 'string') return f;
  const where = f.name ?? (f.row !== undefined ? i18n.t('Row {{row}}', { row: f.row }) : f.index !== undefined ? i18n.t('Item {{n}}', { n: f.index + 1 }) : i18n.t('Item'));
  return `${where}: ${f.error ?? f.message ?? i18n.t('rejected')}`;
}

/** Import geofences from a GeoJSON FeatureCollection or a `name,lat,lng,radiusM` CSV. */
export function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const invalidate = useInvalidateMaster();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [category, setCategory] = useState('');
  const [branchId, setBranchId] = useState<string | null>(null);
  const { can, me } = useAuth();
  const categories = useCategoryOptions();
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: open && can('branches') });
  const assigned = me?.dataScope === 'ASSIGNED';

  const reset = () => {
    setFile(null);
    setPreview(null);
    setParseError(null);
    setResult(null);
  };

  const pick = async (f: File | undefined) => {
    reset();
    if (!f) return;
    const text = await f.text();
    setFile({ name: f.name, text });
    try {
      const isCsv = /\.csv$/i.test(f.name) || (!text.trim().startsWith('{') && !text.trim().startsWith('['));
      const tr = (k: string, v?: Record<string, string>) => t(k, v);
      setPreview(isCsv ? previewCsv(text, tr) : previewGeoJson(text, tr));
    } catch (e) {
      setParseError(errorMessage(e));
    }
  };

  const run = useMutation({
    mutationFn: () => {
      if (!file || !preview) throw new Error(t('Choose a file'));
      return api.post<ImportResult>(`${GEOFENCES_ENDPOINT}/import`, {
        format: preview.kind,
        content: file.text,
        category: category || undefined,
        branchId: branchId ?? undefined,
      });
    },
    onSuccess: (res) => {
      setResult(res);
      invalidate(GEOFENCES_ENDPOINT);
      if (res.created) toast.success(t('{{count}} geofence(s) imported', { count: res.created }));
      if (res.failed?.length) toast.warning(t('{{count}} item(s) could not be imported', { count: res.failed.length }));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (run.isPending) return;
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Import geofences')}</DialogTitle>
          <DialogDescription>
            {t('GeoJSON FeatureCollection (Polygon features, or Point features with a')} <code className="text-xs">radius</code> {t('property in metres) or a CSV with columns')}{' '}
            <code className="text-xs">name,lat,lng,radiusM</code>.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors hover:bg-accent/50 focus-within:ring-[3px] focus-within:ring-ring/40">
            <FileUpIcon className="size-8 text-primary" />
            <span className="text-sm font-medium">{file ? file.name : t('Choose a .geojson, .json or .csv file')}</span>
            <span className="text-xs text-muted-foreground">{t('Imported geofences are active and apply to all vehicles; edit them afterwards.')}</span>
            <input type="file" accept=".geojson,.json,.csv,application/json,text/csv" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('Category')} hint={t('Used when a feature has no category')}>
              <Select value={category || '__none'} onValueChange={(v) => setCategory(v === '__none' ? '' : v)}>
                <SelectTrigger aria-label={t('Default category')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">{t('From file / Other')}</SelectItem>
                  {categories.options.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {can('branches') && (
              <Field label={t('Owner branch')} hint={assigned ? t('Required for your role') : t('Empty = company-wide')}>
                <Combobox value={branchId} onChange={setBranchId} options={branches.options} loading={branches.loading} placeholder={assigned ? t('Choose a branch') : t('Company-wide')} />
              </Field>
            )}
          </div>
          {parseError && <FormError message={parseError} />}
          {preview && (
            <div className="space-y-2 rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{preview.kind === 'csv' ? 'CSV' : 'GeoJSON'}</Badge>
                <span className="font-medium">{t('{{count}} to import', { count: preview.total })}</span>
                {preview.circles > 0 && <span className="text-muted-foreground">{t('{{count}} circle(s)', { count: preview.circles })}</span>}
                {preview.polygons > 0 && <span className="text-muted-foreground">{t('{{count}} polygon(s)', { count: preview.polygons })}</span>}
              </div>
              {preview.names.length > 0 && <p className="truncate text-xs text-muted-foreground">{preview.names.slice(0, 8).join(', ')}{preview.names.length > 8 ? '…' : ''}</p>}
              {preview.skipped.length > 0 && (
                <details className="text-xs text-warning">
                  <summary className="cursor-pointer">{t('{{count}} item(s) will be skipped', { count: preview.skipped.length })}</summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {preview.skipped.slice(0, 20).map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          {result && (
            <div className="space-y-1 rounded-lg border border-success/30 bg-success/8 p-3 text-sm">
              <p className="font-medium text-success">{t('{{count}} created', { count: result.created })}</p>
              {result.failed?.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-4 text-xs text-destructive">
                  {result.failed.slice(0, 20).map((f, i) => (
                    <li key={i}>{failureText(f)}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={run.isPending}>
            {result ? t('Close') : t('Cancel')}
          </Button>
          {!result && (
            <Button onClick={() => run.mutate()} disabled={!preview || preview.total === 0 || run.isPending || (assigned && !branchId)}>
              {run.isPending ? <Spinner /> : <UploadIcon />}
              {t('Import')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
