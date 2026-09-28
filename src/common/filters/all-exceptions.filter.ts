import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { maskPhone } from '../utils/phone.util';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
  details?: unknown;
}

/**
 * The single exception filter for the application. Everything that escapes a
 * handler leaves as `{ statusCode, error, message, details? }`.
 *
 * Internal failures never leak their message or stack to the client; they are
 * logged in full server-side with phone numbers masked.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();

    const body = this.toErrorBody(exception);

    if (body.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request?.method} ${maskPhone(request?.url ?? '') || request?.url} -> ${body.statusCode}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (body.statusCode === HttpStatus.UNAUTHORIZED || body.statusCode === HttpStatus.FORBIDDEN) {
      this.logger.warn(`${request?.method} ${request?.url} -> ${body.statusCode} ${body.error}`);
    }

    httpAdapter.reply(ctx.getResponse(), body, body.statusCode);
  }

  private toErrorBody(exception: unknown): ErrorBody {
    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrismaError(exception);
    }
    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'INVALID_QUERY',
        message: 'The request could not be translated into a valid database query',
      };
    }
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    };
  }

  private fromHttpException(exception: HttpException): ErrorBody {
    const status = exception.getStatus();
    const response = exception.getResponse();

    if (typeof response === 'string') {
      return { statusCode: status, error: httpErrorName(status), message: response };
    }

    const payload = response as Record<string, unknown>;

    // class-validator via the global ValidationPipe hands us message: string[]
    if (Array.isArray(payload.message)) {
      return {
        statusCode: status,
        error: 'VALIDATION_FAILED',
        message: 'Validation failed',
        details: { errors: payload.message },
      };
    }

    return {
      statusCode: status,
      error: typeof payload.error === 'string' ? payload.error : httpErrorName(status),
      message: typeof payload.message === 'string' ? payload.message : exception.message,
      ...(payload.details !== undefined ? { details: payload.details } : {}),
    };
  }

  private fromPrismaError(exception: Prisma.PrismaClientKnownRequestError): ErrorBody {
    const target = (exception.meta?.target as string[] | string | undefined) ?? undefined;
    const fields = Array.isArray(target) ? target : target ? [target] : [];

    switch (exception.code) {
      case 'P2002':
        return {
          statusCode: HttpStatus.CONFLICT,
          error: 'UNIQUE_CONSTRAINT_VIOLATION',
          message: fields.length
            ? `A record with this ${fields.join(', ')} already exists`
            : 'A record with these values already exists',
          details: { fields },
        };
      case 'P2003':
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          error: 'FOREIGN_KEY_VIOLATION',
          message: 'A referenced record does not exist',
          details: { field: exception.meta?.field_name },
        };
      case 'P2025':
        return {
          statusCode: HttpStatus.NOT_FOUND,
          error: 'NOT_FOUND',
          message: (exception.meta?.cause as string) ?? 'The requested record was not found',
        };
      default:
        this.logger.error(`Unhandled Prisma error ${exception.code}`, exception.stack);
        return {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          error: 'DATABASE_ERROR',
          message: 'A database error occurred',
        };
    }
  }
}

function httpErrorName(status: number): string {
  const name = HttpStatus[status] as string | undefined;
  return name ?? 'ERROR';
}
