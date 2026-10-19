import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { httpErrorFromPrisma } from './prisma-errors';

/** Machine-readable error codes of the public API (v1). */
export const V1_ERROR_CODES: Record<number, string> = {
  400: 'invalid_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  422: 'invalid_request',
  429: 'rate_limited',
  500: 'internal_error',
  503: 'unavailable',
};

export const isV1Path = (url: string | undefined): boolean => !!url && /^\/api\/v1(\/|$|\?)/.test(url);

/**
 * Every HTTP error leaves the API as `{ statusCode, message }`; on the public API (/api/v1) as
 * `{ error: { status, code, message } }`.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpError');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') return;
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const v1 = isV1Path(req?.originalUrl ?? req?.url);
    const http = exception instanceof HttpException ? exception : httpErrorFromPrisma(exception);
    if (!http) {
      this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
      if (v1) res.status(500).json({ error: { status: 500, code: 'internal_error', message: 'Internal server error' } });
      else res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: 500, message: 'Internal server error' });
      return;
    }
    const statusCode = http.getStatus();
    const body = http.getResponse();
    let message: string = http.message;
    if (typeof body === 'object' && body !== null && 'message' in body) {
      const raw = (body as { message: unknown }).message;
      message = Array.isArray(raw) ? raw.join('; ') : String(raw);
    }
    if (v1) {
      const code = V1_ERROR_CODES[statusCode] ?? (statusCode >= 500 ? 'internal_error' : 'invalid_request');
      res.status(statusCode).json({ error: { status: statusCode, code, message } });
      return;
    }
    // Machine-readable app error codes (e.g. LICENCE_REQUIRED / LICENCE_EXPIRED) travel with the message.
    const extra: Record<string, unknown> = {};
    if (typeof body === 'object' && body !== null) {
      const b = body as Record<string, unknown>;
      if (typeof b.code === 'string') extra.code = b.code;
      if (typeof b.licenceType === 'string') extra.licenceType = b.licenceType;
    }
    res.status(statusCode).json({ statusCode, message, ...extra });
  }
}
