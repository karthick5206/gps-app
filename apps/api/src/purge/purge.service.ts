import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PurgePreviewDto } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { Catalog, countSql, FkEdge, planPurge, PlanStep, PURGE_TABLE, PurgeKind, rootCondition, stepSql } from './purge-plan';

const CATALOG_TTL_MS = 10 * 60_000;
/** A whole company can be millions of rows: give the transaction time. */
const TX_TIMEOUT_MS = 30 * 60_000;

interface Target {
  label: string;
  /** What the Super Admin must type to confirm. */
  confirm: string;
  objectIds: string[];
  companyIds: string[];
}

/** Super Admin "Delete permanently": a device, vehicle/person, user or company with everything that belongs to it. */
@Injectable()
export class PurgeService {
  private readonly logger = new Logger(PurgeService.name);
  private catalog: { at: number; value: Catalog } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  async preview(ctx: AuthContext, kind: PurgeKind, id: string): Promise<PurgePreviewDto> {
    const target = await this.target(ctx, kind, id);
    const steps = await this.steps(kind, id);
    const counts = new Map<string, number>();
    for (const s of steps) {
      if (s.nullCol) continue;
      const [row] = await this.prisma.$queryRawUnsafe<{ n: bigint }[]>(countSql(s));
      const n = Number(row?.n ?? 0);
      if (n) counts.set(s.table, (counts.get(s.table) ?? 0) + n);
    }
    const rows = [...counts.entries()].map(([table, n]) => ({ table, rows: n })).sort((a, b) => b.rows - a.rows);
    return { kind, id, label: target.label, confirm: target.confirm, tables: rows, totalRows: rows.reduce((a, r) => a + r.rows, 0) };
  }

  async purge(ctx: AuthContext, kind: PurgeKind, id: string, confirm: string): Promise<{ ok: true; deletedRows: number }> {
    const target = await this.target(ctx, kind, id);
    if (confirm.trim().toLowerCase() !== target.confirm.trim().toLowerCase()) throw new BadRequestException(`Type "${target.confirm}" to confirm`);
    const steps = await this.steps(kind, id);
    const extra = await this.extraStatements(kind, id);
    const started = Date.now();
    let deletedRows = 0;
    await this.prisma.$transaction(
      async (tx) => {
        for (const sql of [...extra, ...steps.map(stepSql)]) deletedRows += await tx.$executeRawUnsafe(sql);
      },
      { timeout: TX_TIMEOUT_MS, maxWait: 10_000 },
    );
    await this.clearLive(target);
    await this.audit.recordSystem(
      { companyId: ctx.homeCompanyId, userId: ctx.userId, ip: ctx.ip },
      { action: 'DELETE', entity: kind, entityId: id, details: { permanent: true, label: target.label, deletedRows, ms: Date.now() - started } },
    );
    this.logger.warn(`PURGE ${kind} ${id} (${target.label}) by ${ctx.userId}: ${deletedRows} rows in ${Date.now() - started} ms`);
    return { ok: true, deletedRows };
  }

  // ───────────── helpers ─────────────

  private async steps(kind: PurgeKind, id: string): Promise<PlanStep[]> {
    return planPurge(await this.loadCatalog(), PURGE_TABLE[kind], rootCondition(id));
  }

  /** Links the catalogue can't see: raw packets by IMEI, data-forwarding targets listing the device ids. */
  private async extraStatements(kind: PurgeKind, id: string): Promise<string[]> {
    const devices =
      kind === 'device'
        ? `SELECT "id", "uniqueId" FROM "Device" WHERE ${rootCondition(id)}`
        : kind === 'company'
          ? `SELECT "id", "uniqueId" FROM "Device" WHERE "companyId" IN (SELECT "id" FROM "Company" WHERE ${rootCondition(id)})`
          : null;
    if (!devices) return [];
    return [
      `DELETE FROM "RawPacket" WHERE "uniqueId" IN (SELECT "uniqueId" FROM (${devices}) d)`,
      `UPDATE "RelayTarget" SET "deviceIds" = ARRAY(SELECT x FROM unnest("deviceIds") x WHERE x NOT IN (SELECT "id" FROM (${devices}) d)) WHERE "deviceIds" && ARRAY(SELECT "id" FROM (${devices}) d)`,
    ];
  }

  private async target(ctx: AuthContext, kind: PurgeKind, id: string): Promise<Target> {
    if (!ctx.isSuperAdmin) throw new ForbiddenException('Only Super Admin can delete permanently');
    rootCondition(id);
    switch (kind) {
      case 'device': {
        const d = await this.prisma.device.findUnique({ where: { id }, select: { uniqueId: true, companyId: true, model: { select: { brand: true, model: true } }, assignments: { select: { objectId: true } } } });
        if (!d) throw new NotFoundException('Device not found');
        return { label: `${d.uniqueId} · ${d.model.brand} ${d.model.model}`, confirm: d.uniqueId, objectIds: [...new Set(d.assignments.map((a) => a.objectId))], companyIds: d.companyId ? [d.companyId] : [] };
      }
      case 'object': {
        const o = await this.prisma.trackedObject.findUnique({ where: { id }, select: { name: true, plateNumber: true, companyId: true } });
        if (!o) throw new NotFoundException('Vehicle / object not found');
        return { label: o.plateNumber ? `${o.name} (${o.plateNumber})` : o.name, confirm: o.name, objectIds: [id], companyIds: [o.companyId] };
      }
      case 'user': {
        const u = await this.prisma.user.findUnique({ where: { id }, select: { name: true, email: true, mobile: true, isSuperAdmin: true } });
        if (!u) throw new NotFoundException('User not found');
        if (id === ctx.userId) throw new ForbiddenException("You can't delete your own account");
        if (u.isSuperAdmin) throw new ForbiddenException("A Super Admin account can't be deleted here");
        return { label: `${u.name} · ${u.email ?? u.mobile ?? ''}`, confirm: u.email ?? u.mobile ?? u.name, objectIds: [], companyIds: [] };
      }
      case 'company': {
        const c = await this.prisma.company.findUnique({ where: { id }, select: { name: true } });
        if (!c) throw new NotFoundException('Company not found');
        if (id === ctx.homeCompanyId) throw new ForbiddenException("The platform company can't be deleted");
        if (await this.prisma.user.count({ where: { companyId: id, isSuperAdmin: true } })) throw new ForbiddenException('This company has a Super Admin account');
        const objects = await this.prisma.trackedObject.findMany({ where: { companyId: id }, select: { id: true } });
        return { label: c.name, confirm: c.name, objectIds: objects.map((o) => o.id), companyIds: [id] };
      }
    }
  }

  /** Live map / processor state of removed objects, and the caches that list devices, objects and users. */
  private async clearLive(target: Target): Promise<void> {
    try {
      const pipeline = this.redis.client.pipeline();
      for (const objectId of target.objectIds) {
        pipeline.del(RedisKeys.live(objectId), RedisKeys.track(objectId));
        for (const companyId of target.companyIds) pipeline.srem(RedisKeys.liveCompany(companyId), objectId);
      }
      await pipeline.exec();
      for (const reason of ['device', 'object', 'user', 'company']) await this.redis.invalidateCache(reason);
    } catch (e) {
      this.logger.warn(`Purge: live state cleanup failed: ${(e as Error).message}`);
    }
  }

  private async loadCatalog(): Promise<Catalog> {
    if (this.catalog && Date.now() - this.catalog.at < CATALOG_TTL_MS) return this.catalog.value;
    const fks = await this.prisma.$queryRawUnsafe<FkEdge[]>(`
      SELECT c.relname AS child, a.attname AS col, p.relname AS parent, pa.attname AS "refCol", con.confdeltype::text AS del
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_class p ON p.oid = con.confrelid
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
      WHERE con.contype = 'f' AND n.nspname = 'public'`);
    const cols = await this.prisma.$queryRawUnsafe<{ table: string; column: string }[]>(`
      SELECT c.table_name AS "table", c.column_name AS "column" FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.table_name <> '_prisma_migrations'`);
    const columns = new Map<string, Set<string>>();
    for (const { table, column } of cols) (columns.get(table) ?? columns.set(table, new Set()).get(table)!).add(column);
    this.catalog = { at: Date.now(), value: { fks, columns } };
    return this.catalog.value;
  }
}
