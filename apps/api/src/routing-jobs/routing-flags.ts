import { CanActivate, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { ETMS_ROUTING_ENV, RoutingErrorCode } from '@veetracer/shared';

/**
 * ETMS planning / optimisation switch (shared `ETMS_ROUTING_ENV`): on only when `ETMS_ROUTING=on` exactly and the ETMS
 * kill switch is not `off`. Off by default: the job endpoints are 404, the routing worker exits at start, the
 * installer and release lines are inert and System Health reports routing as "disabled".
 */
export function etmsRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.ETMS ?? '').trim().toLowerCase() === 'off') return false;
  return (env[ETMS_ROUTING_ENV] ?? '').trim().toLowerCase() === 'on';
}

/** Plain 404 on every job endpoint while ETMS routing is off (the route does not exist for clients). */
@Injectable()
export class EtmsRoutingEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!etmsRoutingEnabled()) throw new NotFoundException({ message: 'Not found', code: 'NOT_FOUND' });
    return true;
  }
}

const STATUS: Record<RoutingErrorCode, number> = {
  ROUTING_DISABLED: 404,
  ROUTING_UNAVAILABLE: 503,
  NO_ROUTE: 404,
  OUTSIDE_COVERAGE: 422,
  LIMIT_EXCEEDED: 422,
  QUOTA_EXCEEDED: 429,
  OPTIMIZER_UNAVAILABLE: 503,
  OPTIMIZER_BUSY: 503,
  JOB_NOT_FOUND: 404,
  PLAN_NOT_EDITABLE: 409,
  PLAN_STALE: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
};

/** HTTP error with a machine `code` (passed through by HttpExceptionFilter as `{ statusCode, message, code }`). */
export class RoutingHttpError extends HttpException {
  constructor(
    readonly code: RoutingErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super({ statusCode: STATUS[code], message, code, ...extra }, STATUS[code]);
  }
}
