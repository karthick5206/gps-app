import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { deviceLicenceType, LICENCE_TYPE_LABELS, LicenceRequiredError, LicenceType, SeatLicenceType } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { LicencePolicyService } from './licence-policy.service';
import { LicenceSettingsService } from './licence-settings.service';
import { SUBJECT_COLUMN } from './seat-logic';
import { grantTrialSeat } from './trial';

const DAY_MS = 86_400_000;
type Tx = Prisma.TransactionClient;

export class LicenceRequiredException extends HttpException {
  constructor(type: LicenceType) {
    const body: LicenceRequiredError & { statusCode: number } = {
      statusCode: 402,
      code: 'LICENCE_REQUIRED',
      licenceType: type,
      message: `No free ${LICENCE_TYPE_LABELS[type].toLowerCase()} licence is available. Buy a licence (Billing & Licences) to add more.`,
    };
    super(body, 402);
  }
}

/**
 * Seat assignment hooks used by users / devices / fuel monitoring. A new subject takes a free, unexpired seat of its
 * type from the company pool (row-locked, so two concurrent creates never share a seat); without one the create is
 * refused (402 LICENCE_REQUIRED) unless a Super Admin sends an override reason (X-Licence-Override), which grants a
 * short complimentary seat (overrideDays) and is audited. Platform companies are exempt.
 */
@Injectable()
export class SeatsService {
  constructor(
    private readonly policy: LicencePolicyService,
    private readonly settings: LicenceSettingsService,
    private readonly audit: AuditService,
  ) {}

  /** Assign a seat to the subject (no-op for platform companies). Returns the seat id, or null when exempt. */
  async assign(tx: Tx, ctx: AuthContext | null, companyId: string, type: SeatLicenceType, subjectId: string): Promise<string | null> {
    if (await this.policy.isExempt(companyId)) return null;
    const col = Prisma.raw(`"${SUBJECT_COLUMN[type]}"`);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "LicenceSeat" SET ${col} = ${subjectId}::uuid, "assignedAt" = now(), "updatedAt" = now()
      WHERE "id" = (
        SELECT "id" FROM "LicenceSeat"
        WHERE "companyId" = ${companyId}::uuid AND "type" = ${type}::"LicenceType"
          AND "userId" IS NULL AND "deviceId" IS NULL AND "fuelObjectId" IS NULL AND "expiresAt" > now()
        ORDER BY "expiresAt" ASC, "id" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id"`;
    this.policy.invalidate(companyId);
    if (rows.length) return rows[0].id;
    // Personal / family accounts try devices first: a free-trial seat instead of "licence required".
    if (type !== 'FUEL_SENSOR') {
      const trial = await grantTrialSeat(tx, companyId, type, subjectId);
      if (trial) return trial.id;
    }
    const reason = ctx?.isSuperAdmin ? ctx.licenceOverride?.trim() : null;
    if (!reason) throw new LicenceRequiredException(type);
    const days = (await this.settings.get()).overrideDays;
    const now = new Date();
    const seat = await tx.licenceSeat.create({
      data: {
        type,
        companyId,
        source: 'OVERRIDE',
        activatedAt: now,
        expiresAt: new Date(now.getTime() + days * DAY_MS),
        [SUBJECT_COLUMN[type]]: subjectId,
        assignedAt: now,
        note: `Override by Super Admin: ${reason.slice(0, 200)}`,
      },
    });
    if (ctx) {
      await this.audit.record(
        { ...ctx, companyId },
        { action: 'CREATE', entity: 'licence_override', entityId: seat.id, details: { type, subjectId, reason, days } },
        tx,
      );
    }
    return seat.id;
  }

  /** Device in a company: keeps its seat, else takes a GPS_DEVICE or DASHCAM seat (by its model's capabilities). */
  async ensureDevice(tx: Tx, ctx: AuthContext | null, companyId: string, deviceId: string): Promise<void> {
    const existing = await tx.licenceSeat.findUnique({ where: { deviceId }, select: { companyId: true } });
    if (existing?.companyId === companyId) return;
    if (existing) await this.releaseDevice(tx, deviceId);
    const device = await tx.device.findUnique({ where: { id: deviceId }, select: { model: { select: { capabilities: true } } } });
    await this.assign(tx, ctx, companyId, deviceLicenceType(device?.model.capabilities ?? []), deviceId);
  }

  async ensureFuel(tx: Tx, ctx: AuthContext | null, companyId: string, objectId: string): Promise<void> {
    if (await tx.licenceSeat.count({ where: { fuelObjectId: objectId } })) return;
    await this.assign(tx, ctx, companyId, 'FUEL_SENSOR', objectId);
  }

  /** The seat goes back to the pool (deleted rows are released by the foreign key automatically). */
  async releaseDevice(tx: Tx, deviceId: string): Promise<void> {
    await tx.licenceSeat.updateMany({ where: { deviceId }, data: { deviceId: null, assignedAt: null } });
    this.policy.invalidate();
  }

  async releaseFuel(tx: Tx, objectId: string): Promise<void> {
    await tx.licenceSeat.updateMany({ where: { fuelObjectId: objectId }, data: { fuelObjectId: null, assignedAt: null } });
  }
}
