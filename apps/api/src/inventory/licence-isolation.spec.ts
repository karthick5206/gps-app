/**
 * Licence isolation (static): inventory code must never write Device.companyId / Device.isActive or touch licence
 * seats, because either consumes, releases or moves an annual licence seat (SeatsService, hourly pool rebalance).
 * The database-backed proof is inventory.integration.spec.ts.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const DIR = __dirname;
const sources = readdirSync(DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
  .map((f) => ({ file: f, text: readFileSync(join(DIR, f), 'utf8') }));

describe('inventory licence isolation (source)', () => {
  it('has sources to check', () => {
    expect(sources.map((s) => s.file)).toEqual(expect.arrayContaining(['stock.service.ts', 'catalog.service.ts', 'inventory.controller.ts']));
  });

  it.each([
    ['licence seat services / table access', /\.licenceSeat\.|SeatsService|PoolsService|seats\.service|pools\.service|ensureDevice|releaseDevice|"LicenceSeat"/],
    ['device row writes', /\.device\.(update|updateMany|upsert|delete|deleteMany|createMany)\b/],
    ['device assignment writes', /\.deviceAssignment\.(create|update|updateMany|upsert|delete|deleteMany)\b/],
    ['company / transfer services', /TransferService|DeviceClaimService|CompaniesService/],
  ])('never references %s', (_label, pattern) => {
    for (const s of sources) expect({ file: s.file, match: s.text.match(pattern)?.[0] ?? null }).toEqual({ file: s.file, match: null });
  });

  it('reads the licence seat only as a nested select for display', () => {
    const uses = sources.flatMap((s) => [...s.text.matchAll(/licenceSeat\b.*/g)].map((m) => `${s.file}: ${m[0].trim()}`));
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^inventory\.mapper\.ts: licenceSeat(: \{ select: \{ type: true, expiresAt: true \} \},|\)?,?)/);
  });

  it('registers new devices only through the Device Inventory create path, without company or active flag', () => {
    const stock = sources.find((s) => s.file === 'stock.service.ts')!.text;
    expect(stock.match(/\.device\.create\(/g)).toBeNull();
    expect(stock).toContain('this.devices.createInTx(tx, ctx, { ...dto, companyId: undefined, isActive: undefined })');
    // The create DTO built from receipt items lists its fields explicitly (no spread of client input).
    const block = stock.slice(stock.indexOf('createDto = {'), stock.indexOf('};', stock.indexOf('createDto = {')));
    expect(block).not.toMatch(/companyId|isActive|\.\.\./);
  });

  it('every stock write goes through a transaction that also writes the movement', () => {
    const stock = sources.find((s) => s.file === 'stock.service.ts')!.text;
    // DeviceStock rows are only created inside executeReceipt and updated by guardedUpdate (both inside $transaction).
    expect(stock.match(/deviceStock\.create\(/g)).toHaveLength(1);
    expect(stock.match(/deviceStock\.update(Many)?\(/g)).toHaveLength(1);
    expect(stock).not.toMatch(/stockMovement\.(update|updateMany|delete|deleteMany|upsert)\b/);
    for (const op of ['changeStatus', 'transfer', 'adjust', 'sync']) {
      const start = stock.indexOf(`async ${op}(`);
      const body = stock.slice(start, stock.indexOf('\n  }\n', start));
      expect({ op, mutate: body.includes('this.mutate('), move: body.includes('this.move(tx') }).toEqual({ op, mutate: true, move: true });
    }
  });
});
