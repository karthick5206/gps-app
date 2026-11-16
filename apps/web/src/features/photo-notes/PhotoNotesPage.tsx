import { PHOTO_NOTE_CATEGORIES, PHOTO_NOTE_CATEGORY_LABELS, PHOTO_NOTE_SOURCE_LABELS, type PhotoNoteCategory, type PhotoNoteDto, type PhotoNoteListQuery } from '@veetracer/shared';
import { CameraIcon, ChevronLeftIcon, ChevronRightIcon, DownloadIcon, ListIcon, MapIcon, PlusIcon } from 'lucide-react';
import { useDeferredValue, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/features/auth/auth-context';
import { useBasemap } from '@/features/geofences/map/use-basemap';
import { downloadCsv, errorMessage, type QueryParams } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { formatAmount, PHOTO_NOTE_MAP_PAGE, usePhotoNotes } from './api';
import { AddPhotoNoteDialog } from './AddPhotoNoteDialog';
import { ObjectPicker } from './PhotoNoteDialogs';
import { CATEGORY_BADGE, personLine, PhotoNoteLightbox } from './PhotoNoteLightbox';
import { PhotoNotePins } from './PhotoNotePins';
import { PhotoNoteImage } from './use-photo-url';

const PAGE_SIZE = 50;
type View = 'list' | 'map';

/** yyyy-mm-dd of a local date. */
const dayInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const startOfDay = (day: string) => new Date(`${day}T00:00:00`).toISOString();
const endOfDay = (day: string) => new Date(`${day}T23:59:59.999`).toISOString();

function MapView({ notes, truncated }: { notes: PhotoNoteDto[] | undefined; truncated: boolean }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const { map, unsupported } = useBasemap(containerRef);
  return (
    <Card className="relative h-[calc(100dvh-300px)] min-h-[420px] overflow-hidden p-0">
      <div ref={containerRef} className="h-full w-full" role="region" aria-label={t('Photo notes map')} />
      <PhotoNotePins map={map} notes={notes} fit />
      {unsupported && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted p-6 text-center text-sm text-muted-foreground">
          {t("The map can't be shown because WebGL is turned off or not supported in this browser.")}
        </div>
      )}
      {truncated && (
        <div className="pointer-events-none absolute inset-x-2 top-2 flex justify-center">
          <span className="rounded-md border bg-card/95 px-2 py-1 text-xs text-muted-foreground shadow-sm">
            {t('Showing the latest {{count}} notes. Narrow the filters to see the rest.', { count: PHOTO_NOTE_MAP_PAGE })}
          </span>
        </div>
      )}
    </Card>
  );
}

/** Photos & notes: location photo notes ("memory pins") from the Tracker app, the mobile app and the web. */
export function PhotoNotesPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [view, setView] = useState<View>('list');
  const [fromDay, setFromDay] = useState(() => dayInput(new Date(Date.now() - 29 * 86_400_000)));
  const [toDay, setToDay] = useState(() => dayInput(new Date()));
  const [objectId, setObjectId] = useState<string | null>(null);
  const [category, setCategory] = useState<PhotoNoteCategory | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<PhotoNoteDto | null>(null);
  const [adding, setAdding] = useState(false);
  const [exporting, setExporting] = useState(false);
  const q = useDeferredValue(search.trim());

  const filters = useMemo<PhotoNoteListQuery>(
    () => ({
      from: fromDay ? startOfDay(fromDay) : undefined,
      to: toDay ? endOfDay(toDay) : undefined,
      objectId: objectId ?? undefined,
      category: category === 'ALL' ? undefined : category,
      q: q || undefined,
      mine: mine ? '1' : undefined,
    }),
    [fromDay, toDay, objectId, category, q, mine],
  );
  // Back to the first page whenever the filters change.
  const filterKey = JSON.stringify(filters);
  const [lastKey, setLastKey] = useState(filterKey);
  if (lastKey !== filterKey) {
    setLastKey(filterKey);
    setPage(1);
  }

  const list = usePhotoNotes({ ...filters, page, pageSize: PAGE_SIZE }, view === 'list');
  const forMap = usePhotoNotes({ ...filters, page: 1, pageSize: PHOTO_NOTE_MAP_PAGE }, view === 'map');
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadCsv('/photo-notes', filters as QueryParams, `photo-notes-${dayInput(new Date())}.csv`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader
        title={t('Photos & notes')}
        description={t('Photos taken at a place with a note: bills, receipts, customer visits and more, from the Tracker app, the mobile app and the web.')}
        actions={
          <>
            {can('photo_notes', 'export') && (
              <Button variant="outline" onClick={() => void exportCsv()} disabled={exporting}>
                {exporting ? <Spinner /> : <DownloadIcon />} {t('Export CSV')}
              </Button>
            )}
            {can('photo_notes', 'create') && (
              <Button onClick={() => setAdding(true)}>
                <PlusIcon /> {t('Add photo note')}
              </Button>
            )}
          </>
        }
      />

      <Card className="flex flex-wrap items-end gap-3 p-3">
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          {t('From')}
          <Input type="date" value={fromDay} max={toDay || undefined} onChange={(e) => setFromDay(e.target.value)} className="w-40" />
        </label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          {t('To')}
          <Input type="date" value={toDay} min={fromDay || undefined} onChange={(e) => setToDay(e.target.value)} className="w-40" />
        </label>
        <div className="grid w-56 gap-1 text-xs font-medium text-muted-foreground">
          <span>{t('Vehicle or person')}</span>
          <ObjectPicker value={objectId} onChange={setObjectId} placeholder={t('All')} />
        </div>
        <div className="grid gap-1 text-xs font-medium text-muted-foreground">
          <span>{t('Category')}</span>
          <Select value={category} onValueChange={(v) => setCategory(v as PhotoNoteCategory | 'ALL')}>
            <SelectTrigger className="w-36" aria-label={t('Category')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t('All categories')}</SelectItem>
              {PHOTO_NOTE_CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {t(PHOTO_NOTE_CATEGORY_LABELS[c])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="grid min-w-48 flex-1 gap-1 text-xs font-medium text-muted-foreground">
          {t('Search')}
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Search the note or address')} />
        </label>
        <label className="flex h-9 items-center gap-2 text-sm">
          <Checkbox checked={mine} onCheckedChange={(v) => setMine(v === true)} />
          {t('Only mine')}
        </label>
        <Tabs value={view} onValueChange={(v) => setView(v as View)} className="ml-auto">
          <TabsList>
            <TabsTrigger value="list">
              <ListIcon /> {t('List')}
            </TabsTrigger>
            <TabsTrigger value="map">
              <MapIcon /> {t('Map')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </Card>

      {view === 'map' ? (
        <MapView notes={forMap.data?.items} truncated={(forMap.data?.total ?? 0) > PHOTO_NOTE_MAP_PAGE} />
      ) : (
        <Card className="overflow-hidden p-0">
          {list.isPending ? (
            <Skeleton className="m-4 h-32" />
          ) : list.isError ? (
            <p className="p-4 text-sm text-destructive">{errorMessage(list.error)}</p>
          ) : !list.data?.items.length ? (
            <EmptyState
              icon={CameraIcon}
              title={t('No photo notes')}
              description={t('Photo notes taken in the Tracker app or the mobile app, or added here, show up in this list.')}
            />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">{t('Photo')}</TableHead>
                    <TableHead>{t('Taken at')}</TableHead>
                    <TableHead>{t('Category')}</TableHead>
                    <TableHead>{t('Note')}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t('Address')}</TableHead>
                    <TableHead>{t('Person')}</TableHead>
                    <TableHead className="text-right">{t('Amount')}</TableHead>
                    <TableHead className="hidden md:table-cell">{t('Source')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.data.items.map((n) => (
                    <TableRow key={n.id} className="cursor-pointer" onClick={() => setOpen(n)}>
                      <TableCell>
                        <button type="button" className="relative block" onClick={() => setOpen(n)} aria-label={t('Open photos')}>
                          {n.photos[0] ? (
                            <PhotoNoteImage noteId={n.id} photoId={n.photos[0].id} alt="" className="size-14 rounded-md object-cover" loading="lazy" />
                          ) : (
                            <div className="size-14 rounded-md bg-muted" />
                          )}
                          {n.photos.length > 1 && (
                            <span className="absolute right-0.5 bottom-0.5 rounded bg-black/65 px-1 text-[10px] font-semibold text-white tabular-nums">{n.photos.length}</span>
                          )}
                        </button>
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">{formatDateTime(n.takenAt)}</TableCell>
                      <TableCell>
                        <Badge variant={CATEGORY_BADGE[n.category]}>{t(PHOTO_NOTE_CATEGORY_LABELS[n.category])}</Badge>
                      </TableCell>
                      <TableCell className="max-w-64">
                        <span className="line-clamp-2 break-words">{n.note ?? '—'}</span>
                      </TableCell>
                      <TableCell className="hidden max-w-72 text-muted-foreground lg:table-cell">
                        <span className="line-clamp-2">{n.address ?? `${n.lat.toFixed(5)}, ${n.lng.toFixed(5)}`}</span>
                      </TableCell>
                      <TableCell>{personLine(n, t)}</TableCell>
                      <TableCell className="text-right whitespace-nowrap tabular-nums">{formatAmount(n.amountMinor, n.currency) ?? '—'}</TableCell>
                      <TableCell className="hidden text-muted-foreground md:table-cell">{t(PHOTO_NOTE_SOURCE_LABELS[n.source])}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="flex items-center justify-between gap-2 border-t px-4 py-2 text-sm text-muted-foreground">
                <span>{t('{{count}} notes', { count: total })}</span>
                {pages > 1 && (
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="icon-sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} aria-label={t('Previous page')}>
                      <ChevronLeftIcon />
                    </Button>
                    <span className="tabular-nums">{t('Page {{page}} of {{pages}}', { page, pages })}</span>
                    <Button variant="outline" size="icon-sm" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} aria-label={t('Next page')}>
                      <ChevronRightIcon />
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </Card>
      )}

      {open && <PhotoNoteLightbox note={open} onClose={() => setOpen(null)} />}
      {adding && <AddPhotoNoteDialog onClose={() => setAdding(false)} />}
    </div>
  );
}
