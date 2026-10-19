import { useMutation, useQuery } from '@tanstack/react-query';
import type { DocumentDto, Paginated, ServiceRecordDto, ServiceReminderDto } from '@veetracer/shared';
import { CheckCheckIcon, DownloadIcon, FileTextIcon, PencilIcon, PlusIcon, Trash2Icon, WrenchIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';
import { DocumentForm, downloadDocument, MarkDoneDialog, ServiceForm, useInvalidateCompliance } from './forms';
import { DOCUMENTS_ENDPOINT, DocumentStatusBadge, formatKm, SERVICES_ENDPOINT, ServiceStatusBadge, useDocumentTypeOptions } from './status';

export interface ComplianceTarget {
  objectId?: string;
  driverId?: string;
  label: string;
}

/** Documents (and, for a vehicle, service reminders and history) of one vehicle or driver, with add / edit / mark done. */
export function CompliancePanel({ target }: { target: ComplianceTarget }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const invalidate = useInvalidateCompliance();
  const types = useDocumentTypeOptions();
  const [docForm, setDocForm] = useState<DocumentDto | null | undefined>(undefined);
  const [serviceForm, setServiceForm] = useState<ServiceReminderDto | null | undefined>(undefined);
  const [doneFor, setDoneFor] = useState<ServiceReminderDto | null>(null);
  const [deleting, setDeleting] = useState<DocumentDto | null>(null);
  const isVehicle = !!target.objectId;

  const docs = useQuery({
    queryKey: ['documents', target.objectId, target.driverId],
    queryFn: ({ signal }) => api.get<Paginated<DocumentDto>>(DOCUMENTS_ENDPOINT, { objectId: target.objectId, driverId: target.driverId, pageSize: 100, sort: 'expiresOn', order: 'asc' }, signal),
  });
  const services = useQuery({
    queryKey: ['service-reminders', target.objectId],
    queryFn: ({ signal }) => api.get<ServiceReminderDto[]>(SERVICES_ENDPOINT, { objectId: target.objectId }, signal),
    enabled: isVehicle,
  });
  const records = useQuery({
    queryKey: ['service-records', target.objectId],
    queryFn: ({ signal }) => api.get<ServiceRecordDto[]>(`${SERVICES_ENDPOINT}/records`, { objectId: target.objectId }, signal),
    enabled: isVehicle,
  });
  const remove = useMutation({
    mutationFn: (d: DocumentDto) => api.delete(`${DOCUMENTS_ENDPOINT}/${d.id}`),
    onSuccess: () => {
      toast.success(t('Document deleted'));
      setDeleting(null);
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t('Documents')}</h3>
          {can('documents', 'create') && (
            <Button size="sm" variant="outline" onClick={() => setDocForm(null)}>
              <PlusIcon /> {t('Add document')}
            </Button>
          )}
        </div>
        {docs.isLoading && <Skeleton className="h-20" />}
        {docs.isError && <p className="text-sm text-destructive">{errorMessage(docs.error)}</p>}
        {docs.data?.items.length === 0 && <p className="text-sm text-muted-foreground">{t('No documents yet.')}</p>}
        {docs.data?.items.map((d) => (
          <div key={d.id} className="flex items-start gap-2 rounded-lg border p-2.5 text-sm">
            <FileTextIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{types.labelOf(d.type)}</span>
                <DocumentStatusBadge status={d.status} daysLeft={d.daysLeft} />
              </div>
              <p className="text-xs text-muted-foreground tabular-nums">
                {[d.number, d.expiresOn ? t('expires {{date}}', { date: d.expiresOn }) : null].filter(Boolean).join(' · ') || '—'}
              </p>
            </div>
            {d.file && (
              <Button size="icon-sm" variant="ghost" aria-label={t('Download')} title={d.file.name} onClick={() => void downloadDocument(d)}>
                <DownloadIcon />
              </Button>
            )}
            {can('documents', 'edit') && (
              <Button size="icon-sm" variant="ghost" aria-label={t('Edit')} onClick={() => setDocForm(d)}>
                <PencilIcon />
              </Button>
            )}
            {can('documents', 'delete') && (
              <Button size="icon-sm" variant="ghost" aria-label={t('Delete')} onClick={() => setDeleting(d)}>
                <Trash2Icon />
              </Button>
            )}
          </div>
        ))}
      </section>

      {isVehicle && (
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">{t('Service reminders')}</h3>
            {can('documents', 'create') && (
              <Button size="sm" variant="outline" onClick={() => setServiceForm(null)}>
                <PlusIcon /> {t('Add reminder')}
              </Button>
            )}
          </div>
          {services.isLoading && <Skeleton className="h-16" />}
          {services.data?.length === 0 && <p className="text-sm text-muted-foreground">{t('No service reminders yet.')}</p>}
          {services.data?.map((s) => (
            <div key={s.id} className="flex items-start gap-2 rounded-lg border p-2.5 text-sm">
              <WrenchIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{s.title}</span>
                  {s.isActive ? <ServiceStatusBadge status={s.status} daysLeft={s.daysLeft} kmLeft={s.kmLeft} /> : <span className="text-xs text-muted-foreground">{t('Inactive')}</span>}
                </div>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {[s.dueAt ? t('due {{date}}', { date: s.dueAt }) : null, s.dueOdometerKm !== null ? t('due at {{km}}', { km: formatKm(s.dueOdometerKm) }) : null].filter(Boolean).join(' · ')}
                </p>
              </div>
              {can('documents', 'edit') && (
                <>
                  <Button size="icon-sm" variant="ghost" aria-label={t('Mark done')} title={t('Mark done')} onClick={() => setDoneFor(s)}>
                    <CheckCheckIcon />
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label={t('Edit')} onClick={() => setServiceForm(s)}>
                    <PencilIcon />
                  </Button>
                </>
              )}
            </div>
          ))}
          {!!records.data?.length && (
            <div className="space-y-1 pt-2">
              <h4 className="text-xs font-medium text-muted-foreground">{t('Service history')}</h4>
              {records.data.slice(0, 10).map((r) => (
                <p key={r.id} className="text-xs tabular-nums">
                  <span className="font-medium">{r.doneAt}</span> · {r.title}
                  {r.odometerKm !== null ? ` · ${formatKm(r.odometerKm)}` : ''}
                  {r.cost !== null ? ` · ₹${r.cost.toLocaleString()}` : ''}
                  {r.notes ? ` · ${r.notes}` : ''}
                </p>
              ))}
            </div>
          )}
        </section>
      )}

      {docForm !== undefined && (
        <DocumentForm record={docForm} open onOpenChange={(o) => !o && setDocForm(undefined)} preset={docForm ? undefined : { objectId: target.objectId, driverId: target.driverId, label: target.label }} />
      )}
      {serviceForm !== undefined && target.objectId && (
        <ServiceForm record={serviceForm} open onOpenChange={(o) => !o && setServiceForm(undefined)} preset={serviceForm ? undefined : { objectId: target.objectId, label: target.label }} />
      )}
      <MarkDoneDialog reminder={doneFor} onOpenChange={(o) => !o && setDoneFor(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('Delete document?')}
        description={t('The document and its attached file will be permanently deleted.')}
        confirmLabel={t('Delete')}
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}

/** Side sheet with a vehicle's or driver's documents (masters row action). */
export function ComplianceSheet({ target, onClose }: { target: ComplianceTarget | null; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Sheet open={!!target} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>
            {target?.objectId ? t('Documents & service') : t('Documents')} · {target?.label}
          </SheetTitle>
          <SheetDescription>{t('Expiry reminders are sent as alerts before each document expires.')}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{target && <CompliancePanel target={target} />}</div>
      </SheetContent>
    </Sheet>
  );
}
