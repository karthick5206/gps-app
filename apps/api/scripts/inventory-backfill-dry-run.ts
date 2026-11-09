/**
 * Inventory B4 — backfill DRY RUN. Reads every Device (read-only) and prints the DeviceStock row + SYNC movement each
 * legacy device would get, derived from its existing company / vehicle assignment. It never writes: there is no apply
 * mode. Applying a backfill requires owner approval and a separate, reviewed change (PHASE_B.md §B4).
 *
 *   npx tsx scripts/inventory-backfill-dry-run.ts [--location WH1] [--csv out.csv]
 *
 * Uses DATABASE_URL (run it against a scratch / staging copy, not production, until the owner approves).
 */
import { writeFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';
import { toCsv } from '../src/common/csv';
import { BackfillRow, planBackfill } from '../src/inventory/backfill-plan';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main(): Promise<void> {
  if (process.argv.includes('--apply')) throw new Error('This script is a dry run only; applying needs owner approval and a separate change.');
  const prisma = new PrismaClient();
  try {
    const location = arg('location');
    if (location && !(await prisma.stockLocation.findFirst({ where: { code: location, ownerPartnerId: null }, select: { id: true } }))) {
      console.warn(`! Location code ${location} does not exist yet (it would have to be created first).`);
    }
    const devices = await prisma.device.findMany({
      orderBy: { uniqueId: 'asc' },
      select: {
        id: true,
        uniqueId: true,
        companyId: true,
        isActive: true,
        shippedAt: true,
        claimedAt: true,
        createdAt: true,
        company: { select: { name: true } },
        stock: { select: { deviceId: true } },
        assignments: { where: { toTime: null }, select: { object: { select: { id: true, name: true } } }, take: 1 },
      },
    });
    const plan = planBackfill(
      devices.map((d) => ({
        id: d.id,
        uniqueId: d.uniqueId,
        companyId: d.companyId,
        companyName: d.company?.name ?? null,
        isActive: d.isActive,
        shippedAt: d.shippedAt,
        claimedAt: d.claimedAt,
        openObjectId: d.assignments[0]?.object.id ?? null,
        openObjectName: d.assignments[0]?.object.name ?? null,
        hasStock: !!d.stock,
        createdAt: d.createdAt,
      })),
      { stockLocationCode: location },
    );
    console.log(JSON.stringify({ devices: devices.length, skipped: plan.skipped, byStatus: plan.byStatus, wouldInsert: plan.wouldInsert, warnings: plan.warnings }, null, 2));
    const csvPath = arg('csv');
    if (csvPath) {
      writeFileSync(
        csvPath,
        toCsv<BackfillRow>(plan.rows, [
          { header: 'Device id', value: (r) => r.deviceId },
          { header: 'IMEI / Unique ID', value: (r) => r.uniqueId },
          { header: 'Proposed status', value: (r) => r.status },
          { header: 'Proposed location', value: (r) => r.locationCode },
          { header: 'Customer', value: (r) => r.companyName },
          { header: 'Vehicle', value: (r) => r.objectName },
          { header: 'Notes', value: (r) => r.notes.join('; ') },
        ]),
      );
      console.log(`Wrote ${plan.rows.length} rows to ${csvPath}`);
    } else {
      for (const r of plan.rows.slice(0, 20)) console.log(`${r.uniqueId}\t${r.status}\t${r.locationCode ?? '-'}\t${r.companyName ?? 'platform stock'}\t${r.objectName ?? ''}\t${r.notes.join('; ')}`);
      if (plan.rows.length > 20) console.log(`… ${plan.rows.length - 20} more (use --csv file.csv)`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
