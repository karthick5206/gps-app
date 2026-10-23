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
