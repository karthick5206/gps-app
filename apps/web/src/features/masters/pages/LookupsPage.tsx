import { zodResolver } from '@hookform/resolvers/zod';
import type { LookupDto } from '@veetracer/shared';
import { ListTreeIcon, LockIcon } from 'lucide-react';
import { useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import type { Option } from '@/components/ui/multi-select';
import { useMe } from '@/features/auth/auth-context';
import { ActiveBadge } from '../cells';
import { humanize } from '@/lib/format';
import { i18n } from '@/lib/i18n';
import { FormDialog, useSaveMutation } from '../FormDialog';
import { SelectField, SwitchField, TextField } from '../form-fields';
import { numericText, requiredText, str } from '../form-schema';
import { MasterPage } from '../MasterPage';
import type { MasterColumn, MasterFilter, MasterFormProps } from '../types';

const ENDPOINT = '/lookups';

/** Lookup types seeded by the platform (spec: Lookup seed). */
const LOOKUP_TYPES = ['VEHICLE_TYPE', 'FUEL_TYPE', 'LICENCE_CLASS', 'DOCUMENT_TYPE', 'GEOFENCE_CATEGORY', 'VEHICLE_MAKE'] as const;
const TYPE_OPTIONS: Option[] = LOOKUP_TYPES.map((t) => ({ value: t, label: humanize(t) }));

const schema = z.object({
  type: z.string().min(1, 'Required'),
  code: requiredText(50).regex(/^[A-Z0-9_]+$/i, 'Letters, digits and _ only'),
  label: requiredText(100),
  sortOrder: numericText({ min: 0, max: 9999, integer: true }),
  isActive: z.boolean(),
});
type Values = z.infer<typeof schema>;

function LookupForm({ record, open, onOpenChange }: MasterFormProps<LookupDto>) {
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { type: record?.type ?? '', code: str(record?.code), label: str(record?.label), sortOrder: str(record?.sortOrder ?? 0), isActive: record?.isActive ?? true },
  });
  const save = useSaveMutation({ endpoint: ENDPOINT, id: record?.id ?? null, entity: 'Lookup', onSaved: () => onOpenChange(false) });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={record ? 'Edit lookup value' : 'Add lookup value'}
      pending={save.isPending}
      error={save.error}
      onSubmit={form.handleSubmit((v) => save.mutate({ type: v.type, code: v.code.toUpperCase(), label: v.label, sortOrder: Number(v.sortOrder || 0), isActive: v.isActive }))}
    >
      <SelectField form={form} name="type" label="Type" required options={TYPE_OPTIONS} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField form={form} name="code" label="Code" required placeholder="e.g. DIESEL" />
        <TextField form={form} name="sortOrder" label="Sort order" type="number" />
      </div>
      <TextField form={form} name="label" label="Label" required />
      <SwitchField form={form} name="isActive" label="Active" />
    </FormDialog>
  );
}

const columns: MasterColumn<LookupDto>[] = [
  { id: 'type', header: 'Type', sortable: true, cell: (r) => <Badge variant="secondary">{i18n.t(humanize(r.type))}</Badge> },
  { id: 'code', header: 'Code', sortable: true, cell: (r) => <span className="font-mono text-xs">{r.code}</span> },
  {
    id: 'label',
    header: 'Label',
    sortable: true,
    hideable: false,
    cell: (r) => (
      <span className="inline-flex items-center gap-1.5 font-medium">
        {r.label}
        {r.isSystem && <LockIcon className="size-3 text-muted-foreground" aria-label={i18n.t('System value')} />}
      </span>
    ),
  },
  { id: 'sortOrder', header: 'Order', sortable: true, cell: (r) => <span className="tabular-nums">{r.sortOrder}</span> },
  { id: 'isSystem', header: 'Source', cell: (r) => <Badge variant={r.isSystem ? 'muted' : 'default'}>{r.isSystem ? i18n.t('System') : i18n.t('Company')}</Badge> },
  { id: 'isActive', header: 'Status', cell: (r) => <ActiveBadge active={r.isActive} /> },
];

const filters: MasterFilter[] = [{ key: 'type', label: 'Types', options: TYPE_OPTIONS }];
const rowLabel = (r: LookupDto) => `${i18n.t(humanize(r.type))} · ${r.label}`;

export function LookupsPage() {
  const me = useMe();
  // System rows are read-only for companies.
  const editable = useCallback((r: LookupDto) => !r.isSystem || me.user.isSuperAdmin, [me.user.isSuperAdmin]);
  return (
    <MasterPage
      menu="lookups"
      title="Lookups"
      description="Drop-down values used across forms. System values are provided by the platform."
      endpoint={ENDPOINT}
      columns={columns}
      rowLabel={rowLabel}
      filters={filters}
      defaultSort={{ id: 'type', desc: false }}
      Form={LookupForm}
      canEditRow={editable}
      canDeleteRow={editable}
      emptyIcon={ListTreeIcon}
    />
  );
}
