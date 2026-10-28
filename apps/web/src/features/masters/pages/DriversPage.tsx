import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { LICENSE_WARN_DAYS, type BranchDto, type DriverAssignmentDto, type DriverDto } from '@veetracer/shared';
import { FileCheck2Icon, IdCardIcon, ListIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useWithCompanyColumn } from '@/features/platform/all-companies';
import { useTransferAction } from '@/features/platform/TransferDialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import { ComplianceSheet, type ComplianceTarget } from '@/features/documents/CompliancePanel';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatDuration } from '@/lib/format';
import { i18n } from '@/lib/i18n';
import { ActiveBadge, Dash, DateCell, Muted } from '../cells';
import { FormDialog, useSaveMutation } from '../FormDialog';
import { ComboboxField, SwitchField, TextField } from '../form-fields';
import { nullIfBlank, optionalText, requiredText, str } from '../form-schema';
import { MasterPage } from '../MasterPage';
import type { MasterColumn, MasterFilter, MasterFormProps } from '../types';
import { named, useEntityOptions } from '../use-options';

const ENDPOINT = '/drivers';

const schema = z.object({
  name: requiredText(100),
  employeeId: optionalText(40),
  mobile: z.string().trim().refine((v) => v === '' || /^\+[1-9]\d{7,14}$/.test(v), 'Use international format, e.g. +919876543210'),
  licenseNo: optionalText(40),
  licenseExpiry: z.string(),
  rfidTag: z.string().trim().refine((v) => v === '' || /^[0-9A-Fa-f:\s-]{1,40}$/.test(v), 'Hex digits only (as printed on the card or reported by the tracker)'),
  branchId: z.string().nullable(),
  notes: optionalText(500),
  isActive: z.boolean(),
});
type Values = z.infer<typeof schema>;

function DriverForm({ record, open, onOpenChange }: MasterFormProps<DriverDto>) {
  const { can } = useAuth();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: str(record?.name),
      employeeId: str(record?.employeeId),
      mobile: str(record?.mobile),
      licenseNo: str(record?.licenseNo),
      licenseExpiry: str(record?.licenseExpiry),
      rfidTag: str(record?.rfidTag),
      branchId: record?.branchId ?? null,
      notes: str(record?.notes),
      isActive: record?.isActive ?? true,
    },
  });
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: open && can('branches') });
  const save = useSaveMutation({ endpoint: ENDPOINT, id: record?.id ?? null, entity: 'Driver', onSaved: () => onOpenChange(false) });
  const submit = form.handleSubmit((v) =>
    save.mutate({
      name: v.name,
      employeeId: nullIfBlank(v.employeeId),
      mobile: nullIfBlank(v.mobile),
      licenseNo: nullIfBlank(v.licenseNo),
      licenseExpiry: v.licenseExpiry || null,
      rfidTag: nullIfBlank(v.rfidTag),
      branchId: v.branchId,
      notes: nullIfBlank(v.notes),
      isActive: v.isActive,
    }),
  );
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={record ? 'Edit driver' : 'Add driver'} wide pending={save.isPending} error={save.error} onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField form={form} name="name" label="Name" required className="sm:col-span-2" />
        <TextField form={form} name="employeeId" label="Employee ID" />
        <TextField form={form} name="mobile" label="Mobile" placeholder="+919876543210" autoComplete="tel" />
        <TextField form={form} name="licenseNo" label="Licence number" placeholder="TN01 20200012345" />
        <TextField form={form} name="licenseExpiry" label="Licence expiry" type="date" />
        <TextField
          form={form}
          name="rfidTag"
          label="RFID card / iButton ID"
          placeholder="e.g. 00A1B2C3D4"
          hint="Swiping this card on the tracker logs the driver onto that vehicle."
          className="font-mono"
        />
        {can('branches') && <ComboboxField form={form} name="branchId" label="Branch" options={branches.options} loading={branches.loading} placeholder="All branches" />}
      </div>
      <TextField form={form} name="notes" label="Notes" multiline />
      <SwitchField form={form} name="isActive" label="Active" hint="Inactive drivers can't be assigned and their card is ignored." />
    </FormDialog>
  );
}

function LicenseCell({ d }: { d: DriverDto }) {
  const { t } = useTranslation();
  if (!d.licenseNo && !d.licenseExpiry) return <Muted>—</Muted>;
  const days = d.licenseExpiry ? Math.floor((Date.parse(`${d.licenseExpiry}T00:00:00`) - Date.now()) / 86_400_000) : null;
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-mono text-xs">{d.licenseNo ?? '—'}</span>
      {d.licenseExpiry && (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {d.licenseExpiry}
          {days !== null && days < 0 && <Badge variant="destructive">{t('Expired')}</Badge>}
          {days !== null && days >= 0 && days <= LICENSE_WARN_DAYS && <Badge variant="warning">{t('{{n}} d left', { n: days })}</Badge>}
        </span>
      )}
    </span>
  );
}

const columns: MasterColumn<DriverDto>[] = [
  { id: 'name', header: 'Name', sortable: true, hideable: false, cell: (r) => <span className="font-medium">{r.name}</span> },
  { id: 'employeeId', header: 'Employee ID', sortable: true, cell: (r) => <Dash value={r.employeeId} /> },
  { id: 'mobile', header: 'Mobile', cell: (r) => <Dash value={r.mobile} /> },
  { id: 'licenseExpiry', header: 'Licence', sortable: true, cell: (r) => <LicenseCell d={r} /> },
  { id: 'rfidTag', header: 'RFID / iButton', cell: (r) => (r.rfidTag ? <span className="font-mono text-xs">{r.rfidTag}</span> : <Muted>—</Muted>) },
  { id: 'branchName', header: 'Branch', sortable: true, cell: (r) => <Dash value={r.branchName} /> },
  {
    id: 'current',
    header: 'Driving now',
    cell: (r) =>
      r.current ? (
        <span className="flex flex-col">
          <span className="font-medium">{r.current.objectName}</span>
          <span className="text-xs text-muted-foreground">
            {i18n.t('since {{time}}', { time: formatDateTime(r.current.since) })} · {r.current.source === 'RFID' ? i18n.t('card') : i18n.t('manual')}
          </span>
        </span>
      ) : (
        <Muted>—</Muted>
      ),
  },
  { id: 'isActive', header: 'Status', cell: (r) => <ActiveBadge active={r.isActive} /> },
  { id: 'notes', header: 'Notes', defaultHidden: true, cell: (r) => <span className="block max-w-xs truncate">{r.notes ?? '—'}</span> },
  { id: 'createdAt', header: 'Created', sortable: true, defaultHidden: true, cell: (r) => <DateCell value={r.createdAt} /> },
];

/** Driver sessions: which vehicle, from–to, card or manual. */
export function DriverSessionsSheet({ target, onClose }: { target: { driverId?: string; objectId?: string; label: string } | null; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['driver-assignments', target?.driverId, target?.objectId],
    queryFn: ({ signal }) => api.get<DriverAssignmentDto[]>('/drivers/assignments', { driverId: target?.driverId, objectId: target?.objectId }, signal),
    enabled: !!target,
  });
  return (
    <Sheet open={!!target} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{t('Driver sessions')} · {target?.label}</SheetTitle>
          <SheetDescription>{t('Latest first. Card sessions end when the ignition goes off or another card is swiped.')}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
          {q.isLoading && <Skeleton className="h-40" />}
          {q.isError && <p className="text-sm text-destructive">{errorMessage(q.error)}</p>}
          {q.data?.length === 0 && <p className="text-sm text-muted-foreground">{t('No sessions yet.')}</p>}
          {q.data?.map((a) => {
            const end = a.toTime ? Date.parse(a.toTime) : Date.now();
            return (
              <div key={a.id} className="rounded-lg border p-2.5 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{target?.driverId ? a.objectName : a.driverName}</span>
                  <Badge variant={a.source === 'RFID' ? 'secondary' : 'muted'}>{a.source === 'RFID' ? t('Card') : t('Manual')}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                  {formatDateTime(a.fromTime)} → {a.toTime ? formatDateTime(a.toTime) : <span className="font-medium text-success">{t('driving now')}</span>} · {formatDuration((end - Date.parse(a.fromTime)) / 1000)}
                  {a.createdByName ? ` · ${t('by {{name}}', { name: a.createdByName })}` : ''}
                </p>
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function DriversPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [sessions, setSessions] = useState<{ driverId: string; label: string } | null>(null);
  const [compliance, setCompliance] = useState<ComplianceTarget | null>(null);
  const transfer = useTransferAction('driver');
  const cols = useWithCompanyColumn(columns);
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: can('branches') });
  const filters = useMemo<MasterFilter[]>(
    () => [
      ...(can('branches') ? [{ key: 'branchId', label: 'Branches', options: branches.options }] : []),
      {
        key: 'driving',
        label: 'Driving now',
        options: [
          { value: 'on', label: 'On a vehicle' },
          { value: 'off', label: 'Not driving' },
        ],
      },
    ],
    [can, branches.options],
  );
  return (
    <>
      <MasterPage
        menu="drivers"
        title="Drivers"
        description="Drivers, their licences and RFID cards. A card swipe on the tracker logs the driver onto the vehicle."
        endpoint={ENDPOINT}
        columns={cols}
        rowLabel={(r) => r.name}
        filters={filters}
        defaultSort={{ id: 'name', desc: false }}
        Form={DriverForm}
        emptyIcon={IdCardIcon}
        rowActions={(r) => (
          <>
            <DropdownMenuItem onSelect={() => setSessions({ driverId: r.id, label: r.name })}>
              <ListIcon /> {t('Sessions')}
            </DropdownMenuItem>
            {can('documents') && (
              <DropdownMenuItem onSelect={() => setCompliance({ driverId: r.id, label: r.name })}>
                <FileCheck2Icon /> {t('Documents')}
              </DropdownMenuItem>
            )}
            {transfer.item({ id: r.id, name: r.name, companyId: r.companyId })}
          </>
        )}
      />
      <DriverSessionsSheet target={sessions} onClose={() => setSessions(null)} />
      <ComplianceSheet target={compliance} onClose={() => setCompliance(null)} />
      {transfer.dialog}
    </>
  );
}
