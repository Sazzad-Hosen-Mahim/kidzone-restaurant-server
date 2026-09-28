import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as reachable without an access token. Only `POST /auth/login`,
 * `POST /auth/refresh`, `GET /health` and the Swagger UI use it — every other
 * route goes through the JWT guard and then the RBAC guard.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
