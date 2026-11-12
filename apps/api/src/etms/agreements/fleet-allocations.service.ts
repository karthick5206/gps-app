import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { agreementInForce, type TransportFleetAllocationDto } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { hasPermission } from '../../access/access-rules';
import { transportNotFound } from '../../access/transport-scope';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { sqlState } from '../dispatch/e3-common';
import { agreementActor, agreementVisibilityWhere, canWriteAgreements } from './agreements.service';
import { CreateFleetAllocationDto } from './agreements.dto';

export const ALLOCATION_ENTITY = 'TransportFleetAllocation';

const INCLUDE = {
  object: { select: { id: true, name: true, plateNumber: true } },
  driver: { select: { id: true, name: true } },
} satisfies Prisma.TransportFleetAllocationInclude;
type Row = Prisma.TransportFleetAllocationGetPayload<{ include: typeof INCLUDE }>;
type AgreementRow = { id: string; providerCompanyId: string; customerCompanyId: string; status: Prisma.TransportServiceAgreementGetPayload<object>['status']; validFrom: Date; validTo: Date | null };

const err = (code: string, message: string) => ({ message, code });

/** In force at `now`: inside its own validity and the agreement is ACTIVE and in force. */
export function allocationActive(r: { validFrom: Date; validTo: Date | null }, agreement: Pick<AgreementRow, 'status' | 'validFrom' | 'validTo'>, now: Date = new Date()): boolean {
  return r.validFrom <= now && (!r.validTo || r.validTo > now) && agreementInForce(agreement, now);
}

/**
 * DTO for one viewer. Both parties see the vehicle name / plate and the driver's name (the fleet that serves the
 * customer); nothing else about the provider's fleet. `canEnd` only for the provider side with agreement commands.
 */
export function toAllocationDto(r: Row, agreement: AgreementRow, canEnd: boolean, now: Date = new Date()): TransportFleetAllocationDto {
  return {
    id: r.id,
    agreementId: r.agreementId,
    providerCompanyId: r.providerCompanyId,
    customerCompanyId: r.customerCompanyId,
    vehicle: r.object ? { id: r.object.id, name: r.object.name, plateNumber: r.object.plateNumber } : null,
    driver: r.driver ? { id: r.driver.id, name: r.driver.name } : null,
    validFrom: r.validFrom.toISOString(),
    validTo: r.validTo ? r.validTo.toISOString() : null,
    active: allocationActive(r, agreement, now),
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    canEnd: canEnd && (!r.validTo || r.validTo > now),
  };
}

/**
 * Fleet allocations under a service agreement (E1b, doc 15 §10): the provider sets vehicles / drivers of its OWN
 * company aside for the customer. Parties (and VeeTrax support on the platform) read them; only the provider side's
 * whole-company users with etms_partners:edit write them (VeeTrax support does not: it is the provider's operation).
 * Allocations do not widen any access: what a provider may see stays decided by the agreement (transport-scope).
 */
@Injectable()
export class FleetAllocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(ctx: AuthContext, agreementId: string): Promise<TransportFleetAllocationDto[]> {
    const agreement = await this.agreement(ctx, agreementId);
    const rows = await this.prisma.transportFleetAllocation.findMany({ where: { agreementId }, include: INCLUDE, orderBy: [{ validFrom: 'desc' }, { id: 'asc' }], take: 500 });
    const canEnd = this.isProviderWriter(ctx, agreement);
    const now = new Date();
    return rows.map((r) => toAllocationDto(r, agreement, canEnd, now));
  }

  /** The provider's own active vehicles / drivers for the allocation picker (provider side writers only). */
  async options(ctx: AuthContext, agreementId: string, q?: string): Promise<{ vehicles: { id: string; name: string; plateNumber: string | null }[]; drivers: { id: string; name: string }[] }> {
    const agreement = await this.agreement(ctx, agreementId);
    this.assertProviderWriter(ctx, agreement);
    const term = q?.trim();
    const [vehicles, drivers] = await Promise.all([
      this.prisma.trackedObject.findMany({
        where: { companyId: agreement.providerCompanyId, isActive: true, ...(term ? { OR: [{ name: { contains: term, mode: 'insensitive' } }, { plateNumber: { contains: term, mode: 'insensitive' } }] } : {}) },
        select: { id: true, name: true, plateNumber: true },
        orderBy: { name: 'asc' },
        take: 50,
      }),
      this.prisma.driver.findMany({
        where: { companyId: agreement.providerCompanyId, isActive: true, ...(term ? { name: { contains: term, mode: 'insensitive' } } : {}) },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
        take: 50,
      }),
    ]);
    return { vehicles, drivers };
  }

  async create(ctx: AuthContext, agreementId: string, dto: CreateFleetAllocationDto): Promise<TransportFleetAllocationDto> {
    const agreement = await this.agreement(ctx, agreementId);
    this.assertProviderWriter(ctx, agreement);
    if (agreement.status === 'ENDED') throw new ConflictException(err('INVALID_STATE', 'This agreement has ended'));
    const objectId = dto.objectId ?? null;
    const driverId = dto.driverId ?? null;
    if (!objectId && !driverId) throw this.invalid('Choose a vehicle, a driver or both');
    const now = new Date();
    const validFrom = dto.validFrom ? new Date(dto.validFrom) : now;
    const validTo = dto.validTo ? new Date(dto.validTo) : null;
    if (Number.isNaN(validFrom.getTime()) || (validTo && Number.isNaN(validTo.getTime()))) throw this.invalid('Invalid date');
    if (validTo && validTo <= validFrom) throw this.invalid('"Valid to" must be after "valid from"');
    if (validTo && validTo <= now) throw this.invalid('The allocation would already be over');
    // Same-company check (doc 15 §1.4): only the provider's own active vehicle / driver; any other id answers like an
    // unknown one (no enumeration of other fleets).
    if (objectId && !(await this.prisma.trackedObject.count({ where: { id: objectId, companyId: agreement.providerCompanyId, isActive: true } }))) throw transportNotFound('Vehicle not found');
    if (driverId && !(await this.prisma.driver.count({ where: { id: driverId, companyId: agreement.providerCompanyId, isActive: true } }))) throw transportNotFound('Driver not found');
    const overlap = await this.prisma.transportFleetAllocation.count({
      where: {
        agreementId,
        OR: [...(objectId ? [{ objectId }] : []), ...(driverId ? [{ driverId }] : [])],
        AND: [{ OR: [{ validTo: null }, { validTo: { gt: validFrom } }] }, ...(validTo ? [{ validFrom: { lt: validTo } }] : [])],
      },
    });
    if (overlap) throw this.overlap();
    const note = dto.note?.trim() || null;
    const row = await this.prisma
      .$transaction(async (tx) => {
        const created = await tx.transportFleetAllocation.create({
          data: { agreementId, providerCompanyId: agreement.providerCompanyId, customerCompanyId: agreement.customerCompanyId, objectId, driverId, validFrom, validTo, note, createdById: ctx.userId },
          include: INCLUDE,
        });
        await this.audit.record(ctx, { action: 'CREATE', entity: ALLOCATION_ENTITY, entityId: created.id, details: { agreementId, customerCompanyId: agreement.customerCompanyId, objectId, driverId, validFrom: validFrom.toISOString(), validTo: validTo?.toISOString() ?? null } }, tx);
        return created;
      })
      .catch((e: unknown) => {
        // The EXCLUDE constraint (race between two creates) → the same 409 as the check above.
        if (sqlState(e) === '23P01') throw this.overlap();
        throw e;
      });
    return toAllocationDto(row, agreement, true);
  }

  /** Ends an allocation now; one that has not started yet is removed. */
  async end(ctx: AuthContext, agreementId: string, allocationId: string): Promise<TransportFleetAllocationDto> {
    const agreement = await this.agreement(ctx, agreementId);
    this.assertProviderWriter(ctx, agreement);
    const before = await this.prisma.transportFleetAllocation.findFirst({ where: { id: allocationId, agreementId }, include: INCLUDE });
    if (!before) throw transportNotFound('Allocation not found');
    const now = new Date();
    if (before.validTo && before.validTo <= now) throw new ConflictException(err('INVALID_STATE', 'This allocation has already ended'));
    const row = await this.prisma.$transaction(async (tx) => {
      if (before.validFrom >= now) {
        await tx.transportFleetAllocation.delete({ where: { id: before.id } });
        await this.audit.record(ctx, { action: 'DELETE', entity: ALLOCATION_ENTITY, entityId: before.id, details: { agreementId, reason: 'ended before it started' } }, tx);
        return { ...before, validTo: before.validFrom };
      }
      const updated = await tx.transportFleetAllocation.update({ where: { id: before.id }, data: { validTo: now }, include: INCLUDE });
      await this.audit.record(ctx, { action: 'UPDATE', entity: ALLOCATION_ENTITY, entityId: before.id, before: { validTo: before.validTo }, after: { validTo: now } }, tx);
      return updated;
    });
    return toAllocationDto(row, agreement, true, now);
  }

  // ───────────────────────────── internals ─────────────────────────────

  /** The agreement if the caller may see it (a party, or VeeTrax support on the platform); else 404. */
  private async agreement(ctx: AuthContext, id: string): Promise<AgreementRow> {
    const row = await this.prisma.transportServiceAgreement.findFirst({
      where: { AND: [{ id }, agreementVisibilityWhere(ctx)] },
      select: { id: true, providerCompanyId: true, customerCompanyId: true, status: true, validFrom: true, validTo: true },
    });
    if (!row) throw transportNotFound('Agreement not found');
    return row;
  }

  private isProviderWriter(ctx: AuthContext, a: AgreementRow): boolean {
    return agreementActor(ctx, a) === 'PROVIDER' && canWriteAgreements(ctx) && hasPermission(ctx, 'etms_partners', 'edit');
  }

  /** 403 SCOPE_REQUIRED for branch-scoped callers, 403 FORBIDDEN_GRANT for the customer side and VeeTrax support. */
  private assertProviderWriter(ctx: AuthContext, a: AgreementRow): void {
    if (!canWriteAgreements(ctx)) throw new ForbiddenException(err('SCOPE_REQUIRED', 'Only users with whole-company access can allocate vehicles and drivers'));
    if (agreementActor(ctx, a) !== 'PROVIDER') throw new ForbiddenException(err('FORBIDDEN_GRANT', 'Only the provider allocates its vehicles and drivers'));
  }

  private invalid(message: string): BadRequestException {
    return new BadRequestException(err('VALIDATION_FAILED', message));
  }

  private overlap(): ConflictException {
    return new ConflictException(err('ALLOCATION_OVERLAP', 'This vehicle or driver is already allocated to this customer for an overlapping period'));
  }
}
