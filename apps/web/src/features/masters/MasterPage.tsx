import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table';
import type { Paginated } from '@veetracer/shared';
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns3Icon,
  FilterIcon,
  DatabaseIcon,
  DownloadIcon,
  EyeIcon,
  HistoryIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  PowerIcon,
  PowerOffIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/features/auth/auth-context';
import { api, downloadCsv, errorMessage, type QueryParams } from '@/lib/api';
import { storage, STORAGE_KEYS } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { DetailSheet } from './DetailSheet';
import { useInvalidateMaster } from './FormDialog';
import { HistorySheet } from './HistorySheet';
import type { MasterFilter, MasterPageProps } from './types';

const ALL = '__all';
const PAGE_SIZES = [10, 25, 50, 100];
type BulkAction = 'activate' | 'deactivate' | 'delete';
/** Bulk response; `failed` entries are only counted, their shape is not relied on. */
interface BulkResult {
  succeeded?: string[];
  failed?: unknown[];
}

function defaultRowId<T>(row: T): string {
  return (row as { id: string }).id;
}

function defaultVisibility<T>(columns: MasterPageProps<T>['columns']): VisibilityState {
  return Object.fromEntries(columns.filter((c) => c.defaultHidden).map((c) => [c.id, false]));
}

function filterParams(filters: MasterFilter[], values: Record<string, string | null>): QueryParams {
  const out: QueryParams = {};
  for (const f of filters) {
    const v = values[f.key];
    if (!v) continue;
    if (f.kind === 'date') {
      const d = new Date(`${v}T00:00:00`);
      if (f.bound === 'end') d.setHours(23, 59, 59, 999);
      out[f.key] = d.toISOString();
    } else out[f.key] = v;
  }
  return out;
}

function FilterControl({ filter, value, onChange }: { filter: MasterFilter; value: string | null; onChange: (v: string | null) => void }) {
  if (filter.kind === 'text') {
    return <Input value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} placeholder={filter.label} aria-label={filter.label} className="h-9 w-full" />;
  }
  if (filter.kind === 'date') {
    return (
      <Input type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} className="h-9 w-full" aria-label={filter.label} />
    );
  }
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? null : v)}>
      <SelectTrigger className="h-9 w-full" aria-label={filter.label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All {filter.label.toLowerCase()}</SelectItem>
        {filter.options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Text of an active filter chip, e.g. "Chennai" or "From 2026-10-01". */
function chipText(filter: MasterFilter, value: string): string {
  if (filter.kind === 'date') return `${filter.label} ${value}`;
  if (filter.kind === 'text') return `${filter.label}: ${value}`;
  return filter.options.find((o) => o.value === value)?.label ?? value;
}

const STATUS_TABS = [
  { value: null, label: 'All' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
] as const;

/**
 * Reusable master list: server-side search/sort/pagination/status filter, column chooser (persisted),
 * CSV export, bulk activate/deactivate/delete, row View/Edit/Delete/History, permission-gated actions.
 */
export function MasterPage<T>({
  menu,
  title,
  description,
  endpoint,
  columns,
  rowLabel,
  getRowId = defaultRowId,
  filters = [],
  statusFilter = true,
  defaultSort,
  Form,
  readOnly = false,
  history = !readOnly,
  canEditRow,
  canDeleteRow,
  rowActions,
  emptyIcon = DatabaseIcon,
  headerActions,
  allowCreate = true,
  bulkActions = true,
}: MasterPageProps<T>) {
  const { can } = useAuth();
  const invalidate = useInvalidateMaster();
  const allow = useMemo(
    () => ({
      create: allowCreate && !readOnly && !!Form && can(menu, 'create'),
      edit: !readOnly && !!Form && can(menu, 'edit'),
      delete: !readOnly && can(menu, 'delete'),
      export: can(menu, 'export'),
    }),
    [can, menu, readOnly, Form, allowCreate],
  );
  // Bulk activate/deactivate only applies to masters with an active flag (those with the status filter).
  const bulkStatus = statusFilter && allow.edit;
  const bulkEnabled = bulkActions && !readOnly && (bulkStatus || allow.delete);

  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sorting, setSorting] = useState<SortingState>(defaultSort ? [defaultSort] : []);
  const [status, setStatus] = useState<'ACTIVE' | 'INACTIVE' | null>(null);
  const [filterValues, setFilterValues] = useState<Record<string, string | null>>({});
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() =>
    storage.getJson(STORAGE_KEYS.columns(menu), defaultVisibility(columns)),
  );

  const [formRecord, setFormRecord] = useState<T | null | undefined>(undefined); // undefined = closed, null = create
  const [viewRow, setViewRow] = useState<T | null>(null);
  const [historyTarget, setHistoryTarget] = useState<{ id: string; label: string } | null>(null);
  const [deleteRow, setDeleteRow] = useState<T | null>(null);
  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null);

  useEffect(() => storage.setJson(STORAGE_KEYS.columns(menu), columnVisibility), [menu, columnVisibility]);
  // Any change of the result set resets paging and selection.
  useEffect(() => {
    setPage(1);
    setRowSelection({});
  }, [q, status, filterValues, sorting, pageSize]);

  const params: QueryParams = {
    q,
    page,
    pageSize,
    sort: sorting[0]?.id,
    order: sorting[0] ? (sorting[0].desc ? 'desc' : 'asc') : undefined,
    status: status ?? undefined,
    ...filterParams(filters, filterValues),
  };

  const list = useQuery({
    queryKey: ['master', endpoint, params],
    queryFn: ({ signal }) => api.get<Paginated<T>>(endpoint, params, signal),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const remove = useMutation({
    mutationFn: (row: T) => api.delete<unknown>(`${endpoint}/${getRowId(row)}`),
    onSuccess: (_, row) => {
      toast.success(`${rowLabel(row)} deleted`);
      setDeleteRow(null);
      invalidate(endpoint);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k]);
  const bulk = useMutation({
    mutationFn: (action: BulkAction) => api.post<BulkResult | undefined>(`${endpoint}/bulk`, { ids: selectedIds, action }),
    onSuccess: (res, action) => {
      const verb = action === 'delete' ? 'deleted' : `${action}d`;
      const failed = res?.failed?.length ?? 0;
      const succeeded = res?.succeeded?.length ?? selectedIds.length - failed;
      if (succeeded) toast.success(`${succeeded} record(s) ${verb}`);
      if (failed) toast.warning(`${failed} record(s) could not be ${verb} (for example, still in use).`);
      setBulkAction(null);
      setRowSelection({});
      invalidate(endpoint);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadCsv(endpoint, params, `${menu}-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  const tableColumns = useMemo<ColumnDef<T>[]>(() => {
    const defs: ColumnDef<T>[] = [];
    if (bulkEnabled) {
      defs.push({
        id: '__select',
        enableHiding: false,
        enableSorting: false,
        header: ({ table }) => (
          <Checkbox
            aria-label="Select all on this page"
            checked={table.getIsAllPageRowsSelected() ? true : table.getIsSomePageRowsSelected() ? 'indeterminate' : false}
            onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
          />
        ),
        cell: ({ row }) => <Checkbox aria-label="Select row" checked={row.getIsSelected()} onCheckedChange={(v) => row.toggleSelected(!!v)} />,
      });
    }
    for (const c of columns) {
      defs.push({
        id: c.id,
        header: c.header,
        enableSorting: !!c.sortable,
        enableHiding: c.hideable !== false,
        cell: ({ row }) => c.cell(row.original),
        meta: { className: c.className },
      });
    }
    defs.push({
      id: '__actions',
      enableHiding: false,
      enableSorting: false,
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => {
        const r = row.original;
        const editable = allow.edit && (canEditRow?.(r) ?? true);
        const deletable = allow.delete && (canDeleteRow?.(r) ?? true);
        const extra = rowActions?.(r);
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${rowLabel(r)}`}>
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setViewRow(r)}>
                <EyeIcon /> View
              </DropdownMenuItem>
              {editable && (
                <DropdownMenuItem onSelect={() => setFormRecord(r)}>
                  <PencilIcon /> Edit
                </DropdownMenuItem>
              )}
              {history && (
                <DropdownMenuItem onSelect={() => setHistoryTarget({ id: getRowId(r), label: rowLabel(r) })}>
                  <HistoryIcon /> History
                </DropdownMenuItem>
              )}
              {extra}
              {deletable && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => setDeleteRow(r)}>
                    <Trash2Icon /> Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    });
    return defs;
  }, [columns, bulkEnabled, allow, history, canEditRow, canDeleteRow, rowActions, rowLabel, getRowId]);

  const table = useReactTable({
    data: rows,
    columns: tableColumns,
    getRowId: (row) => getRowId(row),
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    enableSortingRemoval: true,
    pageCount,
    state: { sorting, rowSelection, columnVisibility },
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
  });

  const activeFilters = filters.filter((f) => filterValues[f.key]);
  const hasFilters = !!q || !!status || activeFilters.length > 0;
  const clearFilters = () => {
    setSearch('');
    setStatus(null);
    setFilterValues({});
  };
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const visibleColumnCount = table.getVisibleLeafColumns().length;
  const viewEditable = viewRow && allow.edit && (canEditRow?.(viewRow) ?? true);

  return (
    // Fills the viewport: header and toolbar stay put, rows scroll inside the card, pagination is always visible.
    <div className="mx-auto flex h-full min-h-[560px] w-full max-w-[1400px] flex-col gap-4 p-4 sm:p-6">
      <PageHeader
        title={title}
        description={description}
        actions={
          <>
            {headerActions}
            {allow.export && (
              <Button variant="outline" onClick={exportCsv} disabled={exporting}>
                {exporting ? <Spinner /> : <DownloadIcon />}
                <span className="hidden sm:inline">Export CSV</span>
              </Button>
            )}
            {allow.create && (
              <Button onClick={() => setFormRecord(null)}>
                <PlusIcon /> Add
              </Button>
            )}
          </>
        }
      />

      <Card className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden py-0">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative min-w-[12rem] flex-1 sm:max-w-sm">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${title.toLowerCase()}…`} aria-label="Search" className="h-9 pl-8" />
            {search && (
              <button type="button" onClick={() => setSearch('')} aria-label="Clear search" className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground">
                <XIcon className="size-3.5" />
              </button>
            )}
          </div>
          {statusFilter && (
            <div role="radiogroup" aria-label="Status" className="inline-flex h-9 items-center rounded-lg bg-muted p-0.5">
              {STATUS_TABS.map((t) => (
                <button
                  key={t.label}
                  type="button"
                  role="radio"
                  aria-checked={status === t.value}
                  onClick={() => setStatus(t.value)}
                  className={cn(
                    'h-8 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none',
                    status === t.value && 'bg-background text-foreground shadow-xs',
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
          {filters.length > 0 && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="h-9">
                  <FilterIcon /> Filters
                  {activeFilters.length > 0 && <Badge className="ml-0.5 h-5 min-w-5 justify-center rounded-full px-1.5">{activeFilters.length}</Badge>}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 space-y-3">
                {filters.map((f) => (
                  <div key={f.key} className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">{f.label}</p>
                    <FilterControl filter={f} value={filterValues[f.key] ?? null} onChange={(v) => setFilterValues((prev) => ({ ...prev, [f.key]: v }))} />
                  </div>
                ))}
                {activeFilters.length > 0 && (
                  <Button variant="ghost" size="sm" className="w-full" onClick={() => setFilterValues({})}>
                    <XIcon /> Reset filters
                  </Button>
                )}
              </PopoverContent>
            </Popover>
          )}
          <span className="flex-1" />
          <span className="text-sm text-muted-foreground tabular-nums">
            {list.isFetching && !list.isPending ? <Spinner className="inline" /> : `${total.toLocaleString()} ${total === 1 ? 'record' : 'records'}`}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className="size-9" aria-label="Choose columns">
                <Columns3Icon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
              {table
                .getAllLeafColumns()
                .filter((c) => c.getCanHide())
                .map((c) => (
                  <DropdownMenuCheckboxItem key={c.id} checked={c.getIsVisible()} onCheckedChange={(v) => c.toggleVisibility(!!v)} onSelect={(e) => e.preventDefault()}>
                    {String(c.columnDef.header)}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {activeFilters.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
            {activeFilters.map((f) => (
              <span key={f.key} className="inline-flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 pr-1 pl-2.5 text-xs">
                {chipText(f, filterValues[f.key]!)}
                <button type="button" aria-label={`Remove ${f.label} filter`} onClick={() => setFilterValues((prev) => ({ ...prev, [f.key]: null }))} className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                  <XIcon className="size-3" />
                </button>
              </span>
            ))}
            <Button variant="link" size="sm" className="h-6 px-1 text-xs" onClick={clearFilters}>
              Clear all
            </Button>
          </div>
        )}

        {selectedIds.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b bg-accent/60 px-3 py-2 text-sm animate-fade-in">
            <span className="font-medium">{selectedIds.length} selected</span>
            <span className="flex-1" />
            {bulkStatus && (
              <>
                <Button size="sm" variant="outline" onClick={() => setBulkAction('activate')}>
                  <PowerIcon /> Activate
                </Button>
                <Button size="sm" variant="outline" onClick={() => setBulkAction('deactivate')}>
                  <PowerOffIcon /> Deactivate
                </Button>
              </>
            )}
            {allow.delete && (
              <Button size="sm" variant="destructive" onClick={() => setBulkAction('delete')}>
                <Trash2Icon /> Delete
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setRowSelection({})}>
              Clear
            </Button>
          </div>
        )}

        {list.isError && (
          <div className="p-4">
            <FormError message={errorMessage(list.error)} />
          </div>
        )}

        <Table containerClassName="min-h-0 flex-1 overflow-auto">
          <TableHeader className="sticky top-0 z-10 bg-muted shadow-[inset_0_-1px_0_var(--color-border)]">
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="hover:bg-transparent">
                {hg.headers.map((h) => {
                  const sorted = h.column.getIsSorted();
                  return (
                    <TableHead key={h.id} aria-sort={sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : undefined}>
                      {h.column.getCanSort() ? (
                        <button type="button" onClick={h.column.getToggleSortingHandler()} className="-mx-1 inline-flex items-center gap-1 rounded px-1 uppercase hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none">
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {sorted === 'asc' ? <ArrowUpIcon className="size-3.5" /> : sorted === 'desc' ? <ArrowDownIcon className="size-3.5" /> : <ArrowUpDownIcon className="size-3.5 opacity-40" />}
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody className={cn(list.isPlaceholderData && 'opacity-60 transition-opacity')}>
            {list.isPending &&
              Array.from({ length: 6 }, (_, i) => (
                <TableRow key={i} className="hover:bg-transparent">
                  {Array.from({ length: visibleColumnCount }, (_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full max-w-36" />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            {!list.isPending &&
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() ? 'selected' : undefined}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className={(cell.column.columnDef.meta as { className?: string } | undefined)?.className}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            {list.isSuccess && rows.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={visibleColumnCount}>
                  <EmptyState
                    icon={emptyIcon}
                    title={hasFilters ? 'No matching records' : `No ${title.toLowerCase()} yet`}
                    description={hasFilters ? 'Try a different search or clear the filters.' : allow.create ? 'Add the first record to get started.' : undefined}
                    action={
                      hasFilters ? (
                        <Button variant="outline" size="sm" onClick={clearFilters}>
                          Clear filters
                        </Button>
                      ) : (
                        allow.create && (
                          <Button size="sm" onClick={() => setFormRecord(null)}>
                            <PlusIcon /> Add
                          </Button>
                        )
                      )
                    }
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        <div className="flex flex-col gap-3 border-t bg-card px-3 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground tabular-nums">
            {total > 0 ? `Showing ${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}` : 'No records'}
          </p>
          <div className="flex items-center gap-2">
            <span className="hidden text-muted-foreground sm:inline">Rows</span>
            <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
              <SelectTrigger className="h-8 w-[4.5rem]" aria-label="Rows per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZES.map((s) => (
                  <SelectItem key={s} value={String(s)}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="px-1 text-muted-foreground tabular-nums">
              {page} / {pageCount}
            </span>
            <Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeftIcon />
            </Button>
            <Button variant="outline" size="icon-sm" aria-label="Next page" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
              <ChevronRightIcon />
            </Button>
          </div>
        </div>
      </Card>

      {Form && formRecord !== undefined && <Form record={formRecord} open onOpenChange={(o) => !o && setFormRecord(undefined)} />}

      <DetailSheet
        title={title}
        row={viewRow}
        label={viewRow ? rowLabel(viewRow) : ''}
        columns={columns}
        onClose={() => setViewRow(null)}
        onEdit={
          viewEditable
            ? () => {
                setFormRecord(viewRow);
                setViewRow(null);
              }
            : undefined
        }
        onHistory={
          history && viewRow
            ? () => {
                setHistoryTarget({ id: getRowId(viewRow), label: rowLabel(viewRow) });
                setViewRow(null);
              }
            : undefined
        }
      />

      {history && <HistorySheet endpoint={endpoint} target={historyTarget} onClose={() => setHistoryTarget(null)} />}

      <ConfirmDialog
        open={!!deleteRow}
        onOpenChange={(o) => !o && setDeleteRow(null)}
        title="Delete record?"
        description={
          <>
            <span className="font-medium text-foreground">{deleteRow ? rowLabel(deleteRow) : ''}</span> will be permanently deleted. Records that are in use can't be
            deleted — deactivate them instead.
          </>
        }
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        onConfirm={() => deleteRow && remove.mutate(deleteRow)}
      />

      <ConfirmDialog
        open={!!bulkAction}
        onOpenChange={(o) => !o && setBulkAction(null)}
        title={bulkAction === 'delete' ? `Delete ${selectedIds.length} record(s)?` : `${bulkAction === 'activate' ? 'Activate' : 'Deactivate'} ${selectedIds.length} record(s)?`}
        description={bulkAction === 'delete' ? 'Selected records will be permanently deleted. Records in use will be rejected by the server.' : 'The status of all selected records will change.'}
        confirmLabel={bulkAction === 'delete' ? 'Delete' : 'Confirm'}
        destructive={bulkAction === 'delete'}
        pending={bulk.isPending}
        onConfirm={() => bulkAction && bulk.mutate(bulkAction)}
      />
    </div>
  );
}
