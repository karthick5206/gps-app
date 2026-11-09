import { useMutation, useQuery } from '@tanstack/react-query';
import { INDIAN_STATES, STOCK_ITEM_KINDS, type StockItemDto, type StockItemKind, type StockPriceDto, type StockSupplierDto } from '@veetracer/shared';
import { PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, errorMessage } from '@/lib/api';
import { rupees, toPaise, toRupeesText, usePartners, useStockItems, useStockRefresh, useSuppliers } from './stock-api';

/** Platform setup: items (prices, HSN, GST, reorder level), special prices for resellers / customers, suppliers. */
const KIND_LABEL: Record<StockItemKind, string> = { DEVICE: 'Tracker', SIM: 'SIM card', ACCESSORY: 'Accessory' };
const NONE = '__none';

export function SetupTab() {
  const { t } = useTranslation();
  const items = useStockItems();
  const suppliers = useSuppliers();
  const refresh = useStockRefresh();
  const [item, setItem] = useState<Partial<StockItemDto> | null>(null);
  const [supplier, setSupplier] = useState<Partial<StockSupplierDto> | null>(null);
  const [prices, setPrices] = useState<StockItemDto | null>(null);
  const reorderAll = useMutation({
    mutationFn: (b: { lowStockAt: number | null; reorderQty: number | null }) => api.put('/stock/items/reorder-level', { kind: 'DEVICE', ...b }),
    onSuccess: () => {
      toast.success(t('Reorder level set for all trackers'));
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="space-y-4">
      <Card className="gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[15px] font-bold">{t('Items')}</h3>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => {
                const level = prompt(t('Reorder level for every tracker (leave empty to clear)'), '10');
                if (level === null) return;
                const qty = prompt(t('Usual order quantity (optional)'), '');
                reorderAll.mutate({ lowStockAt: level.trim() ? Number(level) : null, reorderQty: qty?.trim() ? Number(qty) : null });
              }}
            >
              {t('Same reorder level for all trackers')}
            </Button>
            <Button onClick={() => setItem({ kind: 'DEVICE', unit: 'pcs', gstRatePct: 18, hsnCode: '8526', serialTracked: true, isActive: true, salePricePaise: 0, purchasePricePaise: 0 })}>
              <PlusIcon /> {t('Add item')}
            </Button>
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Item')}</TableHead>
              <TableHead>{t('Type')}</TableHead>
              <TableHead className="text-end">{t('Buy price')}</TableHead>
              <TableHead className="text-end">{t('Sell price')}</TableHead>
              <TableHead className="text-end">{t('In stock')}</TableHead>
              <TableHead className="text-end">{t('Reorder level')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(items.data ?? []).map((i) => (
              <TableRow key={i.id} className={i.isActive ? '' : 'opacity-50'}>
                <TableCell className="font-medium">
                  {i.name} {i.deviceModelName && <span className="text-xs text-muted-foreground">({i.deviceModelName})</span>}
                </TableCell>
                <TableCell>{t(KIND_LABEL[i.kind])}</TableCell>
                <TableCell className="text-end tabular-nums">{rupees(i.purchasePricePaise)}</TableCell>
                <TableCell className="text-end tabular-nums">{rupees(i.salePricePaise)}</TableCell>
                <TableCell className="text-end tabular-nums">
                  {i.onHand} {i.lowStockAt !== null && i.onHand <= i.lowStockAt && <Badge variant="warning">{t('Low')}</Badge>}
                </TableCell>
                <TableCell className="text-end tabular-nums">{i.lowStockAt ?? '—'}</TableCell>
                <TableCell className="text-end whitespace-nowrap">
                  <Button size="sm" variant="ghost" onClick={() => setPrices(i)}>
                    {t('Special prices')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setItem(i)}>
                    {t('Edit')}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Card className="gap-3 p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-[15px] font-bold">{t('Suppliers')}</h3>
          <Button onClick={() => setSupplier({ isActive: true, leadTimeDays: 7, stateCode: '', name: '' })}>
            <PlusIcon /> {t('Add supplier')}
          </Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Supplier')}</TableHead>
              <TableHead>{t('Contact')}</TableHead>
              <TableHead>{t('GSTIN')}</TableHead>
              <TableHead className="text-end">{t('Lead time')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(suppliers.data ?? []).map((s) => (
              <TableRow key={s.id} className={s.isActive ? '' : 'opacity-50'}>
                <TableCell className="font-medium">{s.name}</TableCell>
                <TableCell>{[s.contactName, s.phone, s.email].filter(Boolean).join(' · ')}</TableCell>
                <TableCell>{s.gstin ?? '—'}</TableCell>
                <TableCell className="text-end tabular-nums">{t('{{n}} days', { n: s.leadTimeDays })}</TableCell>
                <TableCell className="text-end">
                  <Button size="sm" variant="ghost" onClick={() => setSupplier(s)}>
                    {t('Edit')}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {item && <ItemDialog item={item} onClose={() => setItem(null)} />}
      {supplier && <SupplierDialog supplier={supplier} onClose={() => setSupplier(null)} />}
      {prices && <PricesDialog item={prices} onClose={() => setPrices(null)} />}
    </div>
  );
}

function ItemDialog({ item, onClose }: { item: Partial<StockItemDto>; onClose: () => void }) {
  const { t } = useTranslation();
  const refresh = useStockRefresh();
  const models = useEntityOptions<{ id: string; brand: string; model: string }>('/device-models', (m) => ({ value: m.id, label: `${m.brand} ${m.model}` }));
  const [f, setF] = useState({ ...item, buy: toRupeesText(item.purchasePricePaise ?? 0), sell: toRupeesText(item.salePricePaise ?? 0) });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.name ?? '', kind: f.kind ?? 'DEVICE', deviceModelId: f.kind === 'DEVICE' ? (f.deviceModelId ?? null) : null, sku: f.sku ?? null, hsnCode: f.hsnCode ?? '', gstRatePct: Number(f.gstRatePct ?? 18), unit: f.unit ?? 'pcs', serialTracked: f.kind === 'ACCESSORY' ? !!f.serialTracked : true, salePricePaise: toPaise(f.sell), purchasePricePaise: toPaise(f.buy), lowStockAt: f.lowStockAt ?? null, reorderQty: f.reorderQty ?? null, isActive: f.isActive ?? true };
      return item.id ? api.put(`/stock/items/${item.id}`, body) : api.post('/stock/items', body);
    },
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const num = (v: string) => (v.trim() === '' ? null : Math.max(0, Math.round(Number(v)) || 0));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{item.id ? t('Edit item') : t('Add item')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="grid gap-3 sm:grid-cols-2">
          <Field label={t('Name')} htmlFor="it-n" required className="sm:col-span-2">
            <Input id="it-n" value={f.name ?? ''} onChange={(e) => set({ name: e.target.value })} placeholder={t('e.g. Concox GT06N tracker')} />
          </Field>
          <Field label={t('Type')} htmlFor="it-k">
            <Select value={f.kind ?? 'DEVICE'} onValueChange={(v) => set({ kind: v as StockItemKind })}>
              <SelectTrigger id="it-k">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STOCK_ITEM_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(KIND_LABEL[k])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {f.kind === 'DEVICE' ? (
            <Field label={t('Tracker model')} htmlFor="it-m" hint={t('Received trackers appear in Device Inventory with this model.')}>
              <Select value={f.deviceModelId ?? NONE} onValueChange={(v) => set({ deviceModelId: v === NONE ? null : v })}>
                <SelectTrigger id="it-m">
                  <SelectValue placeholder={t('Choose…')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('Choose…')}</SelectItem>
                  {models.options.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : f.kind === 'ACCESSORY' ? (
            <Field label={t('Track by serial number')} htmlFor="it-s">
              <Switch id="it-s" checked={!!f.serialTracked} onCheckedChange={(v) => set({ serialTracked: v })} />
            </Field>
          ) : (
            <p className="self-end pb-2 text-xs text-muted-foreground">{t('SIM cards are tracked by their number.')}</p>
          )}
          <Field label={t('Buying price (₹, incl. GST)')} htmlFor="it-b">
            <Input id="it-b" inputMode="decimal" value={f.buy} onChange={(e) => set({ buy: e.target.value })} />
          </Field>
          <Field label={t('Selling price (₹, incl. GST)')} htmlFor="it-sp">
            <Input id="it-sp" inputMode="decimal" value={f.sell} onChange={(e) => set({ sell: e.target.value })} />
          </Field>
          <Field label={t('HSN code')} htmlFor="it-h">
            <Input id="it-h" value={f.hsnCode ?? ''} onChange={(e) => set({ hsnCode: e.target.value })} />
          </Field>
          <Field label={t('GST %')} htmlFor="it-g">
            <Input id="it-g" type="number" value={f.gstRatePct ?? 18} onChange={(e) => set({ gstRatePct: Number(e.target.value) })} />
          </Field>
          <Field label={t('Reorder level')} htmlFor="it-r" hint={t('Shows as low stock at or below this.')}>
            <Input id="it-r" type="number" value={f.lowStockAt ?? ''} onChange={(e) => set({ lowStockAt: num(e.target.value) })} />
          </Field>
          <Field label={t('Usual order quantity')} htmlFor="it-q">
            <Input id="it-q" type="number" value={f.reorderQty ?? ''} onChange={(e) => set({ reorderQty: num(e.target.value) })} />
          </Field>
          <Field label={t('Unit')} htmlFor="it-u">
            <Input id="it-u" value={f.unit ?? 'pcs'} onChange={(e) => set({ unit: e.target.value })} />
          </Field>
          <Field label={t('Active')} htmlFor="it-a">
            <Switch id="it-a" checked={f.isActive ?? true} onCheckedChange={(v) => set({ isActive: v })} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SupplierDialog({ supplier, onClose }: { supplier: Partial<StockSupplierDto>; onClose: () => void }) {
  const { t } = useTranslation();
  const refresh = useStockRefresh();
  const [f, setF] = useState(supplier);
  const set = (p: Partial<StockSupplierDto>) => setF((x) => ({ ...x, ...p }));
  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.name ?? '', gstin: f.gstin ?? null, stateCode: f.stateCode ?? '', address: f.address ?? '', city: f.city ?? '', pin: f.pin ?? '', contactName: f.contactName ?? '', phone: f.phone ?? '', email: f.email ?? '', notes: f.notes ?? '', leadTimeDays: Number(f.leadTimeDays ?? 7), isActive: f.isActive ?? true };
      return supplier.id ? api.put(`/stock/suppliers/${supplier.id}`, body) : api.post('/stock/suppliers', body);
    },
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const text = (k: keyof StockSupplierDto, label: string, extra?: { type?: string; className?: string }) => (
    <Field label={t(label)} htmlFor={`sp-${k}`} className={extra?.className}>
      <Input id={`sp-${k}`} type={extra?.type} value={String(f[k] ?? '')} onChange={(e) => set({ [k]: e.target.value } as Partial<StockSupplierDto>)} />
    </Field>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{supplier.id ? t('Edit supplier') : t('Add supplier')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="grid gap-3 sm:grid-cols-2">
          {text('name', 'Name', { className: 'sm:col-span-2' })}
          {text('contactName', 'Contact person')}
          {text('phone', 'Phone')}
          {text('email', 'Email', { type: 'email' })}
          {text('gstin', 'GSTIN')}
          {text('address', 'Address', { className: 'sm:col-span-2' })}
          {text('city', 'City')}
          {text('pin', 'PIN code')}
          <Field label={t('State')} htmlFor="sp-st">
            <Select value={f.stateCode || NONE} onValueChange={(v) => set({ stateCode: v === NONE ? '' : v })}>
              <SelectTrigger id="sp-st">
                <SelectValue placeholder={t('Choose…')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t('Choose…')}</SelectItem>
                {INDIAN_STATES.map((s) => (
                  <SelectItem key={s.code} value={s.code}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('Lead time (days)')} htmlFor="sp-lt" hint={t('Order to delivery; used for expected arrival.')}>
            <Input id="sp-lt" type="number" value={f.leadTimeDays ?? 7} onChange={(e) => set({ leadTimeDays: Number(e.target.value) })} />
          </Field>
          <Field label={t('Notes')} htmlFor="sp-no" className="sm:col-span-2">
            <Textarea id="sp-no" rows={2} value={f.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
          </Field>
          <Field label={t('Active')} htmlFor="sp-a">
            <Switch id="sp-a" checked={f.isActive ?? true} onCheckedChange={(v) => set({ isActive: v })} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Special selling prices of one item for chosen resellers or customer companies (else the item's price). */
function PricesDialog({ item, onClose }: { item: StockItemDto; onClose: () => void }) {
  const { t } = useTranslation();
  const list = useQuery({ queryKey: ['stock', 'prices', item.id], queryFn: ({ signal }) => api.get<StockPriceDto[]>(`/stock/items/${item.id}/prices`, undefined, signal) });
  const partners = usePartners(true);
  const companies = useEntityOptions<{ id: string; name: string }>('/admin/companies', named);
  const [who, setWho] = useState('');
  const [price, setPrice] = useState('');
  const set = useMutation({
    mutationFn: (b: { partnerId?: string; companyId?: string; pricePaise: number | null }) => api.put<StockPriceDto[]>('/stock/prices', { itemId: item.id, ...b }),
    onSuccess: () => {
      void list.refetch();
      setPrice('');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('Special prices: {{item}}', { item: item.name })}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('Everyone else pays {{p}}.', { p: rupees(item.salePricePaise) })}</p>
          {(list.data ?? []).map((p) => (
            <div key={p.id} className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm">
              <span>{p.forName}</span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums">{rupees(p.pricePaise)}</span>
                <Button size="sm" variant="ghost" onClick={() => set.mutate({ partnerId: p.partnerId ?? undefined, companyId: p.companyId ?? undefined, pricePaise: null })}>
                  {t('Remove')}
                </Button>
              </span>
            </div>
          ))}
          <div className="grid gap-2 sm:grid-cols-[1fr_140px_auto] sm:items-end">
            <Field label={t('For')} htmlFor="pr-w">
              <Select value={who || NONE} onValueChange={(v) => setWho(v === NONE ? '' : v)}>
                <SelectTrigger id="pr-w">
                  <SelectValue placeholder={t('Choose…')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('Choose…')}</SelectItem>
                  {(partners.data ?? []).map((p) => (
                    <SelectItem key={`p:${p.id}`} value={`p:${p.id}`}>
                      {t('Reseller')}: {p.name}
                    </SelectItem>
                  ))}
                  {companies.options.map((o) => (
                    <SelectItem key={`c:${o.value}`} value={`c:${o.value}`}>
                      {t('Customer')}: {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('Price (₹, incl. GST)')} htmlFor="pr-p">
              <Input id="pr-p" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
            </Field>
            <Button disabled={!who || !price || set.isPending} onClick={() => set.mutate({ [who.startsWith('p:') ? 'partnerId' : 'companyId']: who.slice(2), pricePaise: toPaise(price) })}>
              {t('Set')}
            </Button>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
