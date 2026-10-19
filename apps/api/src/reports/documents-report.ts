import { PrismaClient } from '@prisma/client';
import { DocumentsReportRow, documentStatus, documentTypeLabel, LICENSE_WARN_DAYS, ReportScope, serviceStatus } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { odometers, ymd } from '../documents/reminder-logic';
import { driverScopeWhere } from '../drivers/drivers.service';
import { ObjInfo } from './report-queries';

const URGENCY: Record<DocumentsReportRow['status'], number> = { EXPIRED: 0, OVERDUE: 0, EXPIRING: 1, DUE_SOON: 1, VALID: 2, OK: 2, NO_EXPIRY: 3 };

/** Most urgent first (expired / overdue, expiring / due soon, valid), then by days left and vehicle. */
export function sortDocumentsReport(rows: DocumentsReportRow[]): DocumentsReportRow[] {
  const left = (r: DocumentsReportRow) => Math.min(r.daysLeft ?? Infinity, r.kmLeft === null ? Infinity : r.kmLeft / 100);
  return rows.sort((a, b) => URGENCY[a.status] - URGENCY[b.status] || left(a) - left(b) || (a.vehicle ?? a.driver ?? '').localeCompare(b.vehicle ?? b.driver ?? ''));
}

/**
 * DOCUMENTS: document expiry and service status as of today, for the vehicles in scope. Driver documents (and licence
 * expiry kept on the driver) are included when the report covers all vehicles.
 */
export async function documentsReport(
  prisma: PrismaClient,
  ctx: Pick<AuthContext, 'companyId' | 'dataScope' | 'branchIds' | 'objectIds'>,
  objects: Map<string, ObjInfo>,
  scope: ReportScope,
  today: string,
  maxRows: number,
): Promise<{ rows: DocumentsReportRow[]; totals: Record<string, number>; totalRows: number }> {
  const ids = [...objects.keys()];
  const allVehicles = !scope.branchIds.length && !scope.groupIds.length && !scope.objectIds.length;
  const driverWhere = { AND: [driverScopeWhere(ctx), { isActive: true }] };
  const [vehicleDocs, driverDocs, licences, services] = await Promise.all([
    ids.length ? prisma.document.findMany({ where: { companyId: ctx.companyId, objectId: { in: ids } } }) : [],
    allVehicles ? prisma.document.findMany({ where: { companyId: ctx.companyId, driver: { is: driverWhere } }, include: { driver: { select: { name: true } } } }) : [],
    allVehicles
      ? prisma.driver.findMany({ where: { AND: [driverWhere, { licenseExpiry: { not: null }, documents: { none: { type: 'DRIVING_LICENCE' } } }] }, select: { name: true, licenseNo: true, licenseExpiry: true } })
      : [],
    ids.length ? prisma.serviceReminder.findMany({ where: { companyId: ctx.companyId, objectId: { in: ids }, isActive: true } }) : [],
  ]);
  const rows: DocumentsReportRow[] = [];
  const docRow = (vehicle: string | null, driver: string | null, type: string, number: string | null, expiresOn: Date | null, reminderDays: number): DocumentsReportRow => {
    const dueOn = ymd(expiresOn);
    const s = documentStatus(dueOn, reminderDays, today);
    return { kind: 'DOCUMENT', vehicle, driver, item: documentTypeLabel(type), number, dueOn, dueOdometerKm: null, daysLeft: s.daysLeft, kmLeft: null, status: s.status };
  };
  for (const d of vehicleDocs) rows.push(docRow(objects.get(d.objectId!)?.name ?? null, null, d.type, d.number, d.expiresOn, d.reminderDays));
  for (const d of driverDocs) rows.push(docRow(null, d.driver?.name ?? null, d.type, d.number, d.expiresOn, d.reminderDays));
  for (const l of licences) rows.push(docRow(null, l.name, 'DRIVING_LICENCE', l.licenseNo, l.licenseExpiry, LICENSE_WARN_DAYS));
  const odo = await odometers(prisma, services.map((s) => s.objectId));
  for (const s of services) {
    const dueOn = ymd(s.dueAt);
    const st = serviceStatus({ dueAt: dueOn, dueOdometerKm: s.dueOdometerKm, notifyBeforeDays: s.notifyBeforeDays, notifyBeforeKm: s.notifyBeforeKm }, today, odo.get(s.objectId) ?? null);
    rows.push({ kind: 'SERVICE', vehicle: objects.get(s.objectId)?.name ?? null, driver: null, item: s.title, number: null, dueOn, dueOdometerKm: s.dueOdometerKm, daysLeft: st.daysLeft, kmLeft: st.kmLeft, status: st.status });
  }
  sortDocumentsReport(rows);
  const count = (...statuses: DocumentsReportRow['status'][]) => rows.filter((r) => statuses.includes(r.status)).length;
  return {
    rows: rows.slice(0, maxRows),
    totals: { count: rows.length, expired: count('EXPIRED', 'OVERDUE'), dueSoon: count('EXPIRING', 'DUE_SOON') },
    totalRows: rows.length,
  };
}
