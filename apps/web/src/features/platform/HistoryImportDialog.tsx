import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  HISTORY_IMPORT_CHUNK,
  parseOldPlatformSheet,
  straightLineKm,
  type HistoryImportDto,
  type HistoryImportPreview,
  type HistoryImportStatus,
  type ParsedOldHistory,
} from '@veetracer/shared';
import { HistoryIcon, Trash2Icon, UploadIcon } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { api, errorMessage } from '@/lib/api';

const STATUS: Record<HistoryImportStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  UPLOADING: { label: 'Uploading', variant: 'outline' },
  SUMMARIZING: { label: 'Recalculating trips…', variant: 'default' },
  DONE: { label: 'Imported', variant: 'secondary' },
  REMOVING: { label: 'Removing…', variant: 'default' },
  REMOVED: { label: 'Removed', variant: 'outline' },
  FAILED: { label: 'Failed', variant: 'destructive' },
};

/** "YYYY-MM-DD HH:mm:ss" of an instant in a time zone (the export's local time). */
function localOf(iso: string, tz: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

const fmtLocal = (s: string) => s.slice(0, 16);
const fmtIso = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

async function readFile(file: File): Promise<ParsedOldHistory> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('The file has no sheet');
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: '', dateNF: 'yyyy-mm-dd hh:mm:ss' });
  const parsed = parseOldPlatformSheet(aoa);
  if (!parsed.rows.length) throw new Error('No positions found. Use the old platform’s "Summary + Position" Excel export.');
  return parsed;
}

/**
 * Super Admin: load a vehicle's history exported from the old platform ("Summary + Position" Excel) into VeeTrax.
 * Only points before VeeTrax's own first fix are imported; VeeTrax recalculates trips / stops / km and keeps the
 * odometer at the chosen value. Imports can be removed again.
 */
export function HistoryImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; parsed: ParsedOldHistory } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [vehicleName, setVehicleName] = useState('');
  const [objectId, setObjectId] = useState<string | null>(null);
  const [odometer, setOdometer] = useState('');
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);

  const reset = () => {
    setFile(null);
    setFileError(null);
    setVehicleName('');
    setObjectId(null);
    setOdometer('');
    setProgress(null);
  };

  const preview = useQuery({
    queryKey: ['history-import', 'preview', objectId, vehicleName],
    queryFn: () => api.post<HistoryImportPreview>('/admin/history-import/preview', objectId ? { objectId } : { deviceName: vehicleName }),
    enabled: open && !!file && (!!objectId || !!vehicleName.trim()),
    refetchInterval: (q) => (q.state.data?.imports.some((i) => i.status === 'SUMMARIZING' || i.status === 'REMOVING') ? 10_000 : false),
  });
  const p = preview.data;
  const tz = p?.vehicle?.timezone ?? 'Asia/Kolkata';

  // Points to import: before VeeTrax's own first fix (in the company's local time, as in the export).
  const plan = useMemo(() => {
    if (!file) return null;
    const cutoffLocal = p?.ownDataFrom ? localOf(p.ownDataFrom, tz) : null;
    const rows = cutoffLocal ? file.parsed.rows.filter((r) => r[0] < cutoffLocal) : file.parsed.rows;
    return { rows, cutoffLocal, after: file.parsed.rows.length - rows.length, km: straightLineKm(rows) };
  }, [file, p?.ownDataFrom, tz]);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setFileError(null);
    try {
      const parsed = await readFile(f);
      setFile({ name: f.name, parsed });
      setObjectId(null);
      setVehicleName(parsed.deviceNames[0] ?? '');
      setOdometer('');
    } catch (e) {
      setFile(null);
      setFileError(errorMessage(e));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const run = useMutation({
    mutationFn: async () => {
      if (!file || !plan || !p?.vehicle) throw new Error('Choose the file and the vehicle first');
      const rows = plan.rows;
      if (!rows.length) throw new Error('Nothing to import: every point is after VeeTrax’s own data starts');
      const odo = odometer.trim() ? Number(odometer) : null;
      if (odo !== null && (!Number.isFinite(odo) || odo < 0)) throw new Error('Enter a valid odometer');
      const started = await api.post<{ id: string; cutoff: string | null }>('/admin/history-import', {
        objectId: p.vehicle.objectId,
        fileName: file.name,
        firstLocal: rows[0][0],
        lastLocal: rows[rows.length - 1][0],
        points: rows.length,
        oldKm: file.parsed.oldKm,
        ...(odo !== null ? { odometerKm: odo } : {}),
      });
      let inserted = 0;
      setProgress({ sent: 0, total: rows.length });
      for (let i = 0; i < rows.length; i += HISTORY_IMPORT_CHUNK) {
        const chunk = rows.slice(i, i + HISTORY_IMPORT_CHUNK);
        inserted += (await api.post<{ inserted: number }>(`/admin/history-import/${started.id}/points`, { rows: chunk })).inserted;
        setProgress({ sent: Math.min(rows.length, i + chunk.length), total: rows.length });
      }
      const done = await api.post<HistoryImportDto>(`/admin/history-import/${started.id}/finish`, {});
      return { inserted, done };
    },
    onSuccess: ({ inserted }) => {
      toast.success(t('{{n}} points imported. VeeTrax is recalculating trips and km; the odometer is set when it finishes (about a minute).', { n: inserted.toLocaleString() }));
      void queryClient.invalidateQueries({ queryKey: ['history-import'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: () => setProgress(null),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.post<HistoryImportDto>(`/admin/history-import/${id}/remove`, {}),
    onSuccess: () => {
      toast.success(t('Import removed. VeeTrax is recalculating the vehicle; the odometer stays as it is.'));
      void queryClient.invalidateQueries({ queryKey: ['history-import'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const busy = run.isPending || remove.isPending;
  const running = p?.imports.some((i) => ['UPLOADING', 'SUMMARIZING', 'REMOVING'].includes(i.status));
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
          <DialogTitle>{t('Import old history')}</DialogTitle>
          <DialogDescription>
            {t('Load a vehicle’s history from the old platform ("Summary + Position" Excel). VeeTrax keeps only points before its own data starts, recalculates trips, stops and km with its own addresses, and keeps the odometer at the value you choose.')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('Excel file')} htmlFor="hi-file" hint={t('Old platform → Reports → Summary + Position → Excel (one vehicle)')}>
              <div className="flex items-center gap-2">
                <input ref={fileRef} id="hi-file" type="file" accept=".xls,.xlsx" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
                <Button type="button" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
                  <UploadIcon /> {file ? t('Choose another file') : t('Choose file')}
                </Button>
                {file && <span className="text-sm text-muted-foreground">{file.name}</span>}
              </div>
            </Field>
            {file && (
              <Field label={t('Vehicle')} htmlFor="hi-vehicle" hint={t('Matched by name or plate; change it to search again')}>
                <Input
                  id="hi-vehicle"
                  value={vehicleName}
                  disabled={busy}
                  onChange={(e) => {
                    setVehicleName(e.target.value);
                    setObjectId(null);
                  }}
                />
              </Field>
            )}
          </div>
          {fileError && <FormError message={fileError} />}
          {preview.isError && <FormError message={errorMessage(preview.error)} />}

          {file && p && !p.vehicle && (
            <div className="rounded-md border p-3 text-sm">
              {p.candidates.length ? (
                <>
                  <p className="mb-2">{t('Several vehicles match. Choose one:')}</p>
                  <div className="flex flex-wrap gap-2">
                    {p.candidates.map((c) => (
                      <Button key={c.objectId} size="sm" variant="outline" onClick={() => setObjectId(c.objectId)}>
                        {c.name} · {c.companyName}
                      </Button>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-destructive">{t('No vehicle with this name or plate. Type the VeeTrax vehicle name or plate exactly.')}</p>
              )}
            </div>
          )}

          {file && p?.vehicle && plan && (
            <div className="grid gap-2 rounded-md border p-3 text-sm">
              <div className="font-medium">
                {p.vehicle.name} · {p.vehicle.companyName} {p.vehicle.deviceUniqueId ? `· IMEI ${p.vehicle.deviceUniqueId}` : ''}
              </div>
              {!p.vehicle.deviceUniqueId && <FormError message={t('This vehicle has no device fitted: fit its tracker first.')} />}
              <div className="grid gap-1 sm:grid-cols-2">
                <span>{t('In the file')}</span>
                <span className="tabular-nums">
                  {fmtLocal(file.parsed.rows[0][0])} → {fmtLocal(file.parsed.rows[file.parsed.rows.length - 1][0])} · {file.parsed.rows.length.toLocaleString()} {t('points')}
                  {file.parsed.oldKm !== null && ` · ${t('old platform')} ${file.parsed.oldKm.toLocaleString()} km`}
                </span>
                <span>{t('VeeTrax’s own data starts')}</span>
                <span className="tabular-nums">{plan.cutoffLocal ? fmtLocal(plan.cutoffLocal) : t('no data yet')}</span>
                <span className="font-medium">{t('Will be imported')}</span>
                <span className="font-medium tabular-nums">
                  {plan.rows.length ? `${fmtLocal(plan.rows[0][0])} → ${fmtLocal(plan.rows[plan.rows.length - 1][0])} · ${plan.rows.length.toLocaleString()} ${t('points')} · ≈ ${plan.km.toLocaleString()} km` : t('nothing (all after VeeTrax’s data)')}
                </span>
                {plan.after > 0 && (
                  <>
                    <span>{t('Skipped (already in VeeTrax)')}</span>
                    <span className="tabular-nums">{plan.after.toLocaleString()}</span>
                  </>
                )}
                {file.parsed.skipped > 0 && (
                  <>
                    <span>{t('Skipped (bad time / position)')}</span>
                    <span className="tabular-nums">{file.parsed.skipped.toLocaleString()}</span>
                  </>
                )}
                <span>{t('History kept')}</span>
                <span>
                  {t('{{days}} days; imported history stays until {{until}}, then the normal {{days}} days apply', {
                    days: p.retentionDays,
                    until: p.holdAfterImport.until,
                  })}
                </span>
              </div>
              <Field label={t('Odometer after the import (km)')} htmlFor="hi-odo" hint={t('Stays at this value; the imported km only fill the past. Default: the current odometer.')}>
                <Input id="hi-odo" type="number" min={0} step="0.1" placeholder={p.odometerKm !== null ? String(p.odometerKm) : ''} value={odometer} onChange={(e) => setOdometer(e.target.value)} className="max-w-48" />
              </Field>
              <p className="text-xs text-muted-foreground">
                {t('VeeTrax recalculates the km from the points (often 2–5% lower than the old platform when its points are a minute apart). Addresses come from VeeTrax’s own geocoding.')}
              </p>
            </div>
          )}

          {progress && (
            <div className="grid gap-1 text-sm">
              <span>
                {t('Uploading')} {progress.sent.toLocaleString()} / {progress.total.toLocaleString()}
              </span>
              <div className="h-2 overflow-hidden rounded bg-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${Math.round((progress.sent / Math.max(1, progress.total)) * 100)}%` }} />
              </div>
            </div>
          )}

          {!!p?.imports.length && (
            <div className="grid gap-2">
              <h4 className="text-sm font-semibold">{t('Imports for this vehicle')}</h4>
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">{t('File')}</th>
                      <th className="px-3 py-2">{t('Period')}</th>
                      <th className="px-3 py-2 text-right">{t('Points')}</th>
                      <th className="px-3 py-2 text-right">{t('km')}</th>
                      <th className="px-3 py-2">{t('Status')}</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {p.imports.map((i) => (
                      <tr key={i.id} className="border-b last:border-0">
                        <td className="px-3 py-2">{i.fileName}</td>
                        <td className="px-3 py-2 text-xs">
                          {fmtIso(i.from)} → {fmtIso(i.to)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{i.inserted.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {i.importedKm ?? '—'}
                          {i.oldKm !== null && <div className="text-xs text-muted-foreground">{t('old {{km}}', { km: i.oldKm })}</div>}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant={STATUS[i.status].variant}>{t(STATUS[i.status].label)}</Badge>
                          {i.error && <div className="text-xs text-muted-foreground">{i.error}</div>}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {(i.status === 'DONE' || i.status === 'FAILED') && (
                            <Button size="sm" variant="ghost" disabled={busy} title={t('Remove import')} onClick={() => window.confirm(t('Remove this import? Only the imported points are deleted; VeeTrax’s own data stays.')) && remove.mutate(i.id)}>
                              <Trash2Icon />
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => (reset(), onOpenChange(false))}>
            {t('Close')}
          </Button>
          <Button disabled={!p?.vehicle?.deviceUniqueId || !plan?.rows.length || busy || !!running} onClick={() => run.mutate()}>
            {run.isPending ? <Spinner /> : <HistoryIcon />}
            {plan?.rows.length ? t('Import {{n}} points', { n: plan.rows.length.toLocaleString() }) : t('Import')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
