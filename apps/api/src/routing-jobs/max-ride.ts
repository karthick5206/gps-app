import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { canOverrideMaxRide, isMaxRideS, MAX_RIDE_BOUNDS_S, MAX_RIDE_REASON_LENGTH, transportSettingsOf, type MaxRideOverrideInput, type MaxRideSource, type RoutePlanMaxRide } from '@veetracer/shared';
import { IsInt, IsString, Max, MaxLength, Min } from 'class-validator';
import type { AuthContext } from '../access/auth-context';
import type { AuditService } from '../audit/audit.service';

/**
 * Owner decision 1 (2026-11-11, E4 T1-D4): maximum ride time = company policy with an authorised, audited per-plan
 * override. Everything lives in JSON that already exists (no schema change):
 * - policy: `Company.settings.etms.maxRideS` (transport settings; absent = no limit);
 * - override: `RoutePlan.options.maxRideOverride` = { maxRideS, reason, setById, setAt }, set on create / optimise by a
 *   caller with etms_settings:edit and whole-company scope (canOverrideMaxRide), kept by every later optimise until
 *   changed or cleared (null), each change audited (entity RoutePlan: old / new value, reason, actor);
 * - snapshot: at every optimise reservation `RoutePlan.options.maxRideS` (what the solver reads, PlanInputs.maxRideS)
 *   and `maxRideSource` (override | policy | none) are written from the override, else the policy at that moment, so
 *   the plan's result can be reproduced whatever the policy becomes later.
 */

/** Body field `maxRideOverride` (create, optimise, the optimise alias). */
export class MaxRideOverrideDto implements MaxRideOverrideInput {
  @IsInt() @Min(MAX_RIDE_BOUNDS_S.min) @Max(MAX_RIDE_BOUNDS_S.max) maxRideS!: number;
  @IsString() @MaxLength(MAX_RIDE_REASON_LENGTH.max) reason!: string;
}

export const MAX_RIDE_AUDIT_ENTITY = 'RoutePlan';

/** The override as stored on the plan. */
export interface StoredMaxRideOverride {
  maxRideS: number;
  reason: string;
  setById: string | null;
  setAt: string;
}

const invalid = (message: string) => new BadRequestException({ message, code: 'VALIDATION_FAILED' });

/**
 * Checks a requested override (undefined = not named: the plan keeps what it has; null = clear; else set): only an
 * authorised caller (403 FORBIDDEN_GRANT), seconds within bounds and a reason (400 VALIDATION_FAILED). Returns it
 * normalised (reason trimmed). Also the service-level guard when the controller's validation pipe is not in play.
 */
export function checkMaxRideOverride(ctx: Pick<AuthContext, 'permissions' | 'dataScope'>, raw: unknown): MaxRideOverrideInput | null | undefined {
  if (raw === undefined) return undefined;
  if (!canOverrideMaxRide(ctx.permissions, ctx.dataScope)) {
    throw new ForbiddenException({ message: 'Only a user who may change the company transport settings (whole-company access) can override the maximum ride time of a plan', code: 'FORBIDDEN_GRANT' });
  }
  if (raw === null) return null;
  const o = raw as Partial<MaxRideOverrideInput>;
  if (!isMaxRideS(o.maxRideS)) throw invalid(`The maximum ride time must be whole seconds between ${MAX_RIDE_BOUNDS_S.min} and ${MAX_RIDE_BOUNDS_S.max} (15 min – 4 h)`);
  const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
  if (reason.length < MAX_RIDE_REASON_LENGTH.min || reason.length > MAX_RIDE_REASON_LENGTH.max) throw invalid('Give a reason for the maximum ride time override (3–300 characters)');
  return { maxRideS: o.maxRideS, reason };
}

export function storedOverrideOf(options: unknown): StoredMaxRideOverride | null {
  const o = options && typeof options === 'object' && !Array.isArray(options) ? (options as Record<string, unknown>).maxRideOverride : undefined;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const v = o as Record<string, unknown>;
  if (!isMaxRideS(v.maxRideS) || typeof v.reason !== 'string') return null;
  return { maxRideS: v.maxRideS, reason: v.reason, setById: typeof v.setById === 'string' ? v.setById : null, setAt: typeof v.setAt === 'string' ? v.setAt : '' };
}

/** Company policy now (seconds) or null (no limit). */
export async function maxRidePolicyOf(db: Pick<Prisma.TransactionClient, 'company'>, companyId: string): Promise<number | null> {
  const c = await db.company.findUnique({ where: { id: companyId }, select: { settings: true } });
  return transportSettingsOf(c?.settings).maxRideS ?? null;
}

/**
 * The plan options after an override request (undefined: unchanged), audited inside `tx` when it changes the value or
 * the reason. `via` names the endpoint for the audit entry.
 */
export async function withOverride(
  tx: Prisma.TransactionClient,
  audit: Pick<AuditService, 'record'>,
  ctx: AuthContext,
  plan: { id: string; options: Record<string, unknown>; version: number },
  request: MaxRideOverrideInput | null | undefined,
  via: 'create' | 'optimize',
  policyS: number | null,
): Promise<Record<string, unknown>> {
  if (request === undefined) return plan.options;
  const before = storedOverrideOf(plan.options);
  const next: StoredMaxRideOverride | null = request ? { maxRideS: request.maxRideS, reason: request.reason, setById: ctx.userId, setAt: new Date().toISOString() } : null;
  if ((before?.maxRideS ?? null) === (next?.maxRideS ?? null) && (before?.reason ?? null) === (next?.reason ?? null)) return plan.options;
  const options = { ...plan.options };
  if (next) options.maxRideOverride = next;
  else delete options.maxRideOverride;
  await audit.record(
    ctx,
    {
      action: 'UPDATE',
      entity: MAX_RIDE_AUDIT_ENTITY,
      entityId: plan.id,
      details: {
        maxRideOverride: { from: before?.maxRideS ?? null, to: next?.maxRideS ?? null },
        reason: next?.reason ?? null,
        ...(before && next && before.reason !== next.reason ? { previousReason: before.reason } : {}),
        policyS,
        via,
        version: plan.version,
      },
    },
    tx,
  );
  return options;
}

/**
 * E4 decisions review D-M1: the max ride a plan's checks use (route violations, publish warnings). Chosen rule: a plan
 * optimised under owner decision 1 carries a snapshot (`maxRideSource` set): its `maxRideS` — what the solver honoured,
 * and "none" stays none — so the checks judge the plan by the rule it was built with whatever the policy becomes later
 * (a re-optimise re-snapshots). A plan never optimised (built by hand) uses its override, else the company policy now.
 */
export function effectiveMaxRideS(options: unknown, policyS: number | null): number | null {
  const o = options && typeof options === 'object' && !Array.isArray(options) ? (options as Record<string, unknown>) : {};
  if (typeof o.maxRideSource === 'string' || o.maxRideS !== undefined) return isMaxRideS(o.maxRideS) ? o.maxRideS : null;
  return storedOverrideOf(o)?.maxRideS ?? (isMaxRideS(policyS) ? policyS : null);
}

/** The snapshot an optimisation runs with: override, else the policy, else none (no limit). */
export function maxRideSnapshot(options: Record<string, unknown>, policyS: number | null): Record<string, unknown> {
  const override = storedOverrideOf(options);
  const maxRideS = override?.maxRideS ?? policyS ?? null;
  const source: MaxRideSource = override ? 'override' : policyS ? 'policy' : 'none';
  const out: Record<string, unknown> = { ...options, maxRideSource: source };
  if (maxRideS) out.maxRideS = maxRideS;
  else delete out.maxRideS;
  return out;
}

/** RoutePlanDetailDto.maxRide from the plan options and the company policy now. */
export function maxRideView(options: unknown, policyS: number | null): RoutePlanMaxRide {
  const o = (options && typeof options === 'object' && !Array.isArray(options) ? options : {}) as Record<string, unknown>;
  const source = o.maxRideSource === 'override' || o.maxRideSource === 'policy' || o.maxRideSource === 'none' ? o.maxRideSource : null;
  return { appliedS: source && typeof o.maxRideS === 'number' && o.maxRideS > 0 ? o.maxRideS : null, appliedSource: source, policyS, override: storedOverrideOf(o) };
}
