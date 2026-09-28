import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

/** IP and user agent, recorded on refresh tokens and audit entries. */
export const Client = createParamDecorator((_: unknown, ctx: ExecutionContext): ClientInfo => {
  const request = ctx.switchToHttp().getRequest<Request>();
  const forwarded = request.headers['x-forwarded-for'];
  const forwardedIp = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim();
  return {
    ip: forwardedIp || request.ip || request.socket?.remoteAddress || null,
    userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
  };
});
