import { Role } from '@prisma/client';
import type { Request } from 'express';

/** The principal attached to every authenticated request. */
export interface AuthenticatedUser {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  role: Role;
}

export interface RequestWithUser extends Request {
  user?: AuthenticatedUser;
}

export const isAdmin = (user: AuthenticatedUser): boolean => user.role === Role.ADMIN;

/** The section a role is allowed to see. ADMIN sees both. */
export function sectionsFor(role: Role): Array<'KIDZONE' | 'RESTAURANT'> {
  switch (role) {
    case Role.ADMIN:
      return ['KIDZONE', 'RESTAURANT'];
    case Role.KIDZONE_MANAGER:
      return ['KIDZONE'];
    case Role.RESTAURANT_CASHIER:
      return ['RESTAURANT'];
    default:
      return [];
  }
}
