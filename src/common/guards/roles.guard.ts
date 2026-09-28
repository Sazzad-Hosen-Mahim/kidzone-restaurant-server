import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { IS_PUBLIC_KEY } from '@common/decorators/public.decorator';
import { ROLES_KEY } from '@common/decorators/roles.decorator';
import { RequestWithUser } from '@common/types/authenticated-user';

/**
 * Registered globally and deliberately fail-closed: an authenticated route with
 * no `@Roles()` decorator is denied, not allowed. Forgetting the decorator
 * therefore surfaces as an immediate 403 in development rather than as a
 * silently unguarded endpoint in production.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const allowed = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Authentication is required');
    }

    if (!allowed || allowed.length === 0) {
      this.logger.error(
        `${context.getClass().name}.${context.getHandler().name} has no @Roles() decorator; denying the request`,
      );
      throw new ForbiddenException('This endpoint has no access policy and cannot be used');
    }

    if (!allowed.includes(user.role)) {
      throw new ForbiddenException(
        `Your role (${user.role}) is not permitted to use this endpoint. Allowed: ${allowed.join(', ')}.`,
      );
    }

    return true;
  }
}
