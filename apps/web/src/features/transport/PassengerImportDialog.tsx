import { PASSENGER_IMPORT_COLUMNS, type PassengerImportAction, type PassengerImportResult, type PassengerImportRowResult } from '@veetracer/shared';
import { CheckCircle2Icon, DownloadIcon, FileUpIcon, UploadIcon } from 'lucide-react';
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
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  committableRows,
  countCsvDataRows,
  formatRowSelection,
  IMPORT_ACTION_META,
  IMPORT_FILE_PROBLEM_TEXT,
  IMPORT_ISSUE_LABEL,
  importFileProblem,
  importLimits,
  parseRowSelection,
  PASSENGER_IMPORT_EXAMPLE,
  passengerImportTemplate,
} from './people-format';
import { usePassengerImport } from './use-people';

const SHOW_MAX = 300;
const ROWS_FIELD_MAX = 20_000;
const REQUIRED = new Set(['employee_code', 'name']);
const COLUMN_HELP: Partial<Record<(typeof PASSENGER_IMPORT_COLUMNS)[number], string>> = {
  mobile: 'Local numbers get the company’s country code.',
  home_address: 'Geocoded only when “Find coordinates” is on and no coordinates are given.',
  home_lat: 'With home_lng; decimal degrees.',
  office: 'Name or ID of an active place.',
  default_stop: 'Name or ID of an active place.',
  branch: 'Name or ID of an active branch.',
  wheelchair: 'yes / no',
  active: 'yes / no (default yes)',
};

type View = 'all' | 'errors' | 'duplicates' | 'warnings' | 'changes';

function downloadTemplate() {
  const blob = new Blob([passengerImportTemplate()], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'passengers-template.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Passenger import wizard (doc 05 §2.2, 07 §6.1): template → upload → server preview (row errors, duplicates, optional
 * Photon geocoding) → commit all valid rows or a selection (`rows="1,3-5"`) → result. Re-importing the same file creates
 * nothing new (the server is idempotent on employee code). Limits: 10,000 rows, 5 MB.
 */
export function PassengerImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const importer = usePassengerImport();
  const [file, setFile] = useState<File | null>(null);
  const [fileIssue, setFileIssue] = useState<string | null>(null);
  const [geocode, setGeocode] = useState(false);
  const [preview, setPreview] = useState<PassengerImportResult | null>(null);
  const [previewGeocode, setPreviewGeocode] = useState(false);
  const [result, setResult] = useState<PassengerImportResult | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selectionText, setSelectionText] = useState('');
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [view, setView] = useState<View>('all');
  const [dragging, setDragging] = useState(false);

  const committable = useMemo(() => (preview ? committableRows(preview.rows) : []), [preview]);
  const committableSet = useMemo(() => new Set(committable), [committable]);
  const chosen = useMemo(() => committable.filter((r) => selected.has(r)), [committable, selected]);
  const allChosen = chosen.length === committable.length;
  const rowsParam = allChosen ? undefined : formatRowSelection(chosen);

  const reset = () => {
    setFile(null);
    setFileIssue(null);
    setPreview(null);
    setResult(null);
    setSelected(new Set());
    setSelectionText('');
    setSelectionError(null);
    setView('all');
    importer.reset();
  };
  const close = (o: boolean) => {
    if (importer.isPending) return;
    if (!o) reset();
    onOpenChange(o);
  };

  const pick = async (f: File | undefined | null) => {
    importer.reset();
    setPreview(null);
    if (!f) return;
    const problem = importFileProblem(f);
    if (problem) {
      setFile(null);
      setFileIssue(t(IMPORT_FILE_PROBLEM_TEXT[problem]));
      return;
    }
    const rows = countCsvDataRows(await f.text());
    if (rows > importLimits.maxRows) {
      setFile(null);
      setFileIssue(t(IMPORT_FILE_PROBLEM_TEXT.TOO_MANY_ROWS));
      return;
    }
    if (rows === 0) {
      setFile(null);
      setFileIssue(t('The file has a header but no rows.'));
      return;
    }
    setFileIssue(null);
    setFile(f);
  };

  const runPreview = () => {
    if (!file) return;
    importer.mutate(
      { file, commit: false, geocode },
      {
        onSuccess: (res) => {
          setPreview(res);
          setPreviewGeocode(geocode);
          const rows = committableRows(res.rows);
          setSelected(new Set(rows));
          setSelectionText(formatRowSelection(rows));
          setSelectionError(null);
          setView(res.errors ? 'errors' : 'all');
        },
      },
    );
  };

  const runCommit = () => {
    if (!file || !chosen.length) return;
    if (rowsParam && rowsParam.length > ROWS_FIELD_MAX) {
      setSelectionError(t('Too many separate rows are selected. Select ranges, or import every valid row.'));
      return;
    }
    importer.mutate(
      { file, commit: true, geocode: previewGeocode, rows: rowsParam },
      {
        onSuccess: (res) => {
          setResult(res);
          toast.success(t('{{created}} created, {{updated}} updated', { created: res.creates, updated: res.updates }));
        },
      },
    );
  };

  const toggle = (row: number, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(row);
      else next.delete(row);
      setSelectionText(formatRowSelection(committable.filter((r) => next.has(r))));
      return next;
    });
    setSelectionError(null);
  };

  const applySelectionText = (text: string) => {
    setSelectionText(text);
    const parsed = parseRowSelection(text, preview?.totalRows ?? importLimits.maxRows);
    if ('error' in parsed) {
      setSelectionError(t('{{error}}: “{{part}}”', { error: t(parsed.error), part: parsed.part }));
      return;
    }
    const rows = parsed.rows.length ? parsed.rows : committable;
    const ignored = parsed.rows.filter((r) => !committableSet.has(r)).length;
    setSelectionError(ignored ? t('{{n}} of these rows cannot be imported (errors or nothing to change) and are left out.', { n: ignored }) : null);
    setSelected(new Set(rows.filter((r) => committableSet.has(r))));
  };

  const filtered = useMemo(() => {
    const rows = preview?.rows ?? [];
    switch (view) {
      case 'errors':
        return rows.filter((r) => r.errors.length);
      case 'duplicates':
        return rows.filter((r) => r.errors.some((e) => e.code.startsWith('DUPLICATE_')));
      case 'warnings':
        return rows.filter((r) => r.warnings.length);
      case 'changes':
        return rows.filter((r) => r.action === 'CREATE' || r.action === 'UPDATE');
      default:
        return rows;
    }
  }, [preview, view]);
  const warnings = preview?.rows.filter((r) => r.warnings.length).length ?? 0;

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void pick(e.dataTransfer.files?.[0]);
  };

  const step = result ? 'done' : preview ? 'preview' : 'upload';

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className={cn(step === 'preview' ? 'max-w-5xl' : 'max-w-2xl')}>
        <DialogHeader>
          <DialogTitle>{t('Import passengers')}</DialogTitle>
          <DialogDescription>
            {step === 'upload'
              ? t('Up to 10,000 rows and 5 MB per CSV file. Nothing is saved until you import.')
              : step === 'preview'
                ? t('Check the rows, then import all valid rows or only the ones you select.')
                : t('Import finished.')}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {importer.error && <FormError message={errorMessage(importer.error)} />}

          {step === 'upload' && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" onClick={downloadTemplate}>
                  <DownloadIcon /> {t('Download CSV template')}
                </Button>
                <span className="text-xs text-muted-foreground">{t('Header row required. Comma or semicolon separated, UTF-8.')}</span>
              </div>

              <details className="rounded-lg border text-sm">
                <summary className="cursor-pointer px-3 py-2 font-medium">{t('Columns')}</summary>
                <div className="overflow-x-auto border-t">
                  <table className="w-full text-xs">
                    <thead className="bg-muted text-left">
                      <tr>
                        <th className="px-3 py-1.5 font-medium">{t('Column')}</th>
                        <th className="px-3 py-1.5 font-medium">{t('Example')}</th>
                        <th className="px-3 py-1.5 font-medium">{t('Notes')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {PASSENGER_IMPORT_COLUMNS.map((c) => (
                        <tr key={c}>
                          <td className="px-3 py-1.5 font-mono whitespace-nowrap">
                            {c}
                            {REQUIRED.has(c) && <span className="text-destructive"> *</span>}
                          </td>
                          <td className="px-3 py-1.5 break-all">{PASSENGER_IMPORT_EXAMPLE[c] || '—'}</td>
                          <td className="px-3 py-1.5 text-muted-foreground">{REQUIRED.has(c) ? t('Required') : COLUMN_HELP[c] ? t(COLUMN_HELP[c]!) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>

              <label
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                className={cn(
                  'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center text-sm transition-colors focus-within:ring-2 focus-within:ring-ring',
                  dragging ? 'border-primary bg-accent' : 'hover:bg-accent/50',
                )}
              >
                <FileUpIcon className="size-8 text-muted-foreground" aria-hidden />
                <span className="font-medium">{file ? file.name : t('Choose a CSV file or drop it here')}</span>
                {file && <span className="text-xs text-muted-foreground">{t('{{kb}} KB', { kb: Math.ceil(file.size / 1024).toLocaleString() })}</span>}
                <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => void pick(e.target.files?.[0])} aria-label={t('CSV file')} />
              </label>
              {fileIssue && <FormError message={fileIssue} />}

              <GeocodeToggle value={geocode} onChange={setGeocode} />
            </>
          )}

          {step === 'preview' && preview && (
            <>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                <Stat label={t('Rows')} value={preview.totalRows} />
                <Stat label={t('New')} value={preview.creates} tone="success" />
                <Stat label={t('Updates')} value={preview.updates} tone="info" />
                <Stat label={t('Unchanged')} value={preview.unchanged} />
                <Stat label={t('Errors')} value={preview.errors} tone={preview.errors ? 'destructive' : undefined} />
                <Stat label={t('Duplicates')} value={preview.duplicates} tone={preview.duplicates ? 'warning' : undefined} />
              </div>

              <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
                <GeocodeToggle value={geocode} onChange={setGeocode} compact />
                {geocode !== previewGeocode && (
                  <Button size="sm" variant="outline" onClick={runPreview} disabled={importer.isPending}>
                    {importer.isPending && <Spinner />}
                    {t('Check again')}
                  </Button>
                )}
              </div>

              <div role="radiogroup" aria-label={t('Show rows')} className="flex flex-wrap gap-1.5">
                {(
                  [
                    ['all', t('All'), preview.totalRows],
                    ['errors', t('Errors'), preview.errors],
                    ['duplicates', t('Duplicates'), preview.duplicates],
                    ['warnings', t('Warnings'), warnings],
                    ['changes', t('To import'), committable.length],
                  ] as const
                ).map(([v, label, n]) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={view === v}
                    onClick={() => setView(v)}
                    className={cn(
                      'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                      view === v ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {label} <span className="tabular-nums">{n.toLocaleString()}</span>
                  </button>
                ))}
              </div>

              <div className="max-h-[45vh] overflow-auto rounded-lg border">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-muted">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-10">
                        <span className="sr-only">{t('Import')}</span>
                      </TableHead>
                      <TableHead className="w-14">{t('Row')}</TableHead>
                      <TableHead>{t('Employee')}</TableHead>
                      <TableHead>{t('Result')}</TableHead>
                      <TableHead className="hidden sm:table-cell">{t('Issues')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.slice(0, SHOW_MAX).map((r) => (
                      <PreviewRow key={r.row} row={r} canImport={committableSet.has(r.row)} checked={selected.has(r.row)} onToggle={(on) => toggle(r.row, on)} />
                    ))}
                    {filtered.length === 0 && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                          {t('No rows in this view.')}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              {filtered.length > SHOW_MAX && <p className="text-xs text-muted-foreground">{t('Showing the first {{n}} rows of this view. Use the filters to see the others.', { n: SHOW_MAX })}</p>}

              <Field
                label={t('Rows to import')}
                htmlFor="pax-import-rows"
                hint={t('Row numbers or ranges, e.g. 1,3-5. Empty = every valid row.')}
                error={selectionError ?? undefined}
              >
                <Input id="pax-import-rows" value={selectionText} onChange={(e) => applySelectionText(e.target.value)} className="font-mono" autoComplete="off" />
              </Field>
            </>
          )}

          {step === 'done' && result && (
            <div className="space-y-4">
              <p className="flex items-center gap-2 text-sm font-medium text-success-fg">
                <CheckCircle2Icon className="size-5" aria-hidden /> {t('Import finished')}
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <Stat label={t('Created')} value={result.creates} tone="success" />
                <Stat label={t('Updated')} value={result.updates} tone="info" />
                <Stat label={t('Unchanged')} value={result.unchanged} />
                <Stat label={t('Not imported (errors)')} value={result.errors} tone={result.errors ? 'destructive' : undefined} />
                <Stat label={t('Skipped (not selected)')} value={result.skipped} />
              </div>
              {result.errors > 0 && (
                <p className="text-sm text-muted-foreground">{t('Fix the rows with errors in the file and import it again. Rows already imported stay unchanged, so nothing is created twice.')}</p>
              )}
              {result.rows.some((r) => r.warnings.some((w) => w.code === 'NO_LOCATION' || w.code.startsWith('GEOCODE'))) && (
                <p className="text-sm text-muted-foreground">{t('Passengers without a confirmed location are in the “Needs location” filter of the list.')}</p>
              )}
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          {step === 'upload' && (
            <>
              <Button variant="outline" onClick={() => close(false)}>
                {t('Cancel')}
              </Button>
              <Button onClick={runPreview} disabled={!file || importer.isPending}>
                {importer.isPending ? <Spinner /> : <UploadIcon />} {t('Check file')}
              </Button>
            </>
          )}
          {step === 'preview' && (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setPreview(null);
                  importer.reset();
                }}
                disabled={importer.isPending}
              >
                {t('Back')}
              </Button>
              <Button onClick={runCommit} disabled={!chosen.length || importer.isPending || geocode !== previewGeocode}>
                {importer.isPending && <Spinner />}
                {allChosen ? t('Import all {{n}} valid rows', { n: chosen.length.toLocaleString() }) : t('Import {{n}} selected rows', { n: chosen.length.toLocaleString() })}
              </Button>
            </>
          )}
          {step === 'done' && (
            <>
              <Button variant="outline" onClick={reset}>
                {t('Import another file')}
              </Button>
              <Button onClick={() => close(false)}>{t('Done')}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GeocodeToggle({ value, onChange, compact = false }: { value: boolean; onChange: (v: boolean) => void; compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-3">
      <Switch id={compact ? 'pax-geo-2' : 'pax-geo'} checked={value} onCheckedChange={onChange} className="mt-0.5" />
      <label htmlFor={compact ? 'pax-geo-2' : 'pax-geo'} className="text-sm">
        <span className="font-medium">{t('Find coordinates from addresses')}</span>
        {!compact && (
          <span className="block text-xs text-muted-foreground">
            {t('Rows with a home_address and no coordinates are looked up on the VeeTrax address server. Uncertain matches go to “Needs location”.')}
          </span>
        )}
      </label>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'success' | 'info' | 'warning' | 'destructive' }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <p className="truncate text-xs text-muted-foreground" title={label}>
        {label}
      </p>
      <p
        className={cn(
          'text-lg font-semibold tabular-nums',
          tone === 'success' && 'text-success-fg',
          tone === 'info' && 'text-info-fg',
          tone === 'warning' && 'text-warning-fg',
          tone === 'destructive' && 'text-destructive',
        )}
      >
        {value.toLocaleString()}
      </p>
    </div>
  );
}

function PreviewRow({ row, canImport, checked, onToggle }: { row: PassengerImportRowResult; canImport: boolean; checked: boolean; onToggle: (on: boolean) => void }) {
  const { t } = useTranslation();
  const meta = IMPORT_ACTION_META[row.action as PassengerImportAction];
  return (
    <TableRow data-state={checked ? 'selected' : undefined}>
      <TableCell>
        {canImport && <Checkbox checked={checked} onCheckedChange={(v) => onToggle(!!v)} aria-label={t('Import row {{n}}', { n: row.row })} />}
      </TableCell>
      <TableCell className="tabular-nums">{row.row}</TableCell>
      <TableCell className="min-w-0">
        <span className="block font-medium">{row.displayName || '—'}</span>
        <span className="font-mono text-xs text-muted-foreground">{row.employeeCode || '—'}</span>
        {/* QA B10: on a phone the issues are stacked under the employee, so the reason a row failed is never off-screen. */}
        <div className="mt-1 text-xs whitespace-normal sm:hidden">
          <RowIssues row={row} />
        </div>
      </TableCell>
      <TableCell>
        <Badge variant={meta.tone}>{t(meta.label)}</Badge>
      </TableCell>
      <TableCell className="hidden min-w-[14rem] text-xs sm:table-cell">
        <RowIssues row={row} />
      </TableCell>
    </TableRow>
  );
}

/** Errors, warnings and the geocode match of one preview row. */
function RowIssues({ row }: { row: PassengerImportRowResult }) {
  const { t } = useTranslation();
  return (
        <ul className="space-y-0.5">
          {row.errors.map((e, i) => (
            <li key={`e${i}`} className="text-destructive">
              {e.column && <span className="font-mono">{e.column}: </span>}
              {t(IMPORT_ISSUE_LABEL[e.code] ?? e.message)}
              {e.message && IMPORT_ISSUE_LABEL[e.code] && <span className="text-muted-foreground"> — {e.message}</span>}
            </li>
          ))}
          {row.warnings.map((w, i) => (
            <li key={`w${i}`} className="text-warning-fg">
              {w.column && <span className="font-mono">{w.column}: </span>}
              {t(IMPORT_ISSUE_LABEL[w.code] ?? w.message)}
            </li>
          ))}
          {row.geocode && (
            <li className="text-muted-foreground">
              {t('Found')}: {row.geocode.label}
              {row.geocode.confidence !== null && ` (${Math.round(row.geocode.confidence * 100)}%)`}
            </li>
          )}
          {!row.errors.length && !row.warnings.length && !row.geocode && <li className="text-muted-foreground">—</li>}
        </ul>
  );
}
