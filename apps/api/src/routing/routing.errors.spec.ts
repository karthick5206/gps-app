import { ArgumentsHost } from '@nestjs/common';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import { DegradedReason, unavailable } from './provider/routing-provider';
import { DEGRADED_TO_CODE, ROUTING_ERROR_CODES, ROUTING_ERROR_STATUS, RoutingError, routingErrorFrom } from './routing.errors';

function send(err: unknown, url = '/api/transport/planning/x'): { status: number; body: Record<string, unknown>; headers: Record<string, string> } {
  const out = { status: 0, body: {} as Record<string, unknown>, headers: {} as Record<string, string> };
  const res = {
    status(s: number) {
      out.status = s;
      return this;
    },
    json(b: Record<string, unknown>) {
      out.body = b;
      return this;
    },
    setHeader(k: string, v: string) {
      out.headers[k] = v;
    },
    headersSent: false,
  };
  const host = { getType: () => 'http', switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ originalUrl: url, url }) }) } as unknown as ArgumentsHost;
  new HttpExceptionFilter().catch(err, host);
  return out;
}

describe('RoutingError', () => {
  it('every code has an HTTP status', () => {
    for (const c of ROUTING_ERROR_CODES) expect(ROUTING_ERROR_STATUS[c]).toBeGreaterThanOrEqual(400);
  });

  it('carries status, message and code', () => {
    const e = new RoutingError('OPTIMIZER_BUSY', 'busy');
    expect(e.getStatus()).toBe(503);
    expect(e.getResponse()).toEqual({ statusCode: 503, message: 'busy', code: 'OPTIMIZER_BUSY' });
    expect(new RoutingError('OUTSIDE_COVERAGE', 'x').getStatus()).toBe(422);
    expect(new RoutingError('ROUTING_DISABLED', 'x').getStatus()).toBe(404);
  });

  it('passes through the global filter with its code (and Retry-After on ETMS routes)', () => {
    const plain = send(new RoutingError('NO_ROUTE', 'No road route'));
    expect(plain.status).toBe(404);
    expect(plain.body).toMatchObject({ statusCode: 404, message: 'No road route', code: 'NO_ROUTE' });
    const busy = send(new RoutingError('OPTIMIZER_BUSY', 'busy', 20), '/api/transport/trips');
    expect(busy.body).toMatchObject({ code: 'OPTIMIZER_BUSY', retryAfterSec: 20 });
    expect(busy.headers['Retry-After']).toBe('20');
  });

  it('maps every provider DegradedReason to an API code', () => {
    const reasons = Object.keys(DEGRADED_TO_CODE) as DegradedReason[];
    expect(reasons).toHaveLength(12);
    for (const r of reasons) expect(ROUTING_ERROR_CODES).toContain(DEGRADED_TO_CODE[r]);
    const e = routingErrorFrom(unavailable('ENGINE_TIMEOUT', 'GraphHopper timed out', 5));
    expect(e.code).toBe('ROUTING_UNAVAILABLE');
    expect(e.getStatus()).toBe(503);
    expect(e.retryAfterSec).toBe(5);
    expect(routingErrorFrom(unavailable('OUTSIDE_COVERAGE', 'x')).getStatus()).toBe(422);
    expect(routingErrorFrom(unavailable('INVALID_INPUT', 'x'))).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(routingErrorFrom(unavailable('INVALID_INPUT', 'x')).getStatus()).toBe(400);
    expect(new RoutingError('PLAN_STALE', 'moved on').getStatus()).toBe(409);
  });
});
