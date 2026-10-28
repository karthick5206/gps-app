/** Super Admin permanent delete (GET /admin/purge/:kind/:id): what would be removed. */
export interface PurgePreviewDto {
  kind: 'device' | 'object' | 'user' | 'company';
  id: string;
  label: string;
  /** Text the Super Admin types to confirm (IMEI, name or e-mail). */
  confirm: string;
  /** Rows per table, largest first. */
  tables: { table: string; rows: number }[];
  totalRows: number;
}

/** Super Admin: X-Company-Id value that shows every company on the live map and in the vehicle / device / driver lists. */
export const ALL_COMPANIES = 'all';

export type TransferKind = 'object' | 'device' | 'driver';

/** `POST /admin/transfer/:kind/:id` result: the moved item (for a vehicle moved "start fresh", the new vehicle). */
export interface TransferResult {
  id: string;
  companyId: string;
  companyName: string;
}
