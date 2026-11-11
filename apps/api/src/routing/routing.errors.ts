import { HttpException } from '@nestjs/common';
import type { DegradedReason, Unavailable } from './provider/routing-provider';

/**
 * Machine codes of routing / optimisation errors returned by ETMS planning endpoints (ported from the routing branch,
 * `routing-v2.errors.ts`, doc 17 §5.1). `ROUTING_DISABLED` replaces the branch's `RoutingV2EnabledGuard` 404.
 * The list lives here until the shared routing contracts (P4) move it to `@veetracer/shared`.
 */
export const ROUTING_ERROR_CODES = [
  'ROUTING_DISABLED',
  'ROUTING_UNAVAILABLE',
  'NO_ROUTE',
  'OUTSIDE_COVERAGE',
  'LIMIT_EXCEEDED',
  'QUOTA_EXCEEDED',
  'OPTIMIZER_UNAVAILABLE',
  'OPTIMIZER_BUSY',
  'JOB_NOT_FOUND',
  // Added in the port (the provider reports these; the branch had no equivalent):
  'INVALID_INPUT',
  'PROFILE_NOT_AVAILABLE',
] as const;
export type RoutingErrorCode = (typeof ROUTING_ERROR_CODES)[number];

export const ROUTING_ERROR_STATUS: Record<RoutingErrorCode, number> = {
  ROUTING_DISABLED: 404,
  ROUTING_UNAVAILABLE: 503,
  NO_ROUTE: 404,
  OUTSIDE_COVERAGE: 422,
  LIMIT_EXCEEDED: 422,
  QUOTA_EXCEEDED: 429,
  OPTIMIZER_UNAVAILABLE: 503,
  OPTIMIZER_BUSY: 503,
  JOB_NOT_FOUND: 404,
  INVALID_INPUT: 400,
  PROFILE_NOT_AVAILABLE: 422,
};

/** HTTP error with a machine `code` (HttpExceptionFilter passes `{ statusCode, message, code }` through). */
export class RoutingError extends HttpException {
  constructor(
    readonly code: RoutingErrorCode,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    const body = { statusCode: ROUTING_ERROR_STATUS[code], message, code };
    // retryAfterSec: the ETMS error convention (HttpExceptionFilter turns it into a Retry-After header on ETMS routes).
    super(retryAfterSec === undefined ? body : { ...body, retryAfterSec }, ROUTING_ERROR_STATUS[code]);
  }
}

/** Which API code a provider `DegradedReason` becomes when an endpoint must fail instead of returning a degraded body. */
export const DEGRADED_TO_CODE: Record<DegradedReason, RoutingErrorCode> = {
  ENGINE_DISABLED: 'ROUTING_UNAVAILABLE',
  ENGINE_NOT_SUPPORTED: 'ROUTING_UNAVAILABLE',
  ENGINE_UNREACHABLE: 'ROUTING_UNAVAILABLE',
  ENGINE_TIMEOUT: 'ROUTING_UNAVAILABLE',
  GRAPH_REBUILDING: 'ROUTING_UNAVAILABLE',
  NOT_IMPLEMENTED: 'ROUTING_UNAVAILABLE',
  PROFILE_NOT_AVAILABLE: 'PROFILE_NOT_AVAILABLE',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  INVALID_INPUT: 'INVALID_INPUT',
  OUTSIDE_COVERAGE: 'OUTSIDE_COVERAGE',
  POINT_NOT_ON_ROAD: 'NO_ROUTE',
  NO_ROUTE: 'NO_ROUTE',
};

export function routingErrorFrom(u: Unavailable): RoutingError {
  return new RoutingError(DEGRADED_TO_CODE[u.degraded], u.message, u.retryAfterS);
}
