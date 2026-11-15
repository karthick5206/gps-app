import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { BillingRunDto, BillingRunKind, BillingRunStatus } from '@veetracer/shared';
import { randomUUID } from 'crypto';
import type { AuthContext } from '../access/auth-context';
import { requestHash } from '../etms/dispatch/e3-common';
import { PrismaService } from '../prisma/prisma.service';
import { asJson, conflict, isoOf, pricingError, ymd } from './pricing-common';

type RunRow = Prisma.BillingRunGetPayload<object>;
/** A CLAIMED / RUNNING run older than this is considered abandoned (crashed instance) and may be re-claimed. */
export const RUN_STALE_MINUTES = 15;

export function runDto(r: RunRow): BillingRunDto {
  return {
    id: r.id,
    contractId: r.contractId,
    kind: r.kind as BillingRunKind,
    periodStart: ymd(r.periodStart),
    periodEnd: ymd(r.periodEnd),
    status: r.status as BillingRunStatus,
    startedAt: r.startedAt.toISOString(),
    finishedAt: isoOf(r.finishedAt),
    stats: (r.stats ?? {}) as Record<string, unknown>,
    error: r.error,
  };
}

/**
 * Doc 19 §5.8 billing-run claim: the BillingRun row, unique per (company, contract, kind, periodStart), IS the
 * idempotency claim of the scheduled job and of the manual close / generate. `INSERT … ON CONFLICT DO UPDATE … WHERE
 * status = 'FAILED' (or stale)` is the row CAS: of two concurrent runs exactly one gets the row back; the other sees
 * BILLING_RUN_IN_PROGRESS, or (once DONE) a replay when it sent the same Idempotency-Key and body.
 */
@Injectable()
export class BillingRunsService {
  private readonly instance = `api:${randomUUID().slice(0, 8)}`;

  constructor(private readonly prisma: PrismaService) {}

  async claim(
    ctx: AuthContext,
    p: { contractId: string; kind: BillingRunKind; periodStart: string; periodEnd: string; key: string | null; body: unknown },
  ): Promise<{ run: RunRow; replay: boolean }> {
    const hash = requestHash(p.body);
    const by = ctx.userId ? `user:${ctx.userId}` : `job:${this.instance}`;
    const rows = await this.prisma.$queryRaw<RunRow[]>`
      INSERT INTO "BillingRun" ("id", "companyId", "contractId", "kind", "periodStart", "periodEnd", "status", "claimedBy", "idempotencyKey", "requestHash", "startedAt", "stats")
      VALUES (gen_random_uuid(), ${ctx.companyId}::uuid, ${p.contractId}::uuid, ${p.kind}, ${p.periodStart}::date, ${p.periodEnd}::date, 'CLAIMED', ${by}, ${p.key}, ${hash}, now(), '{}')
      ON CONFLICT ("companyId", "contractId", "kind", "periodStart") DO UPDATE
        SET "status" = 'CLAIMED', "claimedBy" = EXCLUDED."claimedBy", "idempotencyKey" = EXCLUDED."idempotencyKey", "requestHash" = EXCLUDED."requestHash",
            "periodEnd" = EXCLUDED."periodEnd", "startedAt" = now(), "finishedAt" = NULL, "error" = NULL, "stats" = '{}'
        WHERE "BillingRun"."status" = 'FAILED'
           OR ("BillingRun"."status" IN ('CLAIMED', 'RUNNING') AND "BillingRun"."startedAt" < now() - make_interval(mins => ${RUN_STALE_MINUTES}))
      RETURNING *`;
    if (rows.length) return { run: rows[0], replay: false };
    const existing = await this.prisma.billingRun.findUniqueOrThrow({ where: { companyId_contractId_kind_periodStart: { companyId: ctx.companyId, contractId: p.contractId, kind: p.kind, periodStart: new Date(`${p.periodStart}T00:00:00Z`) } } });
    if (existing.status === 'DONE') {
      if (p.key && existing.idempotencyKey === p.key) {
        if (existing.requestHash !== hash) throw pricingError(HttpStatus.UNPROCESSABLE_ENTITY, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
        return { run: existing, replay: true };
      }
      throw conflict('BILLING_RUN_DONE', `This ${p.kind === 'INVOICE' ? 'invoice run' : 'period close'} was already done for ${p.periodStart}`, { runId: existing.id });
    }
    throw conflict('BILLING_RUN_IN_PROGRESS', 'A billing run for this contract and period is in progress', { runId: existing.id });
  }

  async finish(id: string, status: 'DONE' | 'FAILED', stats: Record<string, unknown>, error: string | null = null): Promise<RunRow> {
    return this.prisma.billingRun.update({ where: { id }, data: { status, stats: asJson(stats), error: error ? error.slice(0, 500) : null, finishedAt: new Date() } });
  }

  async list(ctx: AuthContext, contractId?: string): Promise<BillingRunDto[]> {
    const rows = await this.prisma.billingRun.findMany({ where: { companyId: ctx.companyId, ...(contractId ? { contractId } : {}) }, orderBy: { startedAt: 'desc' }, take: 200 });
    return rows.map(runDto);
  }
}
