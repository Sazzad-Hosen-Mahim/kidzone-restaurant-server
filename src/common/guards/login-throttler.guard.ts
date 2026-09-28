import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail, ThrottlerRequest } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { DomainException } from '@common/exceptions/domain.exception';

/**
 * Login throttling: at most 5 attempts per minute *per IP* and, independently,
 * 5 attempts per minute *per account identifier*.
 *
 * Two separate buckets matter here. The per-IP bucket stops one machine working
 * through a list of staff phone numbers; the per-identifier bucket stops a
 * distributed attempt at one known account. Either one tripping returns 429.
 *
 * The identifier is hashed before it becomes part of a storage key, so staff
 * phone numbers never end up in Redis keys or in throttler logs.
 */
@Injectable()
export class LoginThrottlerGuard extends ThrottlerGuard {
  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const { context, limit, ttl, throttler, blockDuration } = requestProps;
    const request = context.switchToHttp().getRequest<Request>();

    const ip = request.ip ?? request.socket?.remoteAddress ?? 'unknown';
    const identifier = extractIdentifier(request);

    const buckets = [`ip:${ip}`, ...(identifier ? [`id:${hashIdentifier(identifier)}`] : [])];

    for (const bucket of buckets) {
      const key = this.generateKey(context, bucket, throttler.name ?? 'login');
      const { totalHits, timeToExpire, isBlocked, timeToBlockExpire } = await this.storageService.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttler.name ?? 'login',
      );

      if (isBlocked || totalHits > limit) {
        const retryAfter = isBlocked ? timeToBlockExpire : timeToExpire;
        await this.throwThrottlingException(context, {
          limit,
          ttl,
          key,
          tracker: bucket,
          totalHits,
          timeToExpire,
          isBlocked,
          timeToBlockExpire,
        });
        // throwThrottlingException always throws; this keeps the types honest.
        throw new DomainException('TOO_MANY_LOGIN_ATTEMPTS', `Too many attempts. Try again in ${retryAfter}s.`, 429);
      }
    }

    return true;
  }

  protected async throwThrottlingException(_context: unknown, detail: ThrottlerLimitDetail): Promise<void> {
    const retryAfter = detail.isBlocked ? detail.timeToBlockExpire : detail.timeToExpire;
    throw new DomainException(
      'TOO_MANY_LOGIN_ATTEMPTS',
      `Too many login attempts. Please try again in ${retryAfter} second(s).`,
      429,
      { retryAfterSeconds: retryAfter },
    );
  }
}

function extractIdentifier(request: Request): string | null {
  const body = request.body as { identifier?: unknown; phone?: unknown } | undefined;
  const raw = body?.identifier ?? body?.phone;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim().toLowerCase() : null;
}

function hashIdentifier(identifier: string): string {
  return createHash('sha256').update(identifier).digest('hex').slice(0, 32);
}
