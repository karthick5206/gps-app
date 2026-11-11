import { CanActivate, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { RoutingErrorCode } from '@veetracer/shared';
import { etmsRoutingEnabled } from '../etms/transport-feature.guard';

/** ETMS planning / optimisation switch (off by default; E4-A owns it in transport-feature.guard). */
export { etmsRoutingEnabled };

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
