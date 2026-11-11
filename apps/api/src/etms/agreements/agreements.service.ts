import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  agreementActions,
  agreementInForce,
  nextAgreementStatus,
  type TransportAgreementAction,
  type TransportAgreementDto,
  type TransportAgreementSide,
} from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { transportNotFound } from '../../access/transport-scope';
import { AuditService } from '../../audit/audit.service';
import { CsvSpec, ListSpec, listResult, planList } from '../../common/list-query';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { AgreementListQuery, CreateAgreementDto, UpdateAgreementDto } from './agreements.dto';

export const AGREEMENT_ENTITY = 'TransportServiceAgreement';
const INCLUDE = { provider: { select: { name: true } }, customer: { select: { name: true } } } satisfies Prisma.TransportServiceAgreementInclude;
type Row = Prisma.TransportServiceAgreementGetPayload<{ include: typeof INCLUDE }>;
export type AgreementActor = TransportAgreementSide | 'PLATFORM';

const LIST: ListSpec = {
  search: (q) => ({ OR: [{ provider: { name: { contains: q, mode: 'insensitive' } } }, { customer: { name: { contains: q, mode: 'insensitive' } } }] }),
  sort: { createdAt: 'createdAt', updatedAt: 'updatedAt', validFrom: 'validFrom', status: 'status' },
  defaultSort: 'createdAt',
  defaultOrder: 'desc',
  status: (active) => (active ? { status: 'ACTIVE' } : { status: { not: 'ACTIVE' } }),
};

const CSV: CsvSpec<TransportAgreementDto> = {
  name: 'transport-agreements',
  columns: [
    { header: 'Provider', value: (a) => a.providerCompanyName },
    { header: 'Customer', value: (a) => a.customerCompanyName },
    { header: 'Status', value: (a) => a.status },
    { header: 'Valid from', value: (a) => a.validFrom },
    { header: 'Valid to', value: (a) => a.validTo ?? '' },
    { header: 'Grants', value: (a) => a.grants.join(' ') },
    { header: 'Sites', value: (a) => a.siteIds.length },
    { header: 'Data profile', value: (a) => a.dataProfile },
    { header: 'Created', value: (a) => a.createdAt },
  ],
};

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Which party the caller acts for, PLATFORM for the Super Admin when not a party, null when it may not see the row. */
export function agreementActor(ctx: Pick<AuthContext, 'companyId' | 'isSuperAdmin'>, row: { providerCompanyId: string; customerCompanyId: string }): AgreementActor | null {
  if (row.customerCompanyId === ctx.companyId) return 'CUSTOMER';
  if (row.providerCompanyId === ctx.companyId) return 'PROVIDER';
  return ctx.isSuperAdmin ? 'PLATFORM' : null;
}

/**
 * Agreements visible to the caller: the Super Admin in its own (platform) company sees all (PLAT); everyone else (and the
 * Super Admin switched into a company) only those where the acting company is a party.
 */
export function agreementVisibilityWhere(ctx: Pick<AuthContext, 'companyId' | 'homeCompanyId' | 'isSuperAdmin'>): Prisma.TransportServiceAgreementWhereInput {
  if (ctx.isSuperAdmin && ctx.companyId === ctx.homeCompanyId) return {};
  return { OR: [{ providerCompanyId: ctx.companyId }, { customerCompanyId: ctx.companyId }] };
}

export function toAgreementDto(r: Row, actor: AgreementActor | null, now: Date = new Date()): TransportAgreementDto {
  return {
    id: r.id,
    version: r.version,
    status: r.status,
    providerCompanyId: r.providerCompanyId,
    providerCompanyName: r.provider.name,
    customerCompanyId: r.customerCompanyId,
    customerCompanyName: r.customer.name,
    validFrom: r.validFrom.toISOString(),
    validTo: iso(r.validTo),
    grants: [...r.grants],
    siteIds: [...r.siteIds],
    dataProfile: r.dataProfile,
    approvedByCustomerAt: iso(r.approvedByCustomerAt),
    approvedByCustomerUserId: r.approvedByCustomerUserId,
    approvedByProviderAt: iso(r.approvedByProviderAt),
    approvedByProviderUserId: r.approvedByProviderUserId,
    suspendedAt: iso(r.suspendedAt),
    endedAt: iso(r.endedAt),
    statusReason: r.statusReason,
    inForce: agreementInForce(r, now),
    side: actor === 'PLATFORM' ? null : actor,
    allowedActions: actor ? agreementActions(r, actor) : [],
    createdById: r.createdById,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const err = (code: string, message: string) => ({ message, code });
const invalidState = (message: string) => new ConflictException(err('INVALID_STATE', message));
const invalid = (message: string) => new BadRequestException(err('VALIDATION_FAILED', message));
const ACTORS: AgreementActor[] = ['PROVIDER', 'CUSTOMER', 'PLATFORM'];

/**
 * ETMS service agreements (D1, P1; docs 05 §2.1, 10 §2.2, 15 §3.1). Create = DRAFT; PATCH while DRAFT; propose freezes
 * the terms; each side approves its own side, ACTIVE once both did; the customer (or the Super Admin) suspends / resumes;
 * either party (or the Super Admin) ends. Every change is compare-and-set on `version` and audited in the same
 * transaction; status changes publish a cache invalidation so long-lived contexts reload ctx.agreements.
 */
@Injectable()
export class AgreementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  async list(ctx: AuthContext, query: AgreementListQuery) {
    const plan = planList<Prisma.TransportServiceAgreementWhereInput, Prisma.TransportServiceAgreementOrderByWithRelationInput>(query, LIST);
    const filters: Prisma.TransportServiceAgreementWhereInput[] = [agreementVisibilityWhere(ctx), plan.where];
    if (query.agreementStatus) filters.push({ status: query.agreementStatus });
    if (query.side === 'PROVIDER') filters.push({ providerCompanyId: ctx.companyId });
    if (query.side === 'CUSTOMER') filters.push({ customerCompanyId: ctx.companyId });
    const where: Prisma.TransportServiceAgreementWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.transportServiceAgreement.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: INCLUDE }),
      this.prisma.transportServiceAgreement.count({ where }),
    ]);
    const now = new Date();
    return listResult(plan, rows.map((r) => toAgreementDto(r, agreementActor(ctx, r), now)), total, CSV);
  }

  async get(ctx: AuthContext, id: string): Promise<TransportAgreementDto> {
    const row = await this.find(ctx, id);
    return toAgreementDto(row, agreementActor(ctx, row));
  }

  async create(ctx: AuthContext, dto: CreateAgreementDto): Promise<TransportAgreementDto> {
    if (dto.providerCompanyId === dto.customerCompanyId) throw invalid('Provider and customer must be different companies (a company that runs its own transport needs no agreement)');
    if (!ctx.isSuperAdmin && ctx.companyId !== dto.providerCompanyId && ctx.companyId !== dto.customerCompanyId) {
      throw new ForbiddenException(err('FORBIDDEN_GRANT', 'You can only create agreements your company is a party to'));
    }
    const { validFrom, validTo } = this.validity(dto.validFrom, dto.validTo ?? null);
    await this.assertParties(dto.providerCompanyId, dto.customerCompanyId);
    const siteIds = await this.checkSites(dto.customerCompanyId, dto.siteIds ?? []);
    await this.assertNoLivePair(dto.providerCompanyId, dto.customerCompanyId);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.transportServiceAgreement
        .create({
          data: {
            providerCompanyId: dto.providerCompanyId,
            customerCompanyId: dto.customerCompanyId,
            validFrom,
            validTo,
            grants: dto.grants,
            siteIds,
            dataProfile: dto.dataProfile ?? 'MINIMAL',
            createdById: ctx.userId,
          },
          include: INCLUDE,
        })
        .catch((e: unknown) => {
          throw this.duplicateOr(e);
        });
      await this.audit.record(ctx, { action: 'CREATE', entity: AGREEMENT_ENTITY, entityId: created.id, after: snapshot(created) }, tx);
      return created;
    });
    return toAgreementDto(row, agreementActor(ctx, row));
  }

  async update(ctx: AuthContext, id: string, dto: UpdateAgreementDto): Promise<TransportAgreementDto> {
    const before = await this.find(ctx, id);
    this.authorise(ctx, before, 'edit', dto.expectedVersion);
    const { validFrom, validTo } = this.validity(dto.validFrom ?? before.validFrom.toISOString(), dto.validTo === undefined ? (before.validTo?.toISOString() ?? null) : dto.validTo);
    const siteIds = dto.siteIds ? await this.checkSites(before.customerCompanyId, dto.siteIds) : undefined;
    return this.write(ctx, before, {
      validFrom,
      validTo,
      ...(dto.grants ? { grants: dto.grants } : {}),
      ...(siteIds ? { siteIds } : {}),
      ...(dto.dataProfile ? { dataProfile: dto.dataProfile } : {}),
    }, false);
  }

  async propose(ctx: AuthContext, id: string, expectedVersion?: number): Promise<TransportAgreementDto> {
    const before = await this.find(ctx, id);
    const actor = this.authorise(ctx, before, 'propose', expectedVersion);
    if (!before.grants.length) throw invalid('Choose at least one grant before proposing the agreement');
    if (before.validTo && before.validTo <= new Date()) throw invalid('The agreement would already be over: change "valid to" first');
    return this.write(ctx, before, { status: nextAgreementStatus(before, 'propose', actor) }, true);
  }

  async approve(ctx: AuthContext, id: string, expectedVersion?: number): Promise<TransportAgreementDto> {
    const before = await this.find(ctx, id);
    const actor = this.authorise(ctx, before, 'approve', expectedVersion);
    const now = new Date();
    const status = nextAgreementStatus(before, 'approve', actor);
    const side = actor === 'CUSTOMER' ? { approvedByCustomerAt: now, approvedByCustomerUserId: ctx.userId } : { approvedByProviderAt: now, approvedByProviderUserId: ctx.userId };
    return this.write(ctx, before, { status, ...side }, status !== before.status);
  }

  async suspend(ctx: AuthContext, id: string, reason: string, expectedVersion?: number): Promise<TransportAgreementDto> {
    const before = await this.find(ctx, id);
    const actor = this.authorise(ctx, before, 'suspend', expectedVersion);
    return this.write(ctx, before, { status: nextAgreementStatus(before, 'suspend', actor), suspendedAt: new Date(), statusReason: reason.trim() }, true);
  }

  async resume(ctx: AuthContext, id: string, expectedVersion?: number): Promise<TransportAgreementDto> {
    const before = await this.find(ctx, id);
    const actor = this.authorise(ctx, before, 'resume', expectedVersion);
    return this.write(ctx, before, { status: nextAgreementStatus(before, 'resume', actor), suspendedAt: null, statusReason: null }, true);
  }

  async end(ctx: AuthContext, id: string, reason: string, expectedVersion?: number): Promise<TransportAgreementDto> {
    const before = await this.find(ctx, id);
    const actor = this.authorise(ctx, before, 'end', expectedVersion);
    return this.write(ctx, before, { status: nextAgreementStatus(before, 'end', actor), endedAt: new Date(), statusReason: reason.trim() }, true);
  }

  // ───────────────────────────── internals ─────────────────────────────

  /** The row if the caller may see it; other tenants' ids are 404 (no enumeration). */
  private async find(ctx: AuthContext, id: string): Promise<Row> {
    const row = await this.prisma.transportServiceAgreement.findFirst({ where: { AND: [{ id }, agreementVisibilityWhere(ctx)] }, include: INCLUDE });
    if (!row) throw transportNotFound('Agreement not found');
    return row;
  }

  /**
   * Version check first, then the state machine: 409 INVALID_STATE when no one may run the command in this status (or the
   * caller's side already approved), 403 FORBIDDEN_GRANT when the status allows it but not for the caller's side.
   */
  private authorise(ctx: AuthContext, row: Row, cmd: TransportAgreementAction, expectedVersion?: number): AgreementActor {
    if (expectedVersion !== undefined && expectedVersion !== row.version) {
      throw new ConflictException({ message: 'The agreement was changed by someone else; reload it', code: 'VERSION_CONFLICT', currentVersion: row.version });
    }
    const actor = agreementActor(ctx, row);
    if (!actor) throw transportNotFound('Agreement not found');
    if (agreementActions(row, actor).includes(cmd)) return actor;
    if (cmd === 'approve' && row.status === 'PROPOSED' && actor !== 'PLATFORM') throw invalidState('Your side has already approved this agreement');
    if (ACTORS.some((a) => agreementActions(row, a).includes(cmd))) {
      const who = cmd === 'approve' ? 'Only the two parties approve an agreement' : cmd === 'suspend' || cmd === 'resume' ? 'Only the customer can suspend or resume an agreement' : 'Not allowed';
      throw new ForbiddenException(err('FORBIDDEN_GRANT', who));
    }
    throw invalidState(`Cannot ${cmd} an agreement that is ${row.status.toLowerCase()}`);
  }

  /** Compare-and-set on (id, version, status) + audit in one transaction. */
  private async write(ctx: AuthContext, before: Row, data: Prisma.TransportServiceAgreementUncheckedUpdateManyInput, statusChanged: boolean): Promise<TransportAgreementDto> {
    const row = await this.prisma.$transaction(async (tx) => {
      const res = await tx.transportServiceAgreement
        .updateMany({ where: { id: before.id, version: before.version, status: before.status }, data: { ...data, version: { increment: 1 } } })
        .catch((e: unknown) => {
          throw this.duplicateOr(e);
        });
      if (res.count !== 1) throw new ConflictException({ message: 'The agreement was changed by someone else; reload it', code: 'VERSION_CONFLICT' });
      const after = await tx.transportServiceAgreement.findUniqueOrThrow({ where: { id: before.id }, include: INCLUDE });
      await this.audit.record(ctx, { action: 'UPDATE', entity: AGREEMENT_ENTITY, entityId: before.id, before: snapshot(before), after: snapshot(after) }, tx);
      return after;
    });
    if (statusChanged) await this.redis.invalidateCache('transport-agreement').catch(() => undefined);
    return toAgreementDto(row, agreementActor(ctx, row));
  }

  private validity(fromRaw: string, toRaw: string | null): { validFrom: Date; validTo: Date | null } {
    const validFrom = new Date(fromRaw);
    const validTo = toRaw === null ? null : new Date(toRaw);
    if (Number.isNaN(validFrom.getTime()) || (validTo && Number.isNaN(validTo.getTime()))) throw invalid('Invalid date');
    if (validTo && validTo <= validFrom) throw invalid('"Valid to" must be after "valid from"');
    return { validFrom, validTo };
  }

  /** Both parties are existing business companies (never the platform company, never personal accounts). */
  private async assertParties(providerId: string, customerId: string): Promise<void> {
    const rows = await this.prisma.company.findMany({ where: { id: { in: [providerId, customerId] } }, select: { id: true, isPlatform: true, accountType: true } });
    for (const id of [providerId, customerId]) {
      const c = rows.find((r) => r.id === id);
      if (!c) throw transportNotFound('Company not found');
      if (c.isPlatform || c.accountType !== 'BUSINESS') throw invalid('Agreements are only between business companies');
    }
  }

  /** Site ids must be active Pois of the customer company. */
  private async checkSites(customerId: string, siteIds: string[]): Promise<string[]> {
    if (!siteIds.length) return [];
    const found = await this.prisma.poi.count({ where: { id: { in: siteIds }, companyId: customerId, isActive: true } });
    if (found !== new Set(siteIds).size) throw invalid('Every site must be an active place of the customer company');
    return [...new Set(siteIds)];
  }

  private async assertNoLivePair(providerId: string, customerId: string): Promise<void> {
    const live = await this.prisma.transportServiceAgreement.count({ where: { providerCompanyId: providerId, customerCompanyId: customerId, status: { in: ['DRAFT', 'PROPOSED', 'ACTIVE', 'SUSPENDED'] } } });
    if (live) throw new ConflictException(err('AGREEMENT_DUPLICATE', 'These two companies already have an open agreement; end it before creating a new one'));
  }

  /** The live-pair partial unique index (race between two creates) → 409 AGREEMENT_DUPLICATE. */
  private duplicateOr(e: unknown): unknown {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return new ConflictException(err('AGREEMENT_DUPLICATE', 'These two companies already have an open agreement; end it before creating a new one'));
    }
    return e;
  }
}

function snapshot(r: Row): Record<string, unknown> {
  const { provider, customer, ...rest } = r;
  void provider;
  void customer;
  return rest;
}
