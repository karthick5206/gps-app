import type { AuditLogDto, UserDto } from '@veetracer/shared';
import { ScrollTextIcon } from 'lucide-react';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/features/auth/auth-context';
import { Dash, DateCell, Muted } from '@/features/masters/cells';
import { ChangesView } from '@/features/masters/ChangesView';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn, MasterFilter } from '@/features/masters/types';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { i18n } from '@/lib/i18n';

const ACTION_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'secondary' | 'default'> = {
  CREATE: 'success',
  UPDATE: 'warning',
  DELETE: 'destructive',
  LOGIN: 'default',
  LOGIN_FAILED: 'destructive',
};

const columns: MasterColumn<AuditLogDto>[] = [
  { id: 'createdAt', header: 'Time', sortable: true, hideable: false, cell: (r) => <DateCell value={r.createdAt} /> },
  { id: 'userName', header: 'User', cell: (r) => r.userName ?? <Muted>{i18n.t('System')}</Muted> },
  { id: 'action', header: 'Action', sortable: true, cell: (r) => <Badge variant={ACTION_VARIANT[r.action] ?? 'secondary'}>{r.action}</Badge> },
  { id: 'entity', header: 'Entity', sortable: true, cell: (r) => r.entity },
  { id: 'entityId', header: 'Record ID', defaultHidden: true, cell: (r) => (r.entityId ? <span className="font-mono text-xs">{r.entityId}</span> : <Muted>—</Muted>) },
  { id: 'ip', header: 'IP address', cell: (r) => <Dash value={r.ip} /> },
  { id: 'changes', header: 'Changes', hideable: false, defaultHidden: true, cell: (r) => <ChangesView changes={r.changes} /> },
];

const rowLabel = (r: AuditLogDto) => `${r.action} ${r.entity}`;

export function AuditLogPage() {
  const { can } = useAuth();
  const users = useEntityOptions<UserDto>('/users', named, { enabled: can('users'), params: { status: undefined } });
  const filters = useMemo<MasterFilter[]>(
    () => [
      { kind: 'text', key: 'entity', label: 'Entity' },
      ...(can('users') ? [{ key: 'userId', label: 'Users', options: users.options }] : []),
      { kind: 'date', key: 'from', label: 'From', bound: 'start' },
      { kind: 'date', key: 'to', label: 'To', bound: 'end' },
    ],
    [can, users.options],
  );
  return (
    <MasterPage
      menu="audit_log"
      title="Audit Log"
      description="Every sign-in and change made in this company. Open a row to see what changed."
      endpoint="/audit-logs"
      columns={columns}
      rowLabel={rowLabel}
      filters={filters}
      statusFilter={false}
      readOnly
      defaultSort={{ id: 'createdAt', desc: true }}
      emptyIcon={ScrollTextIcon}
    />
  );
}
