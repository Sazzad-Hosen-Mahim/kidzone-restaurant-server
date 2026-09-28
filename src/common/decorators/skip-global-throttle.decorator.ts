import { SetMetadata } from '@nestjs/common';

export const SKIP_GLOBAL_THROTTLE_KEY = 'skipGlobalThrottle';

/**
 * Exempts a route from the application-wide rate limiter because it carries a
 * stricter one of its own. Used by login, refresh and the OTP endpoints, so the
 * caller gets one clear limit and one clear error code rather than whichever of
 * two limiters happened to trip first.
 */
export const SkipGlobalThrottle = () => SetMetadata(SKIP_GLOBAL_THROTTLE_KEY, true);
