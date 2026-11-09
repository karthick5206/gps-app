import { useMutation, useQuery } from '@tanstack/react-query';
import { INDIAN_STATES, STOCK_DOC_LABEL, STOCK_ORDER_CHANNELS, type StockDocDto, type StockDocInput, type StockDocKind, type StockDocLineDto, type StockSaleTo } from '@veetracer/shared';
import { DownloadIcon, FileTextIcon, PaperclipIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, errorMessage, fetchBlob } from '@/lib/api';
import { rupees, STATUS_LABEL, STATUS_TONE, today, toPaise, toRupeesText, usePartners, useStockItems, useStockLocations, useStockRefresh, useStockSide, useSuppliers } from './stock-api';

/*
 * One form for every stock step. What it shows depends on the kind: purchase order (supplier, items, quantities),
 * goods received (supplier invoice, IMEIs, damaged units, the invoice file), return to supplier, customer order
 * (how it came in), sale (customer / reseller / own use, IMEIs picked from the store, invoice), customer return
 * (credit note) and adjustment. "Save as draft" changes no stock; the main button completes it and updates stock.
 * Completed documents stay editable: stock is corrected automatically.
 */

const NONE = '__none';
const OUT_KINDS: StockDocKind[] = ['SALE', 'PURCHASE_RETURN'];

interface Line extends StockDocLineDto {
  key: string;
  rateText: string;
  serialText: string;
}

const newKey = () => Math.random().toString(36).slice(2);
const toLine = (l: StockDocLineDto): Line => ({ ...l, key: newKey(), rateText: toRupeesText(l.ratePaise), serialText: l.serials.join('\n') });
const parseSerials = (text: string) => [...new Set(text.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];

export interface EditorTarget {
  kind: StockDocKind;
  id?: string | null;
  /** New document pre-filled from another (receive a PO, sell an order, return a sale…). */
  prefill?: Partial<StockDocInput>;
}

export function DocEditor({ target, onClose, onOpen }: { target: EditorTarget | null; onClose: () => void; onOpen: (t: EditorTarget) => void }) {
  const { t } = useTranslation();
  const { platform, reseller } = useStockSide();
  const refresh = useStockRefresh();
  const items = useStockItems();
  const locations = useStockLocations();
  const suppliers = useSuppliers(platform);
  const partners = usePartners(platform);
  const companies = useEntityOptions<{ id: string; name: string }>('/admin/companies', named, { enabled: platform });
  const existing = useQuery({ queryKey: ['stock', 'doc', target?.id], queryFn: ({ signal }) => api.get<StockDocDto>(`/stock/docs/${target!.id}`, undefined, signal), enabled: !!target?.id });
  const doc = existing.data;
  const kind = (doc?.kind ?? target?.kind ?? 'PO') as StockDocKind;

  const [f, setF] = useState<StockDocInput>(() => blank(kind));
  const [lines, setLines] = useState<Line[]>([]);
  useEffect(() => {
    if (!target) return;
    if (target.id && !doc) return;
    const base: StockDocInput = doc ? { ...doc, status: doc.status as StockDocInput['status'], lines: doc.lines } : { ...blank(kind), ...target.prefill };
    setF(base);
    setLines((base.lines ?? []).map(toLine));
  }, [target, doc, kind]);
  const set = (patch: Partial<StockDocInput>) => setF((x) => ({ ...x, ...patch }));
  const itemBy = useMemo(() => new Map((items.data ?? []).map((i) => [i.id, i])), [items.data]);
  const plan = kind === 'PO' || kind === 'ORDER';
  const done = doc?.status === 'DONE';
  const locked = doc?.status === 'CANCELLED' || (!!doc?.invoice && (kind === 'SALE' || kind === 'SALES_RETURN'));

  const save = useMutation({
    mutationFn: (status: StockDocInput['status']) => {
      const body: StockDocInput = {
        ...f,
        kind,
        status,
        lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qty, ratePaise: toPaise(l.rateText), gstRatePct: l.gstRatePct, serials: itemBy.get(l.itemId)?.serialTracked && !plan ? parseSerials(l.serialText) : [], condition: l.condition, note: l.note })),
      };
      return doc ? api.put<StockDocDto>(`/stock/docs/${doc.id}`, body) : api.post<StockDocDto>('/stock/docs', body);
    },
    onSuccess: (d) => {
      toast.success(t('{{number}} saved', { number: d.number }));
      refresh();
      onOpen({ kind: d.kind, id: d.id });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => refresh(),
    onError: (e) => toast.error(errorMessage(e)),
  });

  // Price for the buyer when an item is chosen on an order / sale; buying price on purchases.
  const priceFor = async (itemId: string): Promise<number> => {
    const item = itemBy.get(itemId);
    if (!item) return 0;
    if (kind === 'PO' || kind === 'RECEIPT' || kind === 'PURCHASE_RETURN') return item.purchasePricePaise;
    try {
      const r = await api.get<{ pricePaise: number }>('/stock/price', { itemId, partnerId: f.customerPartnerId ?? undefined, companyId: f.customerCompanyId ?? undefined });
      return r.pricePaise;
    } catch {
      return item.salePricePaise;
    }
  };
  const addLine = () => setLines((ls) => [...ls, { key: newKey(), itemId: '', qty: 1, ratePaise: 0, rateText: '', gstRatePct: 18, serials: [], serialText: '', condition: 'OK', note: '' }]);
  const setLine = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const chooseItem = async (key: string, itemId: string) => {
    const item = itemBy.get(itemId);
    const p = await priceFor(itemId);
    setLine(key, { itemId, gstRatePct: item?.gstRatePct ?? 18, rateText: toRupeesText(p) });
  };

  const total = lines.reduce((s, l) => s + toPaise(l.rateText) * Math.abs(itemBy.get(l.itemId)?.serialTracked && !plan ? parseSerials(l.serialText).length : l.qty), 0);
  const stores = (locations.data ?? []).filter((l) => (kind === 'PURCHASE_RETURN' ? true : l.kind !== 'DAMAGED'));
  const title = doc ? `${t(STOCK_DOC_LABEL[kind])} ${doc.number}` : t('New: {{kind}}', { kind: t(STOCK_DOC_LABEL[kind]) });

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {title}
            {doc && <Badge variant={STATUS_TONE[doc.status]}>{t(STATUS_LABEL[doc.status])}</Badge>}
            {doc?.sourceNumber && <span className="text-sm font-normal text-muted-foreground">{t('from {{number}}', { number: doc.sourceNumber })}</span>}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4 overflow-y-auto">
          {target?.id && !doc ? (
            <Spinner />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label={t('Date')} htmlFor="sd-date">
                  <Input id="sd-date" type="date" value={f.docDate} onChange={(e) => set({ docDate: e.target.value })} disabled={locked} />
                </Field>

                {(kind === 'PO' || kind === 'RECEIPT' || kind === 'PURCHASE_RETURN') && (
                  <Field label={t('Supplier')} htmlFor="sd-sup">
                    {platform ? (
                      <Select value={f.supplierId ?? NONE} onValueChange={(v) => set({ supplierId: v === NONE ? null : v })} disabled={locked}>
                        <SelectTrigger id="sd-sup">
                          <SelectValue placeholder={t('Choose…')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>{t('Choose…')}</SelectItem>
                          {(suppliers.data ?? []).filter((s) => s.isActive || s.id === f.supplierId).map((s) => (
                            <SelectItem key={s.id} value={s.id}>
                              {s.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input id="sd-sup" value={kind === 'PO' ? t('VeeTrax (platform)') : (doc?.supplierName ?? 'VeeTrax')} disabled />
                    )}
                  </Field>
                )}

                {kind === 'SALE' && (
                  <Field label={t('Sell to')} htmlFor="sd-to">
                    <Select value={f.saleTo ?? 'CUSTOMER'} onValueChange={(v) => set({ saleTo: v as StockSaleTo })} disabled={locked}>
                      <SelectTrigger id="sd-to">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="CUSTOMER">{t('Customer')}</SelectItem>
                        {platform && <SelectItem value="PARTNER">{t('Reseller (moves to their store)')}</SelectItem>}
                        <SelectItem value="OWN">{t('Own use')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                )}

                {!plan && (platform ? (
                  <Field label={kind === 'RECEIPT' || kind === 'SALES_RETURN' ? t('Into store') : kind === 'ADJUSTMENT' ? t('Store') : t('From store')} htmlFor="sd-loc">
                    <Select value={f.locationId ?? NONE} onValueChange={(v) => set({ locationId: v === NONE ? null : v })} disabled={locked}>
                      <SelectTrigger id="sd-loc">
                        <SelectValue placeholder={t('Main store')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>{kind === 'PURCHASE_RETURN' ? t('Damaged shelf') : t('Main store')}</SelectItem>
                        {stores.map((l) => (
                          <SelectItem key={l.id} value={l.id}>
                            {l.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                ) : null)}

                {kind === 'ORDER' && (
                  <Field label={t('Order came by')} htmlFor="sd-ch">
                    <Select value={f.channel ?? 'CALL'} onValueChange={(v) => set({ channel: v as StockDocInput['channel'] })} disabled={locked}>
                      <SelectTrigger id="sd-ch">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STOCK_ORDER_CHANNELS.map((c) => (
                          <SelectItem key={c} value={c}>
                            {t({ CALL: 'Phone call', WHATSAPP: 'WhatsApp', EMAIL: 'Email', VISIT: 'Visit', PORTAL: 'Reseller portal' }[c])}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              </div>

              {/* Customer: a company on VeeTrax (its trackers get assigned to it), a reseller, or anyone by name. */}
              {(kind === 'ORDER' || (kind === 'SALE' && f.saleTo !== 'OWN') || kind === 'SALES_RETURN') && (
                <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-4">
                  {f.saleTo === 'PARTNER' || (kind === 'ORDER' && platform && f.customerPartnerId) ? (
                    <Field label={t('Reseller')} htmlFor="sd-rs">
                      <Select value={f.customerPartnerId ?? NONE} onValueChange={(v) => set({ customerPartnerId: v === NONE ? null : v })} disabled={locked}>
                        <SelectTrigger id="sd-rs">
                          <SelectValue placeholder={t('Choose…')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>{t('Choose…')}</SelectItem>
                          {(partners.data ?? []).map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  ) : (
                    platform && (
                      <Field label={t('Customer company on VeeTrax')} htmlFor="sd-co" hint={t('Optional: its trackers are assigned to it.')}>
                        <Select value={f.customerCompanyId ?? NONE} onValueChange={(v) => set({ customerCompanyId: v === NONE ? null : v, customerName: f.customerName || (companies.options.find((o) => o.value === v)?.label ?? '') })} disabled={locked}>
                          <SelectTrigger id="sd-co">
                            <SelectValue placeholder={t('Not on VeeTrax')} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>{t('Not on VeeTrax')}</SelectItem>
                            {companies.options.map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                    )
                  )}
                  <Field label={t('Customer name')} htmlFor="sd-cn">
                    <Input id="sd-cn" value={f.customerName ?? ''} onChange={(e) => set({ customerName: e.target.value })} disabled={locked} />
                  </Field>
                  <Field label={t('Phone')} htmlFor="sd-cp">
                    <Input id="sd-cp" value={f.customerPhone ?? ''} onChange={(e) => set({ customerPhone: e.target.value })} disabled={locked} />
                  </Field>
                  <Field label={t('Email')} htmlFor="sd-ce">
                    <Input id="sd-ce" type="email" value={f.customerEmail ?? ''} onChange={(e) => set({ customerEmail: e.target.value })} disabled={locked} />
                  </Field>
                  {kind !== 'ORDER' && (
                    <>
                      <Field label={t('GSTIN')} htmlFor="sd-cg">
                        <Input id="sd-cg" value={f.customerGstin ?? ''} onChange={(e) => set({ customerGstin: e.target.value })} disabled={locked} />
                      </Field>
                      <Field label={t('State')} htmlFor="sd-cs" hint={t('Decides CGST + SGST or IGST on the invoice.')}>
                        <Select value={f.customerStateCode || NONE} onValueChange={(v) => set({ customerStateCode: v === NONE ? '' : v })} disabled={locked}>
                          <SelectTrigger id="sd-cs">
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
                      <Field label={t('Address')} htmlFor="sd-ca" className="sm:col-span-2">
                        <Input id="sd-ca" value={f.customerAddress ?? ''} onChange={(e) => set({ customerAddress: e.target.value })} disabled={locked} />
                      </Field>
                    </>
                  )}
                </div>
              )}

              {kind === 'RECEIPT' && (
                <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-3">
                  <Field label={t("Supplier's invoice no.")} htmlFor="sd-si">
                    <Input id="sd-si" value={f.supplierInvoiceNo ?? ''} onChange={(e) => set({ supplierInvoiceNo: e.target.value })} />
                  </Field>
                  <Field label={t('Invoice date')} htmlFor="sd-sid">
                    <Input id="sd-sid" type="date" value={f.supplierInvoiceDate ?? ''} onChange={(e) => set({ supplierInvoiceDate: e.target.value || null })} />
                  </Field>
                  <Field label={t('Invoice amount (₹)')} htmlFor="sd-sia">
                    <Input id="sd-sia" inputMode="decimal" value={toRupeesText(f.supplierInvoiceAmountPaise ?? 0)} onChange={(e) => set({ supplierInvoiceAmountPaise: toPaise(e.target.value) || null })} />
                  </Field>
                </div>
              )}

              {/* Items */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">{t('Items')}</h3>
                  {!locked && (
                    <Button size="sm" variant="outline" onClick={addLine}>
                      <PlusIcon /> {t('Add item')}
                    </Button>
                  )}
                </div>
                {lines.length === 0 && <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">{t('No items yet.')}</p>}
                {lines.map((l) => (
                  <LineRow key={l.key} kind={kind} line={l} locked={locked} items={items.data ?? []} onItem={(id) => void chooseItem(l.key, id)} onChange={(p) => setLine(l.key, p)} onRemove={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} storeId={f.locationId ?? null} plan={plan} />
                ))}
                <p className="text-end text-sm">
                  {t('Total (GST inclusive)')}: <span className="font-semibold tabular-nums">{rupees(total)}</span>
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {(kind === 'PURCHASE_RETURN' || kind === 'SALES_RETURN' || kind === 'ADJUSTMENT') && (
                  <Field label={t('Reason')} htmlFor="sd-rs2">
                    <Input id="sd-rs2" value={f.reason ?? ''} onChange={(e) => set({ reason: e.target.value })} placeholder={kind === 'ADJUSTMENT' ? t('Count correction, lost, scrapped…') : t('Damaged, not working…')} disabled={locked} />
                  </Field>
                )}
                <Field label={t('Notes')} htmlFor="sd-notes">
                  <Textarea id="sd-notes" rows={2} value={f.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} disabled={locked} />
                </Field>
              </div>

              {doc && <DocExtras doc={doc} platform={platform} act={(fn) => act.mutate(fn)} onOpen={onOpen} reseller={!!reseller} />}
            </>
          )}
        </DialogBody>
        <DialogFooter className="flex-wrap">
          {doc && doc.status !== 'CANCELLED' && !doc.invoice && (
            <Button variant="outline" className="me-auto text-destructive" disabled={save.isPending} onClick={() => confirm(t('Cancel {{number}}? Stock it moved is put back.', { number: doc.number })) && save.mutate('CANCELLED')}>
              {t('Cancel document')}
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            {t('Close')}
          </Button>
          {!locked && (!doc || doc.status === 'DRAFT') && (
            <Button variant="outline" disabled={save.isPending} onClick={() => save.mutate('DRAFT')}>
              {t('Save as draft')}
            </Button>
          )}
          {!locked && (
            <Button disabled={save.isPending || !lines.length} onClick={() => save.mutate(plan ? 'OPEN' : 'DONE')}>
              {save.isPending && <Spinner />} {done || doc?.status === 'OPEN' || doc?.status === 'PARTIAL' ? t('Save changes') : plan ? t('Save order') : kind === 'RECEIPT' ? t('Receive into stock') : kind === 'SALE' ? t('Dispatch') : t('Save and update stock')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function blank(kind: StockDocKind): StockDocInput {
  return { kind, status: 'DRAFT', docDate: today(), saleTo: kind === 'SALE' ? 'CUSTOMER' : null, channel: kind === 'ORDER' ? 'CALL' : null, lines: [] };
}

/** One item line: item, quantity or IMEIs (typed, scanned, pasted or picked from the store), price, damaged flag. */
function LineRow({ kind, line, locked, items, onItem, onChange, onRemove, storeId, plan }: { kind: StockDocKind; line: Line; locked: boolean; items: { id: string; name: string; serialTracked: boolean; unit: string; isActive: boolean }[]; onItem: (id: string) => void; onChange: (p: Partial<Line>) => void; onRemove: () => void; storeId: string | null; plan: boolean }) {
  const { t } = useTranslation();
  const item = items.find((i) => i.id === line.itemId);
  const serial = !!item?.serialTracked && !plan;
  const count = serial ? parseSerials(line.serialText).length : line.qty;
  const [pick, setPick] = useState(false);
  const pickStatus = kind === 'SALES_RETURN' ? 'SOLD' : kind === 'PURCHASE_RETURN' ? 'DAMAGED' : 'IN_STOCK';
  const available = useQuery({
    queryKey: ['stock', 'available', line.itemId, storeId, pickStatus],
    queryFn: ({ signal }) => api.get<string[]>('/stock/available', { itemId: line.itemId, locationId: storeId ?? undefined, status: pickStatus }, signal),
    enabled: pick && !!line.itemId,
  });
  const chosen = new Set(parseSerials(line.serialText));
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="grid items-end gap-2 sm:grid-cols-[minmax(0,2fr)_100px_130px_auto_auto]">
        <Field label={t('Item')} htmlFor={`li-${line.key}`}>
          <Select value={line.itemId || NONE} onValueChange={(v) => v !== NONE && onItem(v)} disabled={locked}>
            <SelectTrigger id={`li-${line.key}`}>
              <SelectValue placeholder={t('Choose…')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t('Choose…')}</SelectItem>
              {items.filter((i) => i.isActive || i.id === line.itemId).map((i) => (
                <SelectItem key={i.id} value={i.id}>
                  {i.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={kind === 'ADJUSTMENT' && !serial ? t('Qty (+ add / − remove)') : t('Qty')} htmlFor={`lq-${line.key}`}>
          <Input id={`lq-${line.key}`} type="number" value={serial ? count : line.qty} onChange={(e) => onChange({ qty: Number(e.target.value) || 0 })} disabled={locked || serial} />
        </Field>
        <Field label={t('Price each (₹, incl. GST)')} htmlFor={`lr-${line.key}`}>
          <Input id={`lr-${line.key}`} inputMode="decimal" value={line.rateText} onChange={(e) => onChange({ rateText: e.target.value })} disabled={locked} />
        </Field>
        {(kind === 'RECEIPT' || kind === 'SALES_RETURN') && (
          <Field label={t('Condition')} htmlFor={`lc-${line.key}`}>
            <Select value={line.condition} onValueChange={(v) => onChange({ condition: v as 'OK' | 'DAMAGED' })} disabled={locked}>
              <SelectTrigger id={`lc-${line.key}`} className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="OK">{t('Good')}</SelectItem>
                <SelectItem value="DAMAGED">{t('Damaged / not working')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
        {!locked && (
          <Button variant="ghost" size="icon" aria-label={t('Remove item')} onClick={onRemove}>
            <Trash2Icon />
          </Button>
        )}
      </div>
      {serial && (
        <div className="space-y-1.5">
          <Field label={kind === 'ADJUSTMENT' ? t('IMEI / numbers (positive qty adds them; use a remove line to take them out)') : t('IMEI / SIM numbers: scan, type or paste, one per line ({{n}})', { n: count })} htmlFor={`ls-${line.key}`}>
            <Textarea id={`ls-${line.key}`} rows={Math.min(6, Math.max(2, count + 1))} className="font-mono text-xs" value={line.serialText} onChange={(e) => onChange({ serialText: e.target.value })} disabled={locked} />
          </Field>
          {OUT_KINDS.concat(['SALES_RETURN']).includes(kind) && !locked && line.itemId && (
            <div className="space-y-1.5">
              <Button size="sm" variant="outline" onClick={() => setPick((p) => !p)}>
                {pick ? t('Hide list') : kind === 'SALES_RETURN' ? t('Pick from sold units') : t('Pick from the store')}
              </Button>
              {pick && (
                <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto rounded-md border p-2">
                  {available.isLoading && <Spinner />}
                  {available.data?.length === 0 && <span className="text-xs text-muted-foreground">{t('None available.')}</span>}
                  {available.data?.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => {
                        const next = new Set(chosen);
                        if (next.has(s)) next.delete(s);
                        else next.add(s);
                        onChange({ serialText: [...next].join('\n') });
                      }}
                      className={`rounded border px-2 py-0.5 font-mono text-xs ${chosen.has(s) ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'}`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {kind === 'ADJUSTMENT' && serial && (
        <Select value={line.qty < 0 ? 'OUT' : 'IN'} onValueChange={(v) => onChange({ qty: v === 'OUT' ? -1 : 1 })} disabled={locked}>
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="IN">{t('Add these to stock (found)')}</SelectItem>
            <SelectItem value="OUT">{t('Remove from stock (lost / scrapped)')}</SelectItem>
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

/** Saved document: what follows from it, files, invoice and payment, and the next step buttons. */
function DocExtras({ doc, platform, act, onOpen, reseller }: { doc: StockDocDto; platform: boolean; act: (fn: () => Promise<unknown>) => void; onOpen: (t: EditorTarget) => void; reseller: boolean }) {
  const { t } = useTranslation();
  const linesFrom = (filter?: (itemId: string) => number) =>
    (filter ? doc.pending.map((p) => ({ itemId: p.itemId, qty: filter(p.itemId) || p.qty })) : doc.lines.map((l) => ({ itemId: l.itemId, qty: Math.abs(l.qty) }))).map((x) => {
      const src = doc.lines.find((l) => l.itemId === x.itemId);
      return { itemId: x.itemId, qty: x.qty, ratePaise: src?.ratePaise ?? 0, gstRatePct: src?.gstRatePct ?? 18, serials: filter ? [] : (src?.serials ?? []), condition: 'OK' as const, note: '' };
    });
  const customer = { customerCompanyId: doc.customerCompanyId, customerPartnerId: doc.customerPartnerId, customerName: doc.customerName, customerPhone: doc.customerPhone, customerEmail: doc.customerEmail, customerGstin: doc.customerGstin, customerStateCode: doc.customerStateCode, customerAddress: doc.customerAddress };
  const next: { label: string; target: EditorTarget }[] = [];
  const open = doc.status === 'OPEN' || doc.status === 'PARTIAL';
  if (doc.kind === 'PO' && open && !doc.toPlatform) next.push({ label: 'Receive goods', target: { kind: 'RECEIPT', prefill: { sourceId: doc.id, supplierId: doc.supplierId, lines: linesFrom(() => 0) } } });
  if (doc.kind === 'PO' && open && doc.toPlatform && platform) next.push({ label: 'Dispatch to reseller', target: { kind: 'SALE', prefill: { sourceId: doc.id, saleTo: 'PARTNER', customerPartnerId: doc.partnerId, lines: linesFrom(() => 0) } } });
  if (doc.kind === 'ORDER' && open) next.push({ label: 'Make the sale', target: { kind: 'SALE', prefill: { sourceId: doc.id, saleTo: doc.customerPartnerId ? 'PARTNER' : 'CUSTOMER', ...customer, lines: linesFrom(() => 0) } } });
  if (doc.kind === 'RECEIPT' && doc.status === 'DONE') next.push({ label: 'Return to supplier', target: { kind: 'PURCHASE_RETURN', prefill: { sourceId: doc.id, supplierId: doc.supplierId, lines: doc.lines.filter((l) => l.condition === 'DAMAGED').map((l) => ({ ...l, condition: 'OK' as const })) } } });
  if (doc.kind === 'SALE' && doc.status === 'DONE' && doc.saleTo !== 'OWN') next.push({ label: 'Customer return', target: { kind: 'SALES_RETURN', prefill: { sourceId: doc.id, ...customer, lines: linesFrom().map((l) => ({ ...l, serials: [] })) } } });
  void reseller;

  const upload = (file: File) => {
    const form = new FormData();
    form.append('file', file);
    act(() => api.upload(`/stock/docs/${doc.id}/files`, form));
  };
  const openFile = async (id: string) => {
    const blob = await fetchBlob(`/stock/files/${id}`);
    window.open(URL.createObjectURL(blob), '_blank');
  };
  const openPdf = async () => {
    const blob = await fetchBlob(`/stock/invoices/${doc.invoice!.id}/pdf`);
    window.open(URL.createObjectURL(blob), '_blank');
  };

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3 text-sm">
      {doc.pending.length > 0 && (
        <p>
          <span className="font-semibold">{t('Still to come')}: </span>
          {doc.pending.map((p) => `${p.itemName} × ${p.qty}`).join(', ')}
        </p>
      )}
      {doc.followUps.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{t('Linked')}:</span>
          {doc.followUps.map((u) => (
            <Button key={u.id} size="sm" variant="outline" onClick={() => onOpen({ kind: u.kind, id: u.id })}>
              {u.number} <Badge variant={STATUS_TONE[u.status]}>{t(STATUS_LABEL[u.status])}</Badge>
            </Button>
          ))}
        </div>
      )}
      {next.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {next.map((n) => (
            <Button key={n.label} size="sm" onClick={() => onOpen(n.target)}>
              {t(n.label)}
            </Button>
          ))}
        </div>
      )}
      {(doc.kind === 'RECEIPT' || doc.kind === 'PURCHASE_RETURN' || doc.kind === 'SALE' || doc.kind === 'SALES_RETURN') && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{doc.kind === 'RECEIPT' ? t("Supplier's invoice / files") : t('Files')}:</span>
          {doc.files.map((file) => (
            <span key={file.id} className="inline-flex items-center gap-1 rounded border bg-card px-2 py-0.5">
              <button type="button" className="hover:underline" onClick={() => void openFile(file.id)}>
                <PaperclipIcon className="inline size-3" /> {file.fileName}
              </button>
              <button type="button" aria-label={t('Remove file')} className="text-muted-foreground hover:text-destructive" onClick={() => act(() => api.delete(`/stock/files/${file.id}`))}>
                ×
              </button>
            </span>
          ))}
          <label className="inline-flex cursor-pointer items-center gap-1 rounded border border-dashed px-2 py-0.5 hover:bg-muted">
            <PlusIcon className="size-3" /> {t('Upload PDF / photo')}
            <input type="file" accept="application/pdf,image/*" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </label>
        </div>
      )}
      {platform && (doc.kind === 'SALE' || doc.kind === 'SALES_RETURN') && doc.status === 'DONE' && doc.saleTo !== 'OWN' && !doc.partnerId && (
        <div className="flex flex-wrap items-center gap-2">
          {doc.invoice ? (
            <>
              <span className="font-semibold">{doc.invoice.kind === 'INVOICE' ? t('Invoice') : t('Credit note')}:</span>
              <span>{doc.invoice.number}</span>
              <span className="tabular-nums">{rupees(doc.invoice.totalPaise)}</span>
              {doc.invoice.kind === 'INVOICE' && <Badge variant={doc.invoice.paymentStatus === 'PAID' ? 'success' : 'warning'}>{t({ PAID: 'Paid', PART: 'Part paid', UNPAID: 'Unpaid' }[doc.invoice.paymentStatus] ?? doc.invoice.paymentStatus)}</Badge>}
              <Button size="sm" variant="outline" onClick={() => void openPdf()}>
                <DownloadIcon /> {t('PDF')}
              </Button>
              {doc.invoice.kind === 'INVOICE' && doc.invoice.paymentStatus !== 'PAID' && (
                <Button size="sm" variant="outline" onClick={() => {
                  const amt = prompt(t('Amount received so far (₹)'), toRupeesText(doc.invoice!.totalPaise));
                  if (amt === null) return;
                  const mode = prompt(t('How (UPI / cash / bank)'), 'UPI') ?? 'UPI';
                  act(() => api.put(`/stock/invoices/${doc.invoice!.id}/payment`, { paidPaise: toPaise(amt), paymentMode: mode }));
                }}>
                  {t('Record payment')}
                </Button>
              )}
            </>
          ) : (
            <Button size="sm" onClick={() => act(() => api.post(`/stock/docs/${doc.id}/invoice`))}>
              <FileTextIcon /> {doc.kind === 'SALE' ? t('Make invoice') : t('Make credit note')}
            </Button>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {t('Created by {{who}} · last change by {{by}}', { who: doc.createdByName ?? '—', by: doc.updatedByName ?? '—' })}
      </p>
    </div>
  );
}
