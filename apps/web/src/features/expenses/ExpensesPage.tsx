import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EXPENSE_KIND_LABELS, EXPENSE_KINDS, formatInr, parseBillText, type ExpenseDto, type ExpenseKind, type ExpenseSummaryDto } from '@veetracer/shared';
import { FuelIcon, ImageIcon, PlusIcon, ScanTextIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Card } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/features/auth/auth-context';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, downloadFile, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

type Period = 'month' | 'lastMonth' | 'last3';
/** Whole days only: a `to` of "now" would change on every render, giving a new query key (endless refetch) and hiding entries saved later. */
const range = (p: Period) => {
  const now = new Date();
  const start = (y: number, m: number) => new Date(y, m, 1);
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, -1);
  if (p === 'month') return { from: start(now.getFullYear(), now.getMonth()), to: endOfToday };
  if (p === 'lastMonth') return { from: start(now.getFullYear(), now.getMonth() - 1), to: new Date(start(now.getFullYear(), now.getMonth()).getTime() - 1) };
  return { from: start(now.getFullYear(), now.getMonth() - 2), to: endOfToday };
};
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** Reads a bill photo in the browser (tesseract.js, free) and returns the amount / litres it found. */
async function readBill(file: File): Promise<{ amount: number | null; litres: number | null }> {
  const { recognize } = await import('tesseract.js');
  const { data } = await recognize(file, 'eng');
  return parseBillText(data.text);
}

function AddExpenseDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const vehicles = useEntityOptions<{ id: string; name: string }>('/objects', named);
  const [objectId, setObjectId] = useState<string | null>(null);
  const [kind, setKind] = useState<ExpenseKind>('FUEL');
  const [at, setAt] = useState(localInput(new Date()));
  const [amount, setAmount] = useState('');
  const [litres, setLitres] = useState('');
  const [fullTank, setFullTank] = useState(true);
  const [vendor, setVendor] = useState('');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [reading, setReading] = useState(false);
  const amountNum = Number(amount);
  const litresNum = Number(litres);
  const valid = !!objectId && amountNum > 0 && (kind !== 'FUEL' || litresNum > 0);
  const save = useMutation({
    mutationFn: async () => {
      const e = await api.post<ExpenseDto>('/expenses', { objectId, kind, at: new Date(at).toISOString(), amountPaise: Math.round(amountNum * 100), ...(kind === 'FUEL' ? { litres: litresNum, fullTank } : {}), vendor: vendor.trim() || null, note: note.trim() || null });
      if (photo) {
        const form = new FormData();
        form.append('file', photo);
        await api.upload<ExpenseDto>(`/expenses/${e.id}/photo`, form);
      }
      return e;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['expenses'] });
      toast.success(t('Expense saved'));
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const scan = async () => {
    if (!photo || photo.type === 'application/pdf') return;
    setReading(true);
    try {
      const r = await readBill(photo);
      if (r.amount) setAmount(String(r.amount));
      if (r.litres) setLitres(String(r.litres));
      toast[r.amount || r.litres ? 'success' : 'info'](r.amount || r.litres ? t('Read from the bill — please check') : t('Could not read the bill; please type the values'));
    } catch {
      toast.error(t('Could not read the bill; please type the values'));
    } finally {
      setReading(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Add expense')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Field label={t('Vehicle')} htmlFor="exp-vehicle">
            <Combobox id="exp-vehicle" value={objectId} onChange={setObjectId} options={vehicles.options} loading={vehicles.loading} placeholder={t('Choose a vehicle')} />
          </Field>
          <div className="flex gap-2">
            <Field label={t('Type')} htmlFor="exp-kind" className="flex-1">
              <Select value={kind} onValueChange={(v) => setKind(v as ExpenseKind)}>
                <SelectTrigger id="exp-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPENSE_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {t(EXPENSE_KIND_LABELS[k])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('Date & time')} htmlFor="exp-at" className="flex-1">
              <Input id="exp-at" type="datetime-local" value={at} max={localInput(new Date())} onChange={(e) => setAt(e.target.value)} />
            </Field>
          </div>
          <Field label={t('Bill photo (optional)')} htmlFor="exp-photo">
            <div className="flex items-center gap-2">
              <Input id="exp-photo" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
              {photo && photo.type !== 'application/pdf' && (
                <Button type="button" variant="outline" size="sm" onClick={() => void scan()} disabled={reading}>
                  {reading ? <Spinner /> : <ScanTextIcon />} {t('Read bill')}
                </Button>
              )}
            </div>
          </Field>
          <div className="flex gap-2">
            <Field label={t('Amount (₹)')} htmlFor="exp-amount" className="flex-1">
              <Input id="exp-amount" type="number" inputMode="decimal" min={1} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            {kind === 'FUEL' && (
              <Field label={t('Litres')} htmlFor="exp-litres" className="flex-1">
                <Input id="exp-litres" type="number" inputMode="decimal" min={0} step="0.01" value={litres} onChange={(e) => setLitres(e.target.value)} />
              </Field>
            )}
          </div>
          {kind === 'FUEL' && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={fullTank} onCheckedChange={(v) => setFullTank(v === true)} className="mt-0.5" />
              <span>
                {t('Tank filled full')}
                <span className="block text-xs text-muted-foreground">{t('Mileage is measured from one full tank to the next. Untick for a partial fill; its litres count in the next full fill-up.')}</span>
              </span>
            </label>
          )}
          <Field label={t('Fuel station / vendor (optional)')} htmlFor="exp-vendor">
            <Input id="exp-vendor" value={vendor} maxLength={120} onChange={(e) => setVendor(e.target.value)} />
          </Field>
          <Field label={t('Note (optional)')} htmlFor="exp-note">
            <Input id="exp-note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button onClick={() => save.mutate()} disabled={!valid || save.isPending}>
            {save.isPending && <Spinner />} {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Fuel & expenses: entries with bill photos, km per litre and cost per km per vehicle. */
export function ExpensesPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [period, setPeriod] = useState<Period>('month');
  const [adding, setAdding] = useState(false);
  const r = range(period);
  const from = r.from.toISOString();
  const to = r.to.toISOString();
  const summary = useQuery({ queryKey: ['expenses', 'summary', from, to], queryFn: ({ signal }) => api.get<ExpenseSummaryDto>('/expenses/summary', { from, to }, signal) });
  const list = useQuery({ queryKey: ['expenses', 'list', from, to], queryFn: ({ signal }) => api.get<ExpenseDto[]>('/expenses', { from, to }, signal) });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/expenses/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['expenses'] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const s = summary.data;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader
        title={t('Fuel & expenses')}
        description={t('Log fill-ups and costs with a bill photo; see real km per litre and cost per km for each vehicle.')}
        actions={
          <div className="flex gap-2">
            <Select value={period} onValueChange={(v) => setPeriod(v as Period)}>
              <SelectTrigger className="w-40" aria-label={t('Period')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="month">{t('This month')}</SelectItem>
                <SelectItem value="lastMonth">{t('Last month')}</SelectItem>
                <SelectItem value="last3">{t('Last 3 months')}</SelectItem>
              </SelectContent>
            </Select>
            {can('expenses', 'create') && (
              <Button onClick={() => setAdding(true)}>
                <PlusIcon /> {t('Add expense')}
              </Button>
            )}
          </div>
        }
      />
      <div className="grid gap-3 sm:grid-cols-4">
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">{t('Total spent')}</div>
          <div className="mt-1 text-2xl font-bold tabular-nums">{s ? formatInr(s.totalPaise) : '—'}</div>
        </Card>
        {(['FUEL', 'SERVICE', 'TOLL'] as ExpenseKind[]).map((k) => (
          <Card key={k} className="p-4">
            <div className="text-xs text-muted-foreground">{t(EXPENSE_KIND_LABELS[k])}</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{s ? formatInr(s.byKind[k]) : '—'}</div>
          </Card>
        ))}
      </div>
      <Card className="overflow-hidden p-0">
        <div className="border-b px-4 py-2 text-sm font-semibold">{t('Per vehicle')}</div>
        {summary.isPending ? (
          <Skeleton className="m-4 h-24" />
        ) : !s?.vehicles.length ? (
          <EmptyState icon={FuelIcon} title={t('No expenses in this period')} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Vehicle')}</TableHead>
                <TableHead className="text-right">{t('Distance')}</TableHead>
                <TableHead className="text-right">{t('Litres')}</TableHead>
                <TableHead className="text-right">{t('km / L')}</TableHead>
                <TableHead className="text-right">{t('Fuel')}</TableHead>
                <TableHead className="text-right">{t('Other')}</TableHead>
                <TableHead className="text-right">{t('Cost / km')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.vehicles.map((v) => (
                <TableRow key={v.objectId}>
                  <TableCell className="font-medium">{v.objectName}</TableCell>
                  <TableCell className="text-right tabular-nums">{`${v.km} km`}</TableCell>
                  <TableCell className="text-right tabular-nums">{v.fuelLitres || '—'}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums" title={v.kmPerLitre === null ? t('Needs two full-tank fill-ups') : t('From {{count}} full-tank runs', { count: v.fullTankRuns })}>
                    {v.kmPerLitre ?? <span className="text-xs font-normal text-muted-foreground">{t('Needs 2 full fills')}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatInr(v.fuelPaise)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInr(v.otherPaise)}</TableCell>
                  <TableCell className="text-right tabular-nums">{v.costPerKmPaise !== null ? formatInr(v.costPerKmPaise) : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      <Card className="overflow-hidden p-0">
        <div className="border-b px-4 py-2 text-sm font-semibold">{t('Entries')}</div>
        {list.isPending ? (
          <Skeleton className="m-4 h-24" />
        ) : !list.data?.length ? (
          <EmptyState icon={FuelIcon} title={t('No entries yet')} description={t('Add fill-ups and other costs with "Add expense".')} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Date')}</TableHead>
                <TableHead>{t('Vehicle')}</TableHead>
                <TableHead>{t('Type')}</TableHead>
                <TableHead className="text-right">{t('Amount')}</TableHead>
                <TableHead className="text-right">{t('Litres')}</TableHead>
                <TableHead className="hidden text-right md:table-cell">{t('Odometer')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('Vendor')}</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="tabular-nums">{formatDateTime(e.at)}</TableCell>
                  <TableCell>{e.objectName}</TableCell>
                  <TableCell>{t(EXPENSE_KIND_LABELS[e.kind])}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInr(e.amountPaise)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {e.litres ?? '—'}
                    {e.kind === 'FUEL' && !e.fullTank && <span className="ml-1 text-xs text-muted-foreground">({t('partial')})</span>}
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">{e.odometerKm !== null ? `${Math.round(e.odometerKm)} km` : '—'}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{e.vendor ?? '—'}</TableCell>
                  <TableCell className="text-right">
                    {e.hasPhoto && (
                      <Button variant="ghost" size="icon-sm" onClick={() => void downloadFile(`/expenses/${e.id}/photo`, 'bill').catch((err) => toast.error(errorMessage(err)))} aria-label={t('Bill photo')} title={t('Bill photo')}>
                        <ImageIcon />
                      </Button>
                    )}
                    {can('expenses', 'delete') && (
                      <Button variant="ghost" size="icon-sm" onClick={() => remove.mutate(e.id)} aria-label={t('Delete')}>
                        <Trash2Icon />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      {adding && <AddExpenseDialog onClose={() => setAdding(false)} />}
    </div>
  );
}
