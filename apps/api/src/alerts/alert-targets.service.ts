import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AlertLevel } from '@veetracer/shared';
import { branchScopeWhere, objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';

export const targetKey = (level: string, targetId: string) => `${level}:${targetId}`;

/**
 * Level/target checks shared by alert settings, recipient lists, snoozes and packs.
 * Reading: any target in the caller's scope. Writing: COMPANY and GROUP levels need COMPANY data scope;
 * ASSIGNED-scope callers may write their own branches and objects in scope.
 */
@Injectable()
export class AlertTargetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async assertTarget(ctx: AuthContext, level: AlertLevel, targetId: string, write: boolean): Promise<string> {
    switch (level) {
      case 'COMPANY': {
        if (targetId !== ctx.companyId) throw new BadRequestException('Company-level target must be your company');
        if (write && ctx.dataScope !== 'COMPANY') throw new ForbiddenException('Company-level settings need company-wide access');
        const c = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { name: true } });
        return c.name;
      }
      case 'BRANCH': {
        const b = await this.prisma.branch.findFirst({ where: { AND: [branchScopeWhere(ctx), { id: targetId }] }, select: { name: true } });
        if (!b) throw new NotFoundException('Branch not found');
        return b.name;
      }
      case 'GROUP': {
        const g = await this.prisma.vehicleGroup.findFirst({ where: { id: targetId, companyId: ctx.companyId }, select: { name: true } });
        if (!g) throw new NotFoundException('Vehicle group not found');
        if (write && ctx.dataScope !== 'COMPANY') throw new ForbiddenException('Group-level settings need company-wide access');
        return g.name;
      }
      case 'OBJECT': {
        const o = await this.prisma.trackedObject.findFirst({ where: { AND: [objectScopeWhere(ctx), { id: targetId }] }, select: { name: true } });
        if (!o) throw new NotFoundException('Object not found');
        return o.name;
      }
      default:
        throw new BadRequestException('Unknown level');
    }
  }

  async assertObject(ctx: AuthContext, objectId: string) {
    const o = await this.prisma.trackedObject.findFirst({
      where: { AND: [objectScopeWhere(ctx), { id: objectId }] },
      select: { id: true, name: true, branchId: true, companyId: true, plateNumber: true },
    });
    if (!o) throw new NotFoundException('Object not found');
    return o;
  }

  /** Display names for many level/target pairs (unknown → '(deleted)'). */
  async names(companyId: string, pairs: { level: string; targetId: string }[]): Promise<Map<string, string>> {
    const ids = (level: string) => [...new Set(pairs.filter((p) => p.level === level).map((p) => p.targetId))];
    const [companies, branches, groups, objects] = await Promise.all([
      ids('COMPANY').length ? this.prisma.company.findMany({ where: { id: { in: ids('COMPANY') } }, select: { id: true, name: true } }) : [],
      ids('BRANCH').length ? this.prisma.branch.findMany({ where: { companyId, id: { in: ids('BRANCH') } }, select: { id: true, name: true } }) : [],
      ids('GROUP').length ? this.prisma.vehicleGroup.findMany({ where: { companyId, id: { in: ids('GROUP') } }, select: { id: true, name: true } }) : [],
      ids('OBJECT').length ? this.prisma.trackedObject.findMany({ where: { companyId, id: { in: ids('OBJECT') } }, select: { id: true, name: true } }) : [],
    ]);
    const out = new Map<string, string>();
    for (const c of companies) out.set(targetKey('COMPANY', c.id), c.name);
    for (const b of branches) out.set(targetKey('BRANCH', b.id), b.name);
    for (const g of groups) out.set(targetKey('GROUP', g.id), g.name);
    for (const o of objects) out.set(targetKey('OBJECT', o.id), o.name);
    for (const p of pairs) if (!out.has(targetKey(p.level, p.targetId))) out.set(targetKey(p.level, p.targetId), '(deleted)');
    return out;
  }

  /** Tell the processor/notifier that alert settings, geofences, snoozes or templates of a company changed. */
  async invalidate(companyId: string, reason: string): Promise<void> {
    await this.redis.client.publish(RedisKeys.rulesInvalidate, JSON.stringify({ companyId, reason, at: Date.now() }));
  }
}
