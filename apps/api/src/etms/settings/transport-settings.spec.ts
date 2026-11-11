import { BadRequestException, ConflictException, ForbiddenException, ParseUUIDPipe, UnauthorizedException, type ArgumentsHost } from '@nestjs/common';
import { transportSettingsOf } from '@veetracer/shared';
import type { AuthContext } from '../../access/auth-context';
import { HttpExceptionFilter } from '../../common/http-exception.filter';
import { TransportSettingsService } from './transport-settings.service';

type Obj = Record<string, unknown>;

function setup(settings: unknown) {
  const company = { id: 'c1', settings };
  const raw: unknown[][] = [];
  const audits: Obj[] = [];
  const prisma = {
    company: { findUniqueOrThrow: async () => company },
    // setCompanySetting: a single atomic UPDATE … jsonb_set; emulated on the in-memory row.
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      raw.push([strings.join('?'), ...values]);
      const [key, json] = values as [string, string];
      company.settings = { ...(company.settings as Obj), [key]: JSON.parse(json) };
      return 1;
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  const svc = new TransportSettingsService(prisma as never, { record: async (_c: unknown, e: Obj) => audits.push(e) } as never);
  return { svc, company, raw, audits };
}

const ctx = (dataScope: 'COMPANY' | 'ASSIGNED' = 'COMPANY') => ({ userId: 'u1', companyId: 'c1', homeCompanyId: 'c1', isSuperAdmin: false, permissions: { etms_settings: ['view', 'edit'] }, dataScope, branchIds: [], objectIds: [], ip: null }) as unknown as AuthContext;

describe('F4: transport settings (partner-directory opt-in)', () => {
  it('defaults to not listed; malformed values read as not listed', () => {
    expect(transportSettingsOf({})).toEqual({ directoryListed: false });
    expect(transportSettingsOf(null)).toEqual({ directoryListed: false });
    expect(transportSettingsOf({ etms: { directoryListed: 'true' } })).toEqual({ directoryListed: false });
    expect(transportSettingsOf({ etms: { directoryListed: true } })).toEqual({ directoryListed: true });
  });

  it('a Transport admin opts in: only the `etms` key is written (atomic jsonb_set), other settings untouched, audited', async () => {
    const { svc, company, raw, audits } = setup({ features: ['etms'], thresholds: { overspeedKmh: 80 } });
    expect(await svc.get(ctx())).toEqual({ directoryListed: false });
    expect(await svc.update(ctx(), { directoryListed: true })).toEqual({ directoryListed: true });
    expect(company.settings).toEqual({ features: ['etms'], thresholds: { overspeedKmh: 80 }, etms: { directoryListed: true } });
    expect(String(raw[0][0])).toMatch(/jsonb_set/);
    expect(raw[0][1]).toBe('etms');
    expect(audits).toEqual([{ action: 'UPDATE', entity: 'etms_settings', entityId: 'c1', before: { directoryListed: false }, after: { directoryListed: true } }]);
  });

  it('branch-scoped users cannot change it (403 SCOPE_REQUIRED)', async () => {
    const { svc } = setup({});
    await expect(svc.update(ctx('ASSIGNED'), { directoryListed: true })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ETMS error responses always carry a code (doc 05 §4, QA BUG-6)', () => {
  function run(url: string, e: unknown) {
    let body: Obj = {};
    let status = 0;
    const headers: Obj = {};
    const res = {
      status: (s: number) => ((status = s), res),
      json: (b: Obj) => ((body = b), res),
      setHeader: (k: string, v: string) => (headers[k] = v),
    };
    const host = { getType: () => 'http', switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ originalUrl: url }) }) } as unknown as ArgumentsHost;
    new HttpExceptionFilter().catch(e, host);
    return { status, body, headers };
  }

  it('fills a default code for errors raised without one, on /api/transport only', async () => {
    const uuid = await new ParseUUIDPipe().transform('not-a-uuid', { type: 'param' }).catch((e: unknown) => e);
    expect(run('/api/transport/agreements/not-a-uuid', uuid)).toMatchObject({ status: 400, body: { code: 'VALIDATION_FAILED' } });
    expect(run('/api/transport/agreements', new UnauthorizedException('Missing token')).body.code).toBe('UNAUTHENTICATED');
    expect(run('/api/transport/agreements', new BadRequestException(['grants must be an array'])).body).toMatchObject({ code: 'VALIDATION_FAILED', message: 'grants must be an array' });
    expect(run('/api/transport/agreements', new Error('boom'))).toMatchObject({ status: 500, body: { code: 'INTERNAL_ERROR' } });
    expect(run('/api/vehicles', new UnauthorizedException('x')).body.code).toBeUndefined();
  });

  it('keeps an explicit code and passes currentVersion / retryAfterSec through', () => {
    const conflict = new ConflictException({ message: 'changed', code: 'VERSION_CONFLICT', currentVersion: 7 });
    expect(run('/api/transport/agreements/x/approve', conflict).body).toEqual({ statusCode: 409, message: 'changed', code: 'VERSION_CONFLICT', currentVersion: 7 });
    const limited = run('/api/transport/companies/lookup?q=abc', new (class extends BadRequestException {})({ message: 'slow', code: 'RATE_LIMITED', retryAfterSec: 12 }));
    expect(limited.body).toMatchObject({ code: 'RATE_LIMITED', retryAfterSec: 12 });
    expect(limited.headers['Retry-After']).toBe('12');
  });
});
