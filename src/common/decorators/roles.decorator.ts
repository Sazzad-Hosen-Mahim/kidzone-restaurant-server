import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Restricts a route to the listed roles. `RolesGuard` is registered globally
 * and denies any authenticated route that carries no `@Roles()` at all, so a
 * new endpoint cannot accidentally ship without an access decision.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
