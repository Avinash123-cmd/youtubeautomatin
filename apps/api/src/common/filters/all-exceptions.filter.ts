import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { ConfigurationRequiredError } from '@clipforge/database';
import { PlatformError } from '@clipforge/platform-connectors';
import { workerLogger } from '../services/logger.service';

/**
 * Single error shape for the whole API:
 *   { error: { code, message, details?, missingConfiguration?, requestId } }
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { requestId?: string }>();
    const requestId = request.requestId ?? 'unknown';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';
    let details: unknown;
    let missingConfiguration: string[] | undefined;

    if (exception instanceof ZodError) {
      status = HttpStatus.BAD_REQUEST;
      code = 'VALIDATION_FAILED';
      message = 'Request validation failed';
      details = exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    } else if (exception instanceof ConfigurationRequiredError) {
      status = 428; // Precondition Required — "Configuration required — processing cannot start."
      code = 'CONFIGURATION_REQUIRED';
      message = exception.message;
      missingConfiguration = exception.missing;
    } else if (exception instanceof PlatformError) {
      status = exception.classification === 'AUTH' ? HttpStatus.UNAUTHORIZED : HttpStatus.BAD_GATEWAY;
      code = 'PLATFORM_ERROR';
      message = exception.message;
      details = { platform: exception.platform, classification: exception.classification };
    } else if (exception instanceof MulterError) {
      // Nest 10 matches old Multer message strings. Patched parsers add/change messages;
      // classify by the stable error type/code instead, without echoing uploaded filenames.
      status = exception.code === 'LIMIT_FILE_SIZE' ? HttpStatus.PAYLOAD_TOO_LARGE : HttpStatus.BAD_REQUEST;
      code = 'MULTIPART_INVALID';
      message = exception.code === 'LIMIT_FILE_SIZE' ? 'Upload part exceeds the allowed size' : 'Invalid multipart upload';
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
        code = httpCodeToErrorCode(status);
      } else {
        const obj = body as Record<string, unknown>;
        message = (obj.message as string) ?? exception.message;
        code = (obj.code as string) ?? httpCodeToErrorCode(status);
        details = obj.details;
        if (Array.isArray(obj.message)) {
          message = 'Request validation failed';
          details = obj.message;
          code = 'VALIDATION_FAILED';
        }
      }
    } else if (exception instanceof Error) {
      // Never expose database, network or provider exception text to clients.
      // Pino's second string argument is not a stack field. Record structured call-site frames
      // (without the exception message, which may contain credentials/provider responses).
      const frames = exception.stack?.split('\n').filter(line => /^\s+at /.test(line)).slice(0, 12);
      workerLogger.child({ requestId, method: request.method, path: request.path }).error({ errorType: exception.name, frames }, 'unhandled exception');
    }

    const payload = { error: { code, message, ...(details ? { details } : {}), ...(missingConfiguration ? { missingConfiguration } : {}), requestId } };
    if (status >= 500) workerLogger.child({ requestId, code }).error(message);
    response.status(status).json(payload);
  }
}

function httpCodeToErrorCode(status: number): string {
  switch (status) {
    case 400: return 'VALIDATION_FAILED';
    case 401: return 'UNAUTHENTICATED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    case 429: return 'RATE_LIMITED';
    default: return status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED';
  }
}
