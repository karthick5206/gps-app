import { Prisma, PrismaClient } from '@prisma/client';
import { AlertSeverity, AlertTypeCode, documentStatus, documentTypeLabel, EffectiveAlertSetting, LICENSE_WARN_DAYS, serviceStatus } from '@veetracer/shared';
import { localDayKey } from '../summarizer/tz';
import { documentTransition, odometers, ReminderTransition, serviceTransition, ymd } from './reminder-logic';

/** The vehicle an alert is filed under (alerts always belong to a vehicle). */
export interface ReminderVehicle {
  id: string;
  name: string;
  plateNumber: string | null;
  branchId: string | null;
}

export interface ReminderAlert {
  companyId: string;
  type: AlertTypeCode;
  severity: AlertSeverity;
  message: string;
  data: Record<string, unknown>;
  object: ReminderVehicle;
  occurredAt: number;
}

export interface ReminderRules {
  effective(objectId: string): Map<AlertTypeCode, EffectiveAlertSetting>;
}

export interface ReminderJobDeps {
  prisma: Pick<PrismaClient, 'company' | 'document' | 'driver' | 'serviceReminder' | 'dailySummary' | 'trackedObject'>;
  rules: (companyId: string) => Promise<ReminderRules>;
  raise: (alert: ReminderAlert) => Promise<void>;
}

export interface ReminderRunStats {
  raised: number;
  cleared: number;
  /** Driver documents whose driver has never driven a vehicle yet: retried on the next run. */
  noVehicle: number;
}

const VEHICLE = { select: { id: true, name: true, plateNumber: true, branchId: true, isActive: true } } as const;
/** The driver's vehicle now, else the last one driven. */
const LAST_VEHICLE = { orderBy: { fromTime: 'desc' }, take: 1, select: { object: VEHICLE } } satisfies Prisma.Driver$assignmentsArgs;

const daysText = (days: number) => (days === 0 ? 'today' : days === 1 ? 'in 1 day' : `in ${days} days`);
const kmText = (km: number) => `${Math.round(km).toLocaleString('en-IN')} km`;

/**
 * Daily document / licence / service reminders for one company. Each row remembers the last state it alerted for
 * (`notifiedState`), claimed with a conditional update before the alert is raised — so re-runs, restarts and two API
 * instances never alert twice for the same state. A disabled or snoozed alert type still advances the state (no
 * backlog of reminders when it is switched on again).
 */
export class RemindersJob {
  constructor(private readonly deps: ReminderJobDeps) {}

  async runCompany(companyId: string, now: number): Promise<ReminderRunStats> {
    const { prisma } = this.deps;
    const stats: ReminderRunStats = { raised: 0, cleared: 0, noVehicle: 0 };
    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } });
    const today = localDayKey(now, company?.timezone ?? 'Asia/Kolkata');
    let rules: ReminderRules | null = null;
    const rulesFor = async () => (rules ??= await this.deps.rules(companyId));

    const apply = async (
      tr: ReminderTransition,
      claim: (next: string | null) => Promise<boolean>,
      vehicle: ReminderVehicle | null,
      build: () => { message: string; data: Record<string, unknown> },
    ) => {
      if (!tr.alert) {
        if (await claim(tr.next)) stats.cleared++;
        return;
      }
      if (!vehicle) {
        stats.noVehicle++;
        return;
      }
      if (!(await claim(tr.next))) return;
      const setting = (await rulesFor()).effective(vehicle.id).get(tr.alert);
      if (!setting?.supported || !setting.enabled || (setting.snoozedUntil && Date.parse(setting.snoozedUntil) > now)) return;
      await this.deps.raise({ companyId, type: tr.alert, severity: setting.severity, ...build(), object: vehicle, occurredAt: now });
      stats.raised++;
    };

    // ── Vehicle and driver documents ──
    const docs = await prisma.document.findMany({
      where: { companyId, OR: [{ expiresOn: { not: null } }, { notifiedState: { not: null } }] },
      include: { object: VEHICLE, driver: { select: { name: true, isActive: true, assignments: LAST_VEHICLE } } },
    });
    for (const d of docs) {
      const expiresOn = ymd(d.expiresOn);
      const { status, daysLeft } = documentStatus(expiresOn, d.reminderDays, today);
      const tr = documentTransition(status, d.notifiedState);
      if (!tr) continue;
      if (tr.alert && (d.object ? !d.object.isActive : !d.driver?.isActive)) continue;
      const vehicle = d.object ?? d.driver?.assignments[0]?.object ?? null;
      const label = documentTypeLabel(d.type);
      const document = `${d.driver ? `${label} of driver ${d.driver.name}` : label}${d.number ? ` (${d.number})` : ''}`;
      await apply(
        tr,
        async (next) => (await prisma.document.updateMany({ where: { id: d.id, notifiedState: d.notifiedState }, data: { notifiedState: next } })).count === 1,
        vehicle,
        () => ({
          message: tr.alert === 'DOCUMENT_EXPIRED' ? `${document} expired on ${expiresOn}` : `${document} expires on ${expiresOn} (${daysText(daysLeft ?? 0)})`,
          data: { documentId: d.id, documentType: d.type, documentNumber: d.number, driverId: d.driverId, driverName: d.driver?.name ?? null, document, expiresOn, daysLeft },
        }),
      );
    }

    // ── Licence expiry kept on the driver (drivers without a driving licence document) ──
    const drivers = await prisma.driver.findMany({
      where: { companyId, OR: [{ licenseExpiry: { not: null } }, { licenseNotifiedState: { not: null } }], documents: { none: { type: 'DRIVING_LICENCE' } } },
      select: { id: true, name: true, isActive: true, licenseNo: true, licenseExpiry: true, licenseNotifiedState: true, assignments: LAST_VEHICLE },
    });
    for (const d of drivers) {
      const expiresOn = ymd(d.licenseExpiry);
      const { status, daysLeft } = documentStatus(expiresOn, LICENSE_WARN_DAYS, today);
      const tr = documentTransition(status, d.licenseNotifiedState);
      if (!tr || (tr.alert && !d.isActive)) continue;
      const document = `Driving licence of driver ${d.name}${d.licenseNo ? ` (${d.licenseNo})` : ''}`;
      await apply(
        tr,
        async (next) => (await prisma.driver.updateMany({ where: { id: d.id, licenseNotifiedState: d.licenseNotifiedState }, data: { licenseNotifiedState: next } })).count === 1,
        d.assignments[0]?.object ?? null,
        () => ({
          message: tr.alert === 'DOCUMENT_EXPIRED' ? `${document} expired on ${expiresOn}` : `${document} expires on ${expiresOn} (${daysText(daysLeft ?? 0)})`,
          data: { documentType: 'DRIVING_LICENCE', documentNumber: d.licenseNo, driverId: d.id, driverName: d.name, document, expiresOn, daysLeft },
        }),
      );
    }

    // ── Service reminders ──
    const services = await prisma.serviceReminder.findMany({
      where: { companyId, OR: [{ isActive: true }, { notifiedState: { not: null } }] },
      include: { object: VEHICLE },
    });
    const odo = await odometers(prisma, services.filter((s) => s.dueOdometerKm !== null).map((s) => s.objectId));
    for (const s of services) {
      const dueAt = ymd(s.dueAt);
      const odometerKm = odo.get(s.objectId) ?? null;
      const st = s.isActive ? serviceStatus({ dueAt, dueOdometerKm: s.dueOdometerKm, notifyBeforeDays: s.notifyBeforeDays, notifyBeforeKm: s.notifyBeforeKm }, today, odometerKm) : null;
      const tr = serviceTransition(st?.status ?? 'OK', s.notifiedState);
      if (!tr || (tr.alert && !s.object.isActive)) continue;
      const due = [dueAt ? `on ${dueAt}` : null, s.dueOdometerKm !== null ? `at ${kmText(s.dueOdometerKm)}` : null].filter(Boolean).join(' or ');
      await apply(
        tr,
        async (next) => (await prisma.serviceReminder.updateMany({ where: { id: s.id, notifiedState: s.notifiedState }, data: { notifiedState: next } })).count === 1,
        s.object,
        () => ({
          message:
            st?.status === 'OVERDUE'
              ? `${s.title} overdue (was due ${due})`
              : `${s.title} due ${due}${st?.kmLeft !== null && st?.kmLeft !== undefined ? ` — ${kmText(st.kmLeft)} left` : ''}${st?.daysLeft !== null && st?.daysLeft !== undefined ? ` — ${daysText(st.daysLeft)}` : ''}`,
          data: { serviceReminderId: s.id, service: s.title, due, dueAt, dueOdometerKm: s.dueOdometerKm, odometerKm, daysLeft: st?.daysLeft ?? null, kmLeft: st?.kmLeft ?? null, overdue: st?.status === 'OVERDUE' },
        }),
      );
    }
    return stats;
  }
}
