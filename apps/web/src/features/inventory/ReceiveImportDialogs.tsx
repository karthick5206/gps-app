import { useMutation } from '@tanstack/react-query';
import { DEVICE_CONDITIONS, type DeviceModelDto, type StockImportReport, type StockLocationDto, type StockReceiptDto, type SupplierDto } from '@veetracer/shared';
import { CheckCircle2Icon, DownloadIcon, FileUpIcon, XCircleIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { modelOption } from '@/features/masters/device-shared';
import { FormDialog } from '@/features/masters/FormDialog';
import { useEntityOptions } from '@/features/masters/use-options';
import { api, downloadFile, errorMessage } from '@/lib/api';
import { parseImeiList, rupeesToPaise } from './inventory-format';
import { locationOption, PlainSelect, supplierOption, useInvalidateInventory } from './shared';

const CONDITION_OPTIONS = DEVICE_CONDITIONS.map((c) => ({ value: c, label: c.charAt(0) + c.slice(1).toLowerCase() }));

function ReceiptHead({
  locationId,
  setLocationId,
  supplierId,
  setSupplierId,
  invoiceNo,
  setInvoiceNo,
  invoiceAt,
  setInvoiceAt,
  enabled,
}: {
  locationId: string;
  setLocationId: (v: string) => void;
  supplierId: string;
  setSupplierId: (v: string) => void;
  invoiceNo: string;
  setInvoiceNo: (v: string) => void;
  invoiceAt: string;
  setInvoiceAt: (v: string) => void;
  enabled: boolean;
}) {
  const { t } = useTranslation();
  const locations = useEntityOptions<StockLocationDto>('/inventory/locations', locationOption, { enabled });
  const suppliers = useEntityOptions<SupplierDto>('/inventory/suppliers', supplierOption, { enabled });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <PlainSelect id="rc-loc" label="Receive into" required value={locationId} onChange={setLocationId} options={locations.options} placeholder={locations.options.length ? 'Select…' : 'Add a location first'} />
      <PlainSelect id="rc-sup" label="Supplier" value={supplierId} onChange={setSupplierId} options={suppliers.options} allowEmpty="No supplier" />
      <Field label={t('Supplier invoice no.')} htmlFor="rc-inv">
        <Input id="rc-inv" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} maxLength={60} />
      </Field>
      <Field label={t('Invoice date')} htmlFor="rc-invd">
        <Input id="rc-invd" type="date" value={invoiceAt} onChange={(e) => setInvoiceAt(e.target.value)} />
      </Field>
    </div>
  );
}

/**
 * Receive stock: one goods receipt (supplier, location, invoice) for a pasted list of IMEIs. New IMEIs are registered
 * through the existing Device Inventory create path, never in a customer account (no licence seat).
 */
export function ReceiveDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const invalidate = useInvalidateInventory();
  const [locationId, setLocationId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceAt, setInvoiceAt] = useState('');
  const [modelId, setModelId] = useState('');
  const [imeiText, setImeiText] = useState('');
  const [cost, setCost] = useState('');
  const [warranty, setWarranty] = useState('');
  const [condition, setCondition] = useState('NEW');
  const [localError, setLocalError] = useState<string | null>(null);
  const models = useEntityOptions<DeviceModelDto>('/device-models', modelOption, { enabled: open });
  useEffect(() => {
    if (!open) return;
    setLocationId('');
    setSupplierId('');
    setInvoiceNo('');
    setInvoiceAt('');
    setModelId('');
    setImeiText('');
    setCost('');
    setWarranty('');
    setCondition('NEW');
    setLocalError(null);
  }, [open]);
  const parsed = useMemo(() => parseImeiList(imeiText), [imeiText]);
  const save = useMutation({
    mutationFn: (body: object) => api.post<{ receipt: StockReceiptDto; created: number; received: number }>('/inventory/receipts', body),
    onSuccess: (r) => {
      toast.success(t('Received {{n}} devices ({{created}} new IMEIs registered)', { n: r.received, created: r.created }));
      invalidate();
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Receive stock"
      description="Goods receipt from a supplier into a stock location. New IMEIs are registered in platform stock (no customer, no licence seat)."
      pending={save.isPending}
      error={localError ? new Error(localError) : save.error}
      submitLabel={parsed.imeis.length ? t('Receive {{n}} devices', { n: parsed.imeis.length }) : 'Receive'}
      wide
      onSubmit={(e) => {
        e.preventDefault();
        if (!locationId) return setLocalError(t('Choose the location to receive into'));
        if (!parsed.imeis.length) return setLocalError(t('Paste at least one IMEI'));
        if (parsed.invalid.length) return setLocalError(t('Fix invalid IMEIs: {{list}}', { list: parsed.invalid.slice(0, 5).join(', ') }));
        const paise = rupeesToPaise(cost);
        if (paise !== null && Number.isNaN(paise)) return setLocalError(t('Unit cost must be an amount in rupees'));
        setLocalError(null);
        save.mutate({
          locationId,
          supplierId: supplierId || undefined,
          supplierInvoiceNo: invoiceNo.trim() || undefined,
          supplierInvoiceAt: invoiceAt || undefined,
          items: parsed.imeis.map((uniqueId) => ({ uniqueId, modelId: modelId || undefined, unitCostPaise: paise ?? undefined, warrantyUntil: warranty || undefined, condition: condition || undefined })),
        });
      }}
    >
      <ReceiptHead {...{ locationId, setLocationId, supplierId, setSupplierId, invoiceNo, setInvoiceNo, invoiceAt, setInvoiceAt }} enabled={open} />
      <div className="grid gap-4 sm:grid-cols-4">
        <PlainSelect id="rc-model" label="Device model" value={modelId} onChange={setModelId} options={models.options} className="sm:col-span-2" hint="Required for IMEIs not yet registered." />
        <Field label={t('Unit cost (₹)')} htmlFor="rc-cost">
          <Input id="rc-cost" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="1499" />
        </Field>
        <PlainSelect id="rc-cond" label="Condition" value={condition} onChange={setCondition} options={CONDITION_OPTIONS} />
        <Field label={t('Warranty until')} htmlFor="rc-war" className="sm:col-span-2">
          <Input id="rc-war" type="date" value={warranty} onChange={(e) => setWarranty(e.target.value)} />
        </Field>
      </div>
      <Field label={t('IMEIs')} htmlFor="rc-imeis" required hint={t('One per line (or separated by commas / spaces). Up to 500 per receipt.')}>
        <Textarea id="rc-imeis" rows={6} value={imeiText} onChange={(e) => setImeiText(e.target.value)} className="font-mono text-xs" placeholder={'864000000000001\n864000000000002'} />
      </Field>
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge variant="info">{t('{{n}} IMEIs', { n: parsed.imeis.length })}</Badge>
        {parsed.duplicates.length > 0 && <Badge variant="warning">{t('{{n}} repeated (ignored)', { n: parsed.duplicates.length })}</Badge>}
        {parsed.invalid.length > 0 && <Badge variant="destructive">{t('{{n}} invalid', { n: parsed.invalid.length })}</Badge>}
      </div>
    </FormDialog>
  );
}

/** CSV import with a mandatory dry-run preview before anything is written. */
export function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const invalidate = useInvalidateInventory();
  const [locationId, setLocationId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceAt, setInvoiceAt] = useState('');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [report, setReport] = useState<StockImportReport | null>(null);
  useEffect(() => {
    if (!open) return;
    setLocationId('');
    setSupplierId('');
    setInvoiceNo('');
    setInvoiceAt('');
    setCsv('');
    setFileName('');
    setReport(null);
  }, [open]);
  // Any input change invalidates the preview: apply is only possible right after a clean dry run.
  useEffect(() => setReport(null), [csv, locationId, supplierId]);
  const body = (dryRun: boolean) => ({ csv, locationId, supplierId: supplierId || undefined, supplierInvoiceNo: invoiceNo.trim() || undefined, supplierInvoiceAt: invoiceAt || undefined, dryRun });
  const check = useMutation({
    mutationFn: () => api.post<StockImportReport>('/inventory/import', body(true)),
    onSuccess: setReport,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const apply = useMutation({
    mutationFn: () => api.post<StockImportReport>('/inventory/import', body(false)),
    onSuccess: (r) => {
      if (!r.applied) {
        setReport(r);
        toast.error(t('Nothing imported: fix the rows with errors first'));
        return;
      }
      toast.success(t('Imported {{n}} devices', { n: r.summary.rows }));
      invalidate();
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const clean = !!report && report.summary.errors === 0;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Import stock from CSV"
      description="Step 1 checks every row (dry run, nothing is saved). Step 2 imports the file as one goods receipt."
      pending={check.isPending || apply.isPending}
      error={check.error ?? apply.error}
      submitLabel={clean ? t('Import {{n}} devices', { n: report!.summary.rows }) : 'Check file (dry run)'}
      wide
      onSubmit={(e) => {
        e.preventDefault();
        if (!csv.trim() || !locationId) return toast.error(t('Choose a location and a CSV file'));
        if (clean) apply.mutate();
        else check.mutate();
      }}
    >
      <ReceiptHead {...{ locationId, setLocationId, supplierId, setSupplierId, invoiceNo, setInvoiceNo, invoiceAt, setInvoiceAt }} enabled={open} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" asChild>
          <label className="cursor-pointer">
            <FileUpIcon /> {fileName || t('Choose CSV file')}
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 100_000) return toast.error(t('The file is larger than 100 kB (max 500 rows)'));
                setFileName(f.name);
                setCsv(await f.text());
              }}
            />
          </label>
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => void downloadFile('/inventory/import/template', 'inventory-import-template.csv').catch((err) => toast.error(errorMessage(err)))}>
          <DownloadIcon /> {t('Template')}
        </Button>
        <span className="text-xs text-muted-foreground">{t('Columns: imei, model, serial, unit_cost, warranty_until, condition, sim, operator, note')}</span>
      </div>
      <Field label={t('Or paste CSV')} htmlFor="im-csv">
        <Textarea id="im-csv" rows={5} value={csv} onChange={(e) => setCsv(e.target.value)} className="font-mono text-xs" placeholder={'imei,model,serial,unit_cost\n864000000000001,Concox GT06N,SN-1,1499'} />
      </Field>
      {report && (
        <div className="space-y-2 rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {clean ? <CheckCircle2Icon className="size-4 text-success" /> : <XCircleIcon className="size-4 text-destructive" />}
            <span className="font-medium">{clean ? t('Ready to import') : t('Fix these rows, then check again')}</span>
            <Badge variant="info">{t('{{n}} new IMEIs', { n: report.summary.createDevice })}</Badge>
            <Badge variant="neutral">{t('{{n}} existing stock devices', { n: report.summary.addStock })}</Badge>
            {report.summary.errors > 0 && <Badge variant="destructive">{t('{{n}} errors', { n: report.summary.errors })}</Badge>}
          </div>
          <div className="max-h-56 overflow-auto rounded border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 font-medium">{t('Line')}</th>
                  <th className="px-2 py-1.5 font-medium">{t('IMEI')}</th>
                  <th className="px-2 py-1.5 font-medium">{t('Action')}</th>
                  <th className="px-2 py-1.5 font-medium">{t('Problems')}</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.line} className="border-t">
                    <td className="px-2 py-1 tabular-nums">{r.line}</td>
                    <td className="px-2 py-1 font-mono">{r.uniqueId ?? '—'}</td>
                    <td className="px-2 py-1">
                      <Badge variant={r.action === 'ERROR' ? 'destructive' : r.action === 'CREATE_DEVICE' ? 'info' : 'neutral'}>
                        {r.action === 'ERROR' ? t('Error') : r.action === 'CREATE_DEVICE' ? t('New IMEI') : t('Add to stock')}
                      </Badge>
                    </td>
                    <td className="px-2 py-1 text-destructive-fg">{r.errors.join('; ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </FormDialog>
  );
}
