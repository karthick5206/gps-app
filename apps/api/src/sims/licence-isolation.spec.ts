/**
 * Licence / device isolation (static) for SIM management: SIM code must never write Device rows (ingestion and the
 * tenant-visible SIM fields stay as they are), never write DeviceAssignment, never touch licence seats, invoices or
 * the company / transfer flows. The database-backed proof is sims.integration.spec.ts.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const DIR = __dirname;
const sources = readdirSync(DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
  .map((f) => ({ file: f, text: readFileSync(join(DIR, f), 'utf8') }));

describe('SIM licence isolation (source)', () => {
  it('has sources to check', () => {
    expect(sources.map((s) => s.file)).toEqual(expect.arrayContaining(['sims.service.ts', 'sims.controller.ts', 'asset-links.service.ts']));
  });

  it.each([
    ['licence seat services / table writes', /\.licenceSeat\.|SeatsService|PoolsService|seats\.service|pools\.service|ensureDevice|releaseDevice/],
    ['device row writes', /\.device\.(create|update|updateMany|upsert|delete|deleteMany|createMany)\b/],
    ['device assignment writes', /\.deviceAssignment\.(create|update|updateMany|upsert|delete|deleteMany)\b/],
    ['company / transfer / device services', /TransferService|DeviceClaimService|CompaniesService|AdminDevicesService|ObjectsService/],
    ['invoices / orders / billing', /\.invoice\.|\.licenceOrder\.|\.creditNote\.|BillingService|InvoicesService/],
    ['raw SQL writes', /\$executeRaw/],
  ])('never references %s', (_label, pattern) => {
    for (const s of sources) expect({ file: s.file, match: s.text.match(pattern)?.[0] ?? null }).toEqual({ file: s.file, match: null });
  });

  it('reads the licence seat only as a nested select in the tenant view', () => {
    const uses = sources.flatMap((s) => [...s.text.matchAll(/licenceSeat\b.*/g)].map((m) => `${s.file}: ${m[0].trim()}`));
    for (const u of uses) expect(u).toMatch(/^asset-links\.service\.ts: licenceSeat(: \{ select: \{ expiresAt: true \} \},|;)/);
  });

  it('every SIM mutation writes its history event inside the same transaction', () => {
    const svc = sources.find((s) => s.file === 'sims.service.ts')!.text;
    expect(svc).not.toMatch(/simEvent\.(update|updateMany|delete|deleteMany|upsert)\b/);
    expect(svc).not.toMatch(/simUsage\.(update|updateMany|delete|deleteMany|upsert)\b/);
    for (const op of ['update', 'changeStatus', 'assign', 'unassign', 'renew', 'addUsage']) {
      const start = svc.indexOf(`async ${op}(`);
      const body = svc.slice(start, svc.indexOf('\n  }\n', start));
      expect({ op, mutate: body.includes('this.mutate('), event: body.includes('this.event(tx') }).toEqual({ op, mutate: true, event: true });
    }
    for (const op of ['create', 'importCsv']) {
      const start = svc.indexOf(`async ${op}(`);
      const body = svc.slice(start, svc.indexOf('\n  }\n', start));
      expect({ op, tx: body.includes('this.prisma.$transaction(async (tx)'), event: body.includes('this.event(tx') }).toEqual({ op, tx: true, event: true });
    }
  });

  it('the tenant view never selects cost, plan price, provider or ICCID data', () => {
    const view = sources.find((s) => s.file === 'asset-links.service.ts')!.text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(view).not.toMatch(/costPaise|pricePaise|iccid|provider|plan\b|imsi/);
  });
});
