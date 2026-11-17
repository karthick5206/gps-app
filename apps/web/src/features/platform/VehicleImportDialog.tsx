import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  mapVehicleImportHeaders,
  VEHICLE_IMPORT_MAX_ROWS,
  type CompanyDto,
  type DeviceModelDto,
  type VehicleImportAction,
  type VehicleImportField,
  type VehicleImportRequest,
  type VehicleImportResult,
  type VehicleImportRowInput,
} from '@veetracer/shared';
import { DownloadIcon, FileSpreadsheetIcon, RefreshCwIcon, UploadIcon } from 'lucide-react';
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { modelOption } from '@/features/masters/device-shared';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, errorMessage } from '@/lib/api';

const sel = 'h-9 w-full rounded-md border border-input bg-card px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

/** Template columns (also the order of the downloaded template). */
const TEMPLATE: { field: VehicleImportField; header: string; sample: string }[] = [
  { field: 'vehicleName', header: 'Vehicle name', sample: 'TN 02 BM 2227' },
  { field: 'imei', header: 'IMEI', sample: '355172106796574' },
  { field: 'model', header: 'Model', sample: 'Concox V5' },
  { field: 'sim', header: 'SIM number', sample: '5754180515393' },
  { field: 'vehicleType', header: 'Vehicle type', sample: 'Car' },
  { field: 'plate', header: 'Plate number', sample: '' },
  { field: 'company', header: 'Company', sample: '' },
  { field: 'branch', header: 'Branch', sample: 'Head Office' },
  { field: 'vendor', header: 'Vendor', sample: '' },
  { field: 'driverName', header: 'Driver name', sample: '' },
  { field: 'driverMobile', header: 'Driver mobile', sample: '' },
  { field: 'licenceFrom', header: 'Licence from', sample: '' },
  { field: 'licenceUntil', header: 'Licence until', sample: '' },
];

const VEHICLE_TYPE_LABEL: Record<string, string> = { CAR: 'Car', BIKE: 'Bike', TRUCK: 'Truck', BUS: 'Bus', SCHOOL_BUS: 'School bus', VAN: 'Van', AUTO: 'Auto', OTHER: 'Other' };

const ACTION_LABEL: Record<VehicleImportAction, string> = { NEW: 'New', LINK: 'Fit to existing vehicle', STOCK: 'From stock', SKIP: 'Already there', ERROR: 'Error' };
const ACTION_VARIANT: Record<VehicleImportAction, 'default' | 'secondary' | 'destructive' | 'outline'> = { NEW: 'default', LINK: 'secondary', STOCK: 'secondary', SKIP: 'outline', ERROR: 'destructive' };

const pad = (n: number) => String(n).padStart(2, '0');
/** A cell as text: whole numbers in full (IMEI / SIM), dates as YYYY-MM-DD. */
function cellText(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  if (typeof v === 'number') return Number.isInteger(v) ? v.toFixed(0) : String(v);
  return String(v).trim();
}
/** 17-11-2026 / 17/11/2026 / 17.11.26 (Indian day-month order) or 2026-11-17 → YYYY-MM-DD; anything else unchanged. */
function dayText(v: unknown): string {
  const s = cellText(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (!m) return s;
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`;
}

/** What a check depends on (everything but the reason), in a fixed key order. */
const planKeyOf = (b: VehicleImportRequest | null, fallback?: { licenceFrom: string; licenceUntil: string }) =>
  b ? JSON.stringify([b.companyId ?? null, b.branchId ?? null, b.defaultModelId ?? null, b.licenceFrom || fallback?.licenceFrom || null, b.licenceUntil || fallback?.licenceUntil || null, b.rows]) : '';

interface Parsed {
  fileName: string;
  rows: VehicleImportRowInput[];
  found: VehicleImportField[];
}

async function readSheet(file: File): Promise<Parsed> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('The file has no sheet');
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: '', blankrows: false });
  // The header is the first of the top 10 rows that names an IMEI column and a vehicle column.
  let headerIdx = -1;
  let map: Partial<Record<VehicleImportField, number>> = {};
  for (let i = 0; i < Math.min(10, aoa.length); i++) {
    const m = mapVehicleImportHeaders(aoa[i] ?? []);
    if (m.imei !== undefined && m.vehicleName !== undefined) {
      headerIdx = i;
      map = m;
      break;
    }
  }
  if (headerIdx < 0) throw new Error('No header row found: the sheet needs at least "Vehicle name" and "IMEI" columns');
  const get = (row: unknown[], f: VehicleImportField) => (map[f] === undefined ? '' : cellText(row[map[f]!]));
  const rows: VehicleImportRowInput[] = [];
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const row = aoa[i] ?? [];
    if (!get(row, 'vehicleName') && !get(row, 'imei')) continue;
    rows.push({
      row: i + 1,
      vehicleName: get(row, 'vehicleName'),
      plate: get(row, 'plate') || null,
      imei: get(row, 'imei'),
      model: get(row, 'model') || null,
      sim: get(row, 'sim') || null,
      company: get(row, 'company') || null,
      branch: get(row, 'branch') || null,
      vendor: get(row, 'vendor') || null,
      driverName: get(row, 'driverName') || null,
      driverMobile: get(row, 'driverMobile') || null,
      vehicleType: get(row, 'vehicleType') || null,
      licenceFrom: map.licenceFrom === undefined ? null : dayText(row[map.licenceFrom]) || null,
      licenceUntil: map.licenceUntil === undefined ? null : dayText(row[map.licenceUntil]) || null,
    });
  }
  if (!rows.length) throw new Error('The sheet has no rows under the header');
  if (rows.length > VEHICLE_IMPORT_MAX_ROWS) throw new Error(`At most ${VEHICLE_IMPORT_MAX_ROWS} rows per import: split the sheet`);
  return { fileName: file.name, rows, found: Object.keys(map) as VehicleImportField[] };
}

async function downloadTemplate() {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.aoa_to_sheet([TEMPLATE.map((c) => c.header), TEMPLATE.map((c) => c.sample)]);
  ws['!cols'] = TEMPLATE.map((c) => ({ wch: Math.max(14, c.header.length + 2) }));
  // IMEI / SIM / mobile columns as text so Excel keeps every digit.
  for (const f of ['imei', 'sim', 'driverMobile'] as const) {
    const col = XLSX.utils.encode_col(TEMPLATE.findIndex((c) => c.field === f));
    const cell = ws[`${col}2`];
    if (cell) {
      cell.t = 's';
      cell.z = '@';
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Vehicles');
  XLSX.writeFile(wb, 'VeeTrax-vehicle-import-template.xlsx');
}

/**
 * Super Admin → Device Inventory → Import vehicles: one sheet maps company → branch → vehicle → device (IMEI, model,
 * SIM) → vendor → driver → licence. Check shows what will happen per row; Import writes everything in one go.
 */
export function VehicleImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [companyQ, setCompanyQ] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [modelId, setModelId] = useState('');
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  const [checkedKey, setCheckedKey] = useState('');

  const companies = useEntityOptions<CompanyDto>('/admin/companies', named, { q: companyQ, enabled: open });
  const models = useEntityOptions<DeviceModelDto>('/device-models', modelOption, { enabled: open });
  const branches = useQuery({
    queryKey: ['import-branches', companyId],
    queryFn: ({ signal }) => api.get<{ id: string; name: string }[]>('/admin/devices/import/branches', { companyId }, signal),
    enabled: open && !!companyId,
  });

  const request = useMemo<VehicleImportRequest | null>(
    () =>
      parsed && {
        companyId: companyId || null,
        branchId: branchId || null,
        defaultModelId: modelId || null,
        rows: parsed.rows,
        overrideReason: reason.trim() || null,
        licenceFrom: from || null,
        licenceUntil: until || null,
      },
    [parsed, companyId, branchId, modelId, reason, from, until],
  );
  // Anything but the reason changes the plan: Import needs a fresh check.
  const planKey = planKeyOf(request);

  const check = useMutation({
    mutationFn: (body: VehicleImportRequest) => api.post<VehicleImportResult>('/admin/devices/import/preview', body),
    onSuccess: (r, body) => {
      if (!from) setFrom(r.licenceFrom);
      if (!until) setUntil(r.licenceUntil);
      setCheckedKey(planKeyOf(body, r));
    },
  });
  const commit = useMutation({
    mutationFn: (body: VehicleImportRequest) => api.post<VehicleImportResult>('/admin/devices/import/commit', body),
    onSuccess: (r) => {
      const added = r.counts.NEW + r.counts.LINK + r.counts.STOCK;
      toast.success(t('Imported {{n}} device(s); {{c}} complimentary licence(s)', { n: added, c: r.complimentary }));
      void qc.invalidateQueries();
      close(false);
    },
  });

  const close = (o: boolean) => {
    if (o) return onOpenChange(true);
    if (commit.isPending) return;
    setParsed(null);
    setParseError(null);
    setFrom('');
    setUntil('');
    setReason('');
    setCheckedKey('');
    check.reset();
    commit.reset();
    onOpenChange(false);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setParseError(null);
    check.reset();
    try {
      const p = await readSheet(file);
      setParsed(p);
      check.mutate({ companyId: companyId || null, branchId: branchId || null, defaultModelId: modelId || null, rows: p.rows, licenceFrom: from || null, licenceUntil: until || null });
    } catch (e) {
      setParsed(null);
      setParseError(e instanceof Error ? e.message : String(e));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const result = check.data;
  const fresh = !!result && checkedKey === planKey;
  const toImport = result ? result.counts.NEW + result.counts.LINK + result.counts.STOCK : 0;
  const vendorOrDriverLinks = result ? result.rows.filter((r) => r.action !== 'ERROR' && (r.vendorName || r.driverName)).length : 0;
  const needReason = !!result && result.complimentary > 0;
  const canImport = fresh && !result.counts.ERROR && (toImport > 0 || vendorOrDriverLinks > 0) && (!needReason || reason.trim().length >= 3) && !commit.isPending;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[92vh] max-w-6xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('Import vehicles')}</DialogTitle>
          <DialogDescription>
            {t('One sheet: company → branch → vehicle → device (IMEI, model, SIM) → vendor → driver → licence. Only Vehicle name and IMEI are required; empty Company / Branch use the ones chosen here.')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-4">
            <Field label={t('Company')} htmlFor="vi-company" hint={t('For rows without a Company')}>
              <Input placeholder={t('Search…')} value={companyQ} onChange={(e) => setCompanyQ(e.target.value)} className="mb-1 h-8" />
              <select
                id="vi-company"
                className={sel}
                value={companyId}
                onChange={(e) => {
                  setCompanyId(e.target.value);
                  setBranchId('');
                }}
              >
                <option value="">{t('— none —')}</option>
                {companies.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('Branch')} htmlFor="vi-branch" hint={t('For rows without a Branch')}>
              <select id="vi-branch" className={`${sel} md:mt-9`} value={branchId} onChange={(e) => setBranchId(e.target.value)} disabled={!companyId}>
                <option value="">{t('— no branch —')}</option>
                {(branches.data ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('Default model')} htmlFor="vi-model" hint={t('For rows without a known Model')}>
              <select id="vi-model" className={`${sel} md:mt-9`} value={modelId} onChange={(e) => setModelId(e.target.value)}>
                <option value="">{t('— from the sheet —')}</option>
                {models.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('Sheet')} htmlFor="vi-file" hint={t('.xls, .xlsx or .csv — first sheet')}>
              <div className="flex flex-wrap gap-2 md:mt-9">
                <input ref={fileRef} id="vi-file" type="file" accept=".xls,.xlsx,.csv" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
                <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                  <UploadIcon /> {t('Choose file')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void downloadTemplate()}>
                  <DownloadIcon /> {t('Template')}
                </Button>
              </div>
            </Field>
          </div>

          <FormError message={parseError} />
          {parsed && (
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <FileSpreadsheetIcon className="size-4" />
              <span className="font-medium text-foreground">{parsed.fileName}</span> · {t('{{n}} rows', { n: parsed.rows.length })} · {t('columns found')}: {parsed.found.map((f) => TEMPLATE.find((c) => c.field === f)?.header ?? f).join(', ')}
            </p>
          )}

          {parsed && (
            <div className="grid gap-3 rounded-lg border p-3 md:grid-cols-4">
              <Field label={t('Complimentary licence from')} htmlFor="vi-from">
                <Input id="vi-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label={t('Complimentary licence until')} htmlFor="vi-until" hint={t('Rows with their own Licence from / until keep those')}>
                <Input id="vi-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
              </Field>
              <Field label={t('Reason (for complimentary licences)')} htmlFor="vi-reason" required={needReason} className="md:col-span-2">
                <Input id="vi-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder={t('e.g. Licence payment assured, invoice to follow')} />
              </Field>
              <p className="text-xs text-muted-foreground md:col-span-4">
                {t('Each device takes a free paid licence of its company first (those keep their own dates). Only devices without one get a complimentary licence with these dates. You can change any licence’s dates later in Licences → company → select → Change dates.')}
              </p>
            </div>
          )}

          <FormError message={check.error ? errorMessage(check.error) : commit.error ? errorMessage(commit.error) : null} />

          {result && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {(Object.keys(ACTION_LABEL) as VehicleImportAction[])
                  .filter((a) => result.counts[a])
                  .map((a) => (
                    <Badge key={a} variant={ACTION_VARIANT[a]}>
                      {t(ACTION_LABEL[a])}: {result.counts[a]}
                    </Badge>
                  ))}
                {!fresh && <span className="text-xs text-warning-fg">{t('Settings changed: check again before importing')}</span>}
              </div>
              {(result.licences.length > 0 || result.newVendors.length > 0 || result.newDrivers.length > 0) && (
                <div className="grid gap-1 rounded-lg bg-muted/40 p-3 text-sm">
                  {result.licences.map((l) => (
                    <div key={l.companyName}>
                      <span className="font-medium">{l.companyName}</span>:{' '}
                      {l.exempt
                        ? t('platform company, no licences needed')
                        : t('{{needed}} device(s) need a licence · {{free}} free paid licence(s) · {{comp}} complimentary', { needed: l.needed, free: l.free, comp: l.complimentary })}
                    </div>
                  ))}
                  {result.newVendors.length > 0 && <div>{t('New vendors')}: {result.newVendors.join(', ')}</div>}
                  {result.newDrivers.length > 0 && <div>{t('New drivers')}: {result.newDrivers.join(', ')}</div>}
                </div>
              )}
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">{t('Row')}</TableHead>
                      <TableHead>{t('Vehicle')}</TableHead>
                      <TableHead>{t('IMEI')}</TableHead>
                      <TableHead>{t('Model')}</TableHead>
                      <TableHead>{t('SIM')}</TableHead>
                      <TableHead>{t('Company / branch')}</TableHead>
                      <TableHead>{t('Vendor / driver')}</TableHead>
                      <TableHead>{t('Licence (if complimentary)')}</TableHead>
                      <TableHead>{t('Result')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.rows.map((r) => (
                      <TableRow key={r.row} className={r.action === 'ERROR' ? 'bg-destructive/5' : undefined}>
                        <TableCell className="tabular-nums">{r.row}</TableCell>
                        <TableCell>
                          <div className="font-medium">{r.vehicleName}</div>
                          {r.plate !== r.vehicleName && <div className="text-xs text-muted-foreground">{r.plate}</div>}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{r.imei}</TableCell>
                        <TableCell className="text-xs">
                          {r.modelLabel ?? '—'}
                          <div className="text-muted-foreground">{t(VEHICLE_TYPE_LABEL[r.vehicleType] ?? r.vehicleType)}</div>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{r.sim ?? '—'}</TableCell>
                        <TableCell className="text-xs">
                          {r.companyName ?? '—'}
                          {r.branchName && <div className="text-muted-foreground">{r.branchName}</div>}
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.vendorName ?? '—'}
                          {r.driverName && <div className="text-muted-foreground">{r.driverName}</div>}
                        </TableCell>
                        <TableCell className="text-xs tabular-nums">{r.licenceFrom && r.licenceUntil ? `${r.licenceFrom} → ${r.licenceUntil}` : '—'}</TableCell>
                        <TableCell className="min-w-56 text-xs">
                          <Badge variant={ACTION_VARIANT[r.action]}>{t(ACTION_LABEL[r.action])}</Badge>
                          {r.errors.map((m) => (
                            <div key={m} className="mt-1 text-destructive-fg">
                              {m}
                            </div>
                          ))}
                          {r.warnings.map((m) => (
                            <div key={m} className="mt-1 text-warning-fg">
                              {m}
                            </div>
                          ))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={commit.isPending}>
            {t('Cancel')}
          </Button>
          {parsed && (
            <Button variant="outline" onClick={() => request && check.mutate(request)} disabled={check.isPending || commit.isPending}>
              {check.isPending ? <Spinner /> : <RefreshCwIcon />}
              {t('Check again')}
            </Button>
          )}
          <Button onClick={() => request && commit.mutate(request)} disabled={!canImport}>
            {commit.isPending ? <Spinner /> : <UploadIcon />}
            {toImport ? t('Import {{n}} device(s)', { n: toImport }) : t('Import')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
