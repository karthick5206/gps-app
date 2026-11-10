import { useQuery } from '@tanstack/react-query';
import { STOCK_DOC_LABEL, STOCK_SERIAL_LABEL, type StockDashboardDto, type StockDocKind, type StockOnHandRow, type StockSerialDto } from '@veetracer/shared';
import { AlertTriangleIcon, PackageIcon, PlusIcon, SearchIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { DocEditor, type EditorTarget } from './DocEditor';
import { SetupTab } from './SetupTab';
import { rupees, STATUS_LABEL, STATUS_TONE, useStockDocs, useStockSide } from './stock-api';

/*
 * Purchases & sales (trackers are also kept in Stock & movements, the one stock register): one page, simple tabs. Dashboard (what needs attention), Purchases (orders to suppliers, goods
 * received, returns to suppliers), Sales (customer orders, sales), Returns (customer returns), Stock (on hand, IMEI
 * history, adjustments) and Setup (items, prices, suppliers; platform only). Every document opens in the same form.
 */
export function StockPage() {
  const { t } = useTranslation();
  const { platform } = useStockSide();
  const [tab, setTab] = useState('dashboard');
  const [target, setTarget] = useState<EditorTarget | null>(null);
  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader title={t('Purchases & sales')} description={t('Buy, receive, sell and return trackers, SIMs and accessories, with invoices. Trackers also update Stock & movements by themselves.')} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="dashboard">{t('Dashboard')}</TabsTrigger>
          <TabsTrigger value="purchases">{t('Purchases')}</TabsTrigger>
          <TabsTrigger value="sales">{t('Sales')}</TabsTrigger>
          <TabsTrigger value="returns">{t('Returns')}</TabsTrigger>
          <TabsTrigger value="stock">{t('Stock on hand')}</TabsTrigger>
          {platform && <TabsTrigger value="setup">{t('Items & suppliers')}</TabsTrigger>}
        </TabsList>
        <TabsContent value="dashboard" className="pt-3">
          <StockDashboard onOpen={setTarget} />
        </TabsContent>
        <TabsContent value="purchases" className="pt-3">
          <DocsList kinds={['PO', 'RECEIPT', 'PURCHASE_RETURN']} newKinds={['PO', 'RECEIPT', 'PURCHASE_RETURN']} onOpen={setTarget} />
        </TabsContent>
        <TabsContent value="sales" className="pt-3">
          {platform && <ResellerInbox onOpen={setTarget} />}
          <DocsList kinds={['ORDER', 'SALE']} newKinds={['ORDER', 'SALE']} onOpen={setTarget} />
        </TabsContent>
        <TabsContent value="returns" className="pt-3">
          <DocsList kinds={['SALES_RETURN', 'PURCHASE_RETURN']} newKinds={['SALES_RETURN']} onOpen={setTarget} />
        </TabsContent>
        <TabsContent value="stock" className="pt-3">
          <OnHand onOpen={setTarget} />
        </TabsContent>
        {platform && (
          <TabsContent value="setup" className="pt-3">
            <SetupTab />
          </TabsContent>
        )}
      </Tabs>
      <DocEditor target={target} onClose={() => setTarget(null)} onOpen={setTarget} />
    </div>
  );
}

function DocsList({ kinds, newKinds, onOpen }: { kinds: StockDocKind[]; newKinds: StockDocKind[]; onOpen: (t: EditorTarget) => void }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const docs = useStockDocs({ kinds, search });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {newKinds.map((k) => (
          <Button key={k} variant={k === newKinds[0] ? 'default' : 'outline'} onClick={() => onOpen({ kind: k })}>
            <PlusIcon /> {t(STOCK_DOC_LABEL[k])}
          </Button>
        ))}
        <div className="relative ms-auto w-full sm:w-72">
          <SearchIcon className="absolute start-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input className="ps-8" placeholder={t('Number, customer, invoice or IMEI')} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>
      <Card className="overflow-hidden p-0">
        {docs.isLoading ? (
          <Skeleton className="h-48" />
        ) : !docs.data?.length ? (
          <EmptyState icon={PackageIcon} title={t('Nothing here yet')} description={t('Use the buttons above to start.')} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Number')}</TableHead>
                <TableHead>{t('Type')}</TableHead>
                <TableHead>{t('Date')}</TableHead>
                <TableHead>{t('Supplier / customer')}</TableHead>
                <TableHead className="text-end">{t('Items')}</TableHead>
                <TableHead className="text-end">{t('Amount')}</TableHead>
                <TableHead>{t('Status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {docs.data.map((d) => (
                <TableRow key={d.id} className="cursor-pointer" onClick={() => onOpen({ kind: d.kind, id: d.id })}>
                  <TableCell className="font-medium">{d.number}</TableCell>
                  <TableCell>{t(STOCK_DOC_LABEL[d.kind])}</TableCell>
                  <TableCell className="tabular-nums">{d.docDate}</TableCell>
                  <TableCell>{d.supplierName ?? d.customerName ?? '—'}{d.partnerName && <span className="ms-1 text-xs text-muted-foreground">({d.partnerName})</span>}</TableCell>
                  <TableCell className="text-end tabular-nums">{d.lines.reduce((s, l) => s + Math.abs(l.qty), 0)}</TableCell>
                  <TableCell className="text-end tabular-nums">{rupees(d.totalPaise)}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_TONE[d.status]}>{t(STATUS_LABEL[d.status])}</Badge>
                    {d.invoice && <span className="ms-1 text-xs text-muted-foreground">{d.invoice.number}</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

/** Platform: purchase orders resellers sent to VeeTrax and not yet fully dispatched. */
function ResellerInbox({ onOpen }: { onOpen: (t: EditorTarget) => void }) {
  const { t } = useTranslation();
  const inbox = useStockDocs({ kinds: [], inbox: true });
  if (!inbox.data?.length) return null;
  return (
    <Card className="mb-4 gap-2 border-warning/40 p-4">
      <h3 className="text-sm font-semibold">{t('Orders from resellers ({{n}})', { n: inbox.data.length })}</h3>
      <div className="flex flex-wrap gap-2">
        {inbox.data.map((d) => (
          <Button key={d.id} size="sm" variant="outline" onClick={() => onOpen({ kind: d.kind, id: d.id })}>
            {d.number} · {d.partnerName} · {d.lines.reduce((s, l) => s + l.qty, 0)} {t('items')}
          </Button>
        ))}
      </div>
    </Card>
  );
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'warning' | 'destructive' }) {
  return (
    <Card className="gap-1 p-4">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p className={`text-2xl font-bold tabular-nums ${tone === 'destructive' ? 'text-destructive' : tone === 'warning' ? 'text-warning' : ''}`}>{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

/** Inventory dashboard: stock and its value, what to reorder (reorder level, on order, supplier lead time), POs due. */
function StockDashboard({ onOpen }: { onOpen: (t: EditorTarget) => void }) {
  const { t } = useTranslation();
  const { platform } = useStockSide();
  const q = useQuery({ queryKey: ['stock', 'dashboard'], queryFn: ({ signal }) => api.get<StockDashboardDto>('/stock/dashboard', undefined, signal), refetchInterval: 120_000 });
  const d = q.data;
  if (!d) return <Skeleton className="h-64" />;
  const maxDay = Math.max(1, ...d.salesByDay.map((x) => x.units));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile label={t('Units in stock')} value={d.unitsInStock.toLocaleString()} hint={t('Worth {{v}} at buying price', { v: rupees(d.stockValuePaise) })} />
        <Tile label={t('Low stock items')} value={String(d.lowStock.length)} tone={d.lowStock.some((x) => x.orderNow) ? 'destructive' : d.lowStock.length ? 'warning' : undefined} hint={t('At or below the reorder level')} />
        <Tile label={t('Damaged units')} value={String(d.damagedUnits)} tone={d.damagedUnits ? 'warning' : undefined} hint={t('Waiting to go back to the supplier')} />
        <Tile label={t('Sold this month')} value={d.soldUnitsMonth.toLocaleString()} hint={rupees(d.salesMonthPaise)} />
        <Tile label={t('Received this month')} value={d.receivedUnitsMonth.toLocaleString()} />
        <Tile label={t('Unpaid invoices')} value={String(d.unpaidInvoices.count)} tone={d.unpaidInvoices.count ? 'warning' : undefined} hint={rupees(d.unpaidInvoices.amountPaise)} />
      </div>
      {platform && d.resellerOrdersOpen > 0 && (
        <Card className="flex-row items-center gap-2 border-warning/40 p-3 text-sm">
          <AlertTriangleIcon className="size-4 text-warning" /> {t('{{n}} reseller orders are waiting to be dispatched (Sales tab).', { n: d.resellerOrdersOpen })}
        </Card>
      )}

      <Card className="gap-3 p-4">
        <h3 className="text-[15px] font-bold">{t('Reorder')}</h3>
        {!d.lowStock.length ? (
          <p className="text-sm text-muted-foreground">{t('Nothing is at or below its reorder level. Set reorder levels in Items & suppliers.')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Item')}</TableHead>
                <TableHead className="text-end">{t('In stock')}</TableHead>
                <TableHead className="text-end">{t('Reorder level')}</TableHead>
                <TableHead className="text-end">{t('On order')}</TableHead>
                <TableHead className="text-end">{t('Suggested order')}</TableHead>
                <TableHead>{t('Supplier · lead time')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.lowStock.map((x) => (
                <TableRow key={x.itemId}>
                  <TableCell className="font-medium">
                    {x.itemName} {x.orderNow ? <Badge variant="destructive">{t('Order now')}</Badge> : <Badge variant="warning">{t('Ordered')}</Badge>}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{x.onHand}</TableCell>
                  <TableCell className="text-end tabular-nums">{x.reorderLevel}</TableCell>
                  <TableCell className="text-end tabular-nums">{x.onOrder}</TableCell>
                  <TableCell className="text-end font-semibold tabular-nums">{x.suggestedQty}</TableCell>
                  <TableCell>{x.supplierName ? `${x.supplierName} · ${t('{{n}} days', { n: x.leadTimeDays })} (${t('by {{d}}', { d: x.expectedBy })})` : '—'}</TableCell>
                  <TableCell className="text-end">
                    {x.orderNow && (
                      <Button size="sm" onClick={() => onOpen({ kind: 'PO', prefill: { supplierId: x.supplierId, lines: [{ itemId: x.itemId, qty: x.suggestedQty, ratePaise: 0, gstRatePct: 18, serials: [], condition: 'OK', note: '' }] } })}>
                        {t('Make PO')}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="gap-3 p-4">
          <h3 className="text-[15px] font-bold">{t('Purchase orders due')}</h3>
          {!d.openPurchaseOrders.length ? (
            <p className="text-sm text-muted-foreground">{t('No open purchase orders.')}</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {d.openPurchaseOrders.map((p) => (
                <li key={p.id}>
                  <button type="button" className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-start hover:bg-muted" onClick={() => onOpen({ kind: 'PO', id: p.id })}>
                    <span>
                      <span className="font-medium">{p.number}</span> · {p.supplierName} · {t('{{n}} to come', { n: p.pendingQty })}
                    </span>
                    {p.overdueDays > 0 ? <Badge variant="destructive">{t('{{n}} days late', { n: p.overdueDays })}</Badge> : <span className="text-xs text-muted-foreground">{p.expectedBy ? t('due {{d}}', { d: p.expectedBy }) : ''}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="gap-3 p-4">
          <h3 className="text-[15px] font-bold">{t('Units sold, last 30 days')}</h3>
          <div className="flex h-32 items-end gap-[2px]" role="img" aria-label={t('Units sold per day')}>
            {d.salesByDay.map((x) => (
              <div key={x.day} title={`${x.day}: ${x.units} · ${rupees(x.amountPaise)}`} className="flex-1 rounded-t-sm bg-primary" style={{ height: `${Math.max(x.units ? 4 : 1, (x.units / maxDay) * 100)}%`, opacity: x.units ? 1 : 0.2 }} />
            ))}
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{d.salesByDay[0]?.day}</span>
            <span>{d.salesByDay.at(-1)?.day}</span>
          </div>
        </Card>
      </div>

      <Card className="gap-2 p-4">
        <h3 className="text-[15px] font-bold">{t('Latest activity')}</h3>
        <ul className="space-y-1 text-sm">
          {d.recent.map((r) => (
            <li key={r.id}>
              <button type="button" className="flex w-full flex-wrap items-center gap-2 rounded-md px-2 py-1 text-start hover:bg-muted" onClick={() => onOpen({ kind: r.kind, id: r.id })}>
                <span className="font-medium">{r.number}</span>
                <span className="text-muted-foreground">{t(STOCK_DOC_LABEL[r.kind])}</span>
                <span>{r.party}</span>
                <Badge variant={STATUS_TONE[r.status]}>{t(STATUS_LABEL[r.status])}</Badge>
                <span className="ms-auto tabular-nums">{rupees(r.totalPaise)}</span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/** Stock on hand per item and store, IMEI / SIM history, and stock adjustments. */
function OnHand({ onOpen }: { onOpen: (t: EditorTarget) => void }) {
  const { t } = useTranslation();
  const rows = useQuery({ queryKey: ['stock', 'on-hand'], queryFn: ({ signal }) => api.get<StockOnHandRow[]>('/stock/on-hand', undefined, signal) });
  const [serial, setSerial] = useState('');
  const [lookup, setLookup] = useState('');
  const found = useQuery({ queryKey: ['stock', 'serial', lookup], queryFn: ({ signal }) => api.get<StockSerialDto[]>(`/stock/serials/${encodeURIComponent(lookup)}`, undefined, signal), enabled: !!lookup });
  return (
    <div className="space-y-4">
      <Card className="gap-3 p-4">
        <h3 className="text-[15px] font-bold">{t('Find an IMEI / SIM number')}</h3>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setLookup(serial.trim());
          }}
        >
          <Input className="font-mono sm:w-80" value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="8664…" />
          <Button type="submit" variant="outline">
            <SearchIcon /> {t('Find')}
          </Button>
        </form>
        {lookup && found.data?.length === 0 && <p className="text-sm text-muted-foreground">{t('Not found in stock records.')}</p>}
        {found.data?.map((s) => (
          <div key={s.itemId} className="space-y-1 text-sm">
            <p>
              <span className="font-mono font-semibold">{s.serial}</span> · {s.itemName} · <Badge variant={s.status === 'IN_STOCK' ? 'success' : s.status === 'DAMAGED' ? 'warning' : 'muted'}>{t(STOCK_SERIAL_LABEL[s.status])}</Badge> {s.locationName && `· ${s.locationName}`} {s.customerName && `· ${s.customerName}`}
            </p>
            <ol className="ms-4 list-decimal text-muted-foreground">
              {s.history.map((h, i) => (
                <li key={i}>
                  <button type="button" className="hover:underline" onClick={() => onOpen({ kind: h.kind, id: h.docId })}>
                    {h.docDate} · {t(STOCK_DOC_LABEL[h.kind])} {h.number}
                  </button>
                  {h.party && ` · ${h.party}`} → {t(STOCK_SERIAL_LABEL[h.effect])}
                  {h.locationName && ` (${h.locationName})`}
                </li>
              ))}
            </ol>
          </div>
        ))}
      </Card>

      <Card className="gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[15px] font-bold">{t('Stock on hand')}</h3>
          <Button variant="outline" onClick={() => onOpen({ kind: 'ADJUSTMENT' })}>
            <PlusIcon /> {t('Stock adjustment')}
          </Button>
        </div>
        {!rows.data ? (
          <Skeleton className="h-40" />
        ) : !rows.data.length ? (
          <p className="text-sm text-muted-foreground">{t('No stock yet. Receive goods from Purchases.')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Item')}</TableHead>
                <TableHead>{t('Store')}</TableHead>
                <TableHead className="text-end">{t('Quantity')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.data.map((r) => {
                const low = r.locationKind !== 'DAMAGED' && r.lowStockAt !== null && r.qty <= r.lowStockAt;
                return (
                  <TableRow key={`${r.itemId}|${r.locationId}`}>
                    <TableCell className="font-medium">{r.itemName}</TableCell>
                    <TableCell>{r.locationName}</TableCell>
                    <TableCell className="text-end tabular-nums">
                      {r.qty} {r.unit} {low && <Badge variant="warning">{t('Low')}</Badge>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
