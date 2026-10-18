import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';
import { httpErrorFromPrisma } from './prisma-errors';

/** Every HTTP error leaves the API as `{ statusCode, message }`. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpError');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') return;
    const res = host.switchToHttp().getResponse<Response>();
    const http = exception instanceof HttpException ? exception : httpErrorFromPrisma(exception);
    if (!http) {
      this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: 500, message: 'Internal server error' });
      return;
    }
    const statusCode = http.getStatus();
    const body = http.getResponse();
    let message: string = http.message;
    if (typeof body === 'object' && body !== null && 'message' in body) {
      const raw = (body as { message: unknown }).message;
      message = Array.isArray(raw) ? raw.join('; ') : String(raw);
    }
    res.status(statusCode).json({ statusCode, message });
  }
}
