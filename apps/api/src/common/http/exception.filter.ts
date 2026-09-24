import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ApiErrorBody, ErrorCode } from '@daliz/shared';
import type { Request, Response } from 'express';
import { AppError } from '../errors.js';
import { RequestContext } from '../request-context.js';

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'RESOURCE_NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

const SAFE_MESSAGES: Record<number, string> = {
  400: 'The request is invalid.',
  401: 'Sign in to continue.',
  403: 'You do not have permission to do that.',
  404: 'The requested resource could not be found.',
  409: 'The request conflicts with the current state.',
  413: 'The request is too large.',
  415: 'That file type is not supported.',
  429: 'Too many requests.',
  503: 'The service is temporarily unavailable.',
};

interface PgError {
  code?: string;
  constraint?: string;
}

/**
 * Converts every error into the standard envelope. Internal details (stack traces, SQL,
 * library messages) go to the server log with the request id and never to the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const requestId = RequestContext.get()?.requestId ?? String(req.headers['x-request-id'] ?? 'unknown');

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: ErrorCode = 'INTERNAL_ERROR';
    let message = 'Something went wrong. Please try again.';
    let details: ApiErrorBody['error']['details'];

    if (exception instanceof AppError) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
      if (exception.internal) this.logger.warn({ requestId, internal: String(exception.internal) }, code);
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = STATUS_TO_CODE[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
      message = SAFE_MESSAGES[status] ?? message;
    } else if ((exception as PgError)?.code === '23505') {
      status = HttpStatus.CONFLICT;
      code = 'CONFLICT';
      message = 'A record with these details already exists.';
      this.logger.warn({ requestId, constraint: (exception as PgError).constraint }, 'unique violation');
    } else if ((exception as { type?: string })?.type === 'entity.too.large') {
      status = HttpStatus.PAYLOAD_TOO_LARGE;
      code = 'PAYLOAD_TOO_LARGE';
      message = SAFE_MESSAGES[413]!;
    } else if ((exception as { type?: string })?.type === 'entity.parse.failed') {
      status = HttpStatus.BAD_REQUEST;
      code = 'BAD_REQUEST';
      message = 'The request body is not valid JSON.';
    }

    if (status >= 500) {
      this.logger.error(
        { requestId, err: exception instanceof Error ? { message: exception.message, stack: exception.stack } : exception },
        'unhandled error',
      );
    }

    if (res.headersSent) return;
    if (status === 429 && exception instanceof AppError) {
      const match = /in (\d+) seconds/.exec(exception.message);
      if (match) res.setHeader('Retry-After', match[1]!);
    }
    const body: ApiErrorBody = { success: false, error: { code, message, requestId, ...(details ? { details } : {}) } };
    res.status(status).json(body);
  }
}
