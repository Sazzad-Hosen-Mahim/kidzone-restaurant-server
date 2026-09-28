import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import { DomainException } from '@common/exceptions/domain.exception';
import { SKIP_GLOBAL_THROTTLE_KEY } from '@common/decorators/skip-global-throttle.decorator';

/**
 * The application-wide rate limiter.
 *
 * Two jobs beyond the stock guard: it emits the project's error envelope with a
 * stable `TOO_MANY_REQUESTS` code instead of the library's default shape, and it
 * stands aside on routes marked `@SkipGlobalThrottle()`, which carry their own
 * stricter limiter (login, refresh, OTP).
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    return (
      this.reflector.getAllAndOverride<boolean>(SKIP_GLOBAL_THROTTLE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }

  protected async throwThrottlingException(_context: ExecutionContext, detail: ThrottlerLimitDetail): Promise<void> {
    const retryAfter = detail.isBlocked ? detail.timeToBlockExpire : detail.timeToExpire;
    throw new DomainException(
      'TOO_MANY_REQUESTS',
      `Too many requests. Please try again in ${retryAfter} second(s).`,
      429,
      { retryAfterSeconds: retryAfter },
    );
  }
}
