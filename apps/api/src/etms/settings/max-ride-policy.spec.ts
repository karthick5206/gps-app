import { ForbiddenException } from '@nestjs/common';
import { transportSettingsOf } from '@veetracer/shared';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { AuthContext } from '../../access/auth-context';
import { TransportSettingsService, UpdateTransportSettingsDto } from './transport-settings.service';

/**
 * Owner decision 1 (E4 T1-D4): the maximum ride time is a company-level policy (`Company.settings.etms.maxRideS`,
 * seconds; absent = no limit, today's behaviour), changed only with whole-company scope and audited before / after.
 */
type Obj = Record<string, unknown>;

function setup(settings: unknown) {
  const company = { id: 'c1', settings };
  const audits: Obj[] = [];
  const prisma = {
    company: { findUniqueOrThrow: async () => company },
    $executeRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => {
      const [key, json] = values as [string, string];
      company.settings = { ...(company.settings as Obj), [key]: JSON.parse(json) };
      return 1;
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  const svc = new TransportSettingsService(prisma as never, { record: async (_c: unknown, e: Obj) => audits.push(e) } as never);
  return { svc, company, audits };
}

const ctx = (dataScope: 'COMPANY' | 'ASSIGNED' = 'COMPANY') => ({ userId: 'u1', companyId: 'c1', homeCompanyId: 'c1', isSuperAdmin: false, permissions: { etms_settings: ['view', 'edit'] }, dataScope, branchIds: [], objectIds: [], ip: null }) as unknown as AuthContext;
const errorsOf = (body: Obj) => validateSync(plainToInstance(UpdateTransportSettingsDto, body)).map((e) => e.property);

describe('Decision 1: company max-ride policy (transport settings)', () => {
  it('absent = no limit; only a whole number of seconds within 15 min – 4 h is read as the policy', () => {
    expect(transportSettingsOf({ etms: { maxRideS: 5_400 } })).toEqual({ directoryListed: false, maxRideS: 5_400 });
    expect(transportSettingsOf({ etms: {} })).toEqual({ directoryListed: false });
    for (const bad of [60, 899, 14_401, '5400', 5_400.5, null, -1]) expect(transportSettingsOf({ etms: { maxRideS: bad } })).toEqual({ directoryListed: false });
  });

  it('a whole-company Transport admin sets it, then clears it (null); both audited before / after; other settings untouched', async () => {
    const { svc, company, audits } = setup({ features: ['etms'], etms: { directoryListed: true } });
    expect(await svc.update(ctx(), { maxRideS: 5_400 } as never)).toEqual({ directoryListed: true, maxRideS: 5_400 });
    expect(company.settings).toEqual({ features: ['etms'], etms: { directoryListed: true, maxRideS: 5_400 } });
    expect(await svc.get(ctx())).toEqual({ directoryListed: true, maxRideS: 5_400 });
    expect(await svc.update(ctx(), { maxRideS: null } as never)).toEqual({ directoryListed: true });
    expect(audits).toEqual([
      { action: 'UPDATE', entity: 'etms_settings', entityId: 'c1', before: { directoryListed: true }, after: { directoryListed: true, maxRideS: 5_400 } },
      { action: 'UPDATE', entity: 'etms_settings', entityId: 'c1', before: { directoryListed: true, maxRideS: 5_400 }, after: { directoryListed: true } },
    ]);
  });

  it('request validation: whole seconds within the bounds or null', () => {
    expect(errorsOf({ maxRideS: 5_400 })).toEqual([]);
    expect(errorsOf({ maxRideS: null })).toEqual([]);
    expect(errorsOf({ maxRideS: 600 })).toEqual(['maxRideS']);
    expect(errorsOf({ maxRideS: 20_000 })).toEqual(['maxRideS']);
    expect(errorsOf({ maxRideS: 5_400.5 })).toEqual(['maxRideS']);
    expect(errorsOf({ maxRideS: '5400' })).toEqual(['maxRideS']);
  });

  it('branch-scoped users cannot change it (403 SCOPE_REQUIRED)', async () => {
    const { svc } = setup({});
    await expect(svc.update(ctx('ASSIGNED'), { maxRideS: 5_400 } as never)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
