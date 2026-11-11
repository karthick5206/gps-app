import { HttpException } from '@nestjs/common';
import type { RoutingErrorCode } from '@veetracer/shared';
import type { DegradedReason, Unavailable } from './provider/routing-provider';

/**
 * Routing / planning API errors, ported from the routing branch (`routing-v2.errors.ts`, doc 17 §5.1) onto the shared
 * contract (`RoutingErrorCode`, P4). `VALIDATION_FAILED` is the common ETMS code (doc 05 §4) for bad input the provider
 * reports (`INVALID_INPUT`, `PROFILE_NOT_AVAILABLE`); the branch had no equivalent.
 */
export type RoutingApiErrorCode = RoutingErrorCode | 'VALIDATION_FAILED';

export const ROUTING_ERROR_STATUS: Record<RoutingApiErrorCode, number> = {
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
  VALIDATION_FAILED: 400,
};

export const ROUTING_ERROR_CODES = Object.keys(ROUTING_ERROR_STATUS) as RoutingApiErrorCode[];

/** HTTP error with a machine `code` (HttpExceptionFilter passes `{ statusCode, message, code }` through). */
export class RoutingError extends HttpException {
  constructor(
    readonly code: RoutingApiErrorCode,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    const body = { statusCode: ROUTING_ERROR_STATUS[code], message, code };
    // retryAfterSec: the ETMS error convention (HttpExceptionFilter turns it into a Retry-After header on ETMS routes).
    super(retryAfterSec === undefined ? body : { ...body, retryAfterSec }, ROUTING_ERROR_STATUS[code]);
  }
}

/** Which API code a provider `DegradedReason` becomes when an endpoint must fail instead of returning a degraded body. */
export const DEGRADED_TO_CODE: Record<DegradedReason, RoutingApiErrorCode> = {
  ENGINE_DISABLED: 'ROUTING_UNAVAILABLE',
  ENGINE_NOT_SUPPORTED: 'ROUTING_UNAVAILABLE',
  ENGINE_UNREACHABLE: 'ROUTING_UNAVAILABLE',
  ENGINE_TIMEOUT: 'ROUTING_UNAVAILABLE',
  GRAPH_REBUILDING: 'ROUTING_UNAVAILABLE',
  NOT_IMPLEMENTED: 'ROUTING_UNAVAILABLE',
  PROFILE_NOT_AVAILABLE: 'VALIDATION_FAILED',
  INVALID_INPUT: 'VALIDATION_FAILED',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  OUTSIDE_COVERAGE: 'OUTSIDE_COVERAGE',
  POINT_NOT_ON_ROAD: 'NO_ROUTE',
  NO_ROUTE: 'NO_ROUTE',
};

export function routingErrorFrom(u: Unavailable): RoutingError {
  return new RoutingError(DEGRADED_TO_CODE[u.degraded], u.message, u.retryAfterS);
}
