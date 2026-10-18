import type { MenuKey } from '@veetracer/shared';
import type { LucideIcon } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import type { Option } from '@/components/ui/multi-select';

export interface MasterColumn<T> {
  /** Column id; also sent as `sort=<id>` when sortable. */
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  sortable?: boolean;
  /** Can be toggled in the column chooser (default true). */
  hideable?: boolean;
  defaultHidden?: boolean;
  /** Include in the View sheet (default true). */
  detail?: boolean;
  className?: string;
}

export type MasterFilter =
  | { kind?: 'select'; key: string; label: string; options: Option[] }
  | { kind: 'text'; key: string; label: string }
  /** Sent as an ISO timestamp at the start (`from`) or end (`to`) of the chosen local day. */
  | { kind: 'date'; key: string; label: string; bound: 'start' | 'end' };

export interface MasterFormProps<T> {
  /** null = create */
  record: T | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export interface MasterPageProps<T> {
  menu: MenuKey;
  title: string;
  description?: string;
  /** API path below /api, e.g. `/branches`. */
  endpoint: string;
  columns: MasterColumn<T>[];
  rowLabel: (row: T) => string;
  getRowId?: (row: T) => string;
  filters?: MasterFilter[];
  /** ACTIVE/INACTIVE status filter and bulk activate/deactivate (default true). */
  statusFilter?: boolean;
  defaultSort?: { id: string; desc: boolean };
  Form?: ComponentType<MasterFormProps<T>>;
  /** Hides create/edit/delete/bulk/history regardless of permissions. */
  readOnly?: boolean;
  /** Enables the record history drawer (default true unless readOnly). */
  history?: boolean;
  canEditRow?: (row: T) => boolean;
  canDeleteRow?: (row: T) => boolean;
  /** Extra items for the row action menu. */
  rowActions?: (row: T) => ReactNode;
  emptyIcon?: LucideIcon;
}
