import { CallHandler, ExecutionContext, Injectable, NestInterceptor, StreamableFile } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, map } from 'rxjs';
import { PageResult } from '../http/api-response';
import { RAW_RESPONSE_KEY } from '../decorators/raw-response.decorator';

/**
 * Wraps controller return values into the global `{ data, meta }` envelope.
 *
 * Handlers that stream a file (receipt PDFs, report exports) opt out with
 * `@RawResponse()`, and `StreamableFile`/`Buffer` returns are passed through
 * regardless so a binary body is never JSON-wrapped.
 */
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isRaw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    return next.handle().pipe(
      map((value) => {
        if (isRaw || value instanceof StreamableFile || Buffer.isBuffer(value)) {
          return value;
        }

        const timestamp = new Date().toISOString();

        if (value instanceof PageResult) {
          return {
            data: value.items,
            meta: { ...value.meta, ...(value.summary !== undefined ? { summary: value.summary } : {}), timestamp },
          };
        }

        return { data: value ?? null, meta: { timestamp } };
      }),
    );
  }
}
