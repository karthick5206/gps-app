import { HttpException } from '@nestjs/common';
import { RoutingErrorCode } from '@veetracer/shared';
import { etmsRoutingEnabled } from '../etms/transport-feature.guard';
import { ROUTING_ERROR_STATUS } from '../routing/routing.errors';

/** ETMS planning / optimisation switch (off by default; E4-A owns it in transport-feature.guard). */
export { etmsRoutingEnabled };

const STATUS: Record<RoutingErrorCode, number> = ROUTING_ERROR_STATUS;

/** RoutingError (routing/routing.errors.ts) plus extra body fields (e.g. currentVersion); HTTP error with a machine `code` (passed through by HttpExceptionFilter as `{ statusCode, message, code }`). */
export class RoutingHttpError extends HttpException {
  constructor(
    readonly code: RoutingErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super({ statusCode: STATUS[code], message, code, ...extra }, STATUS[code]);
  }
}
