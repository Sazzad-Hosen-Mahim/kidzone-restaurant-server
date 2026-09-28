import { ExecutionContext, InternalServerErrorException, createParamDecorator } from '@nestjs/common';
import { AuthenticatedUser, RequestWithUser } from '../types/authenticated-user';

/**
 * Injects the authenticated principal. Throws rather than returning undefined
 * when used on a `@Public()` route, since that is a programming error.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, ctx: ExecutionContext): AuthenticatedUser | AuthenticatedUser[keyof AuthenticatedUser] => {
    const request = ctx.switchToHttp().getRequest<RequestWithUser>();
    if (!request.user) {
      throw new InternalServerErrorException('@CurrentUser() used on a route without authentication');
    }
    return field ? request.user[field] : request.user;
  },
);
