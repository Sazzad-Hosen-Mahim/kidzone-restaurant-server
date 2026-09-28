import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { Role } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfigService } from '@config/app-config.service';
import { parseDurationToSeconds } from '@common/utils/duration.util';

export interface AccessTokenPayload {
  sub: string;
  role: Role;
  typ: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  typ: 'refresh';
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresAt: Date;
}

/**
 * Issues and rotates the token pair.
 *
 * The access token is a short-lived JWT. The refresh token is a JWT too, but
 * only the SHA-256 of the token string is stored, so a database leak does not
 * hand out usable refresh tokens. SHA-256 rather than argon2 because refresh
 * tokens are already 256 bits of entropy from `randomUUID` plus the signature —
 * there is nothing to brute force — and because rotation needs a hash lookup.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async issue(
    user: { id: string; role: Role },
    client: { ip?: string | null; userAgent?: string | null },
  ): Promise<IssuedTokens> {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, role: user.role, typ: 'access' } satisfies AccessTokenPayload,
      {
        secret: this.config.get('JWT_ACCESS_SECRET'),
        expiresIn: parseDurationToSeconds(this.config.get('JWT_ACCESS_TTL')),
      },
    );

    const jti = randomUUID();
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, jti, typ: 'refresh' } satisfies RefreshTokenPayload,
      {
        secret: this.config.get('JWT_REFRESH_SECRET'),
        expiresIn: parseDurationToSeconds(this.config.get('JWT_REFRESH_TTL')),
      },
    );

    const refreshTokenExpiresAt = this.expiryOf(refreshToken);

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: refreshTokenExpiresAt,
        userAgent: client.userAgent ?? null,
        ip: client.ip ?? null,
      },
    });

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresIn: this.ttlSeconds(accessToken),
      refreshTokenExpiresAt,
    };
  }

  /**
   * Validates a presented refresh token and consumes it.
   *
   * If the token is valid but was already rotated away, that is a replay: the
   * whole family is revoked and the caller is forced to log in again, which is
   * the standard response to a suspected stolen refresh token.
   */
  async consumeRefreshToken(token: string): Promise<{ userId: string }> {
    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshTokenPayload>(token, {
        secret: this.config.get('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Refresh token is invalid or has expired');
    }

    if (payload.typ !== 'refresh') {
      throw new UnauthorizedException('Refresh token is invalid or has expired');
    }

    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(token) } });

    if (!record) {
      throw new UnauthorizedException('Refresh token is invalid or has expired');
    }

    if (record.revokedAt) {
      this.logger.warn(`Replay of a revoked refresh token for user ${record.userId}; revoking all sessions`);
      await this.revokeAllForUser(record.userId);
      throw new UnauthorizedException('Refresh token has already been used. Please log in again.');
    }

    if (record.expiresAt <= new Date()) {
      throw new UnauthorizedException('Refresh token is invalid or has expired');
    }

    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date() },
    });

    return { userId: record.userId };
  }

  /** Revokes one token if it is still live. Used by logout; never throws. */
  async revokeToken(token: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Revokes every live session for a user (deactivation, password change, replay). */
  async revokeAllForUser(userId: string): Promise<number> {
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count;
  }

  /** Deletes tokens that expired or were revoked over a day ago. Run hourly. */
  async purgeStale(): Promise<number> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.refreshToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: cutoff } }] },
    });
    return count;
  }

  private expiryOf(token: string): Date {
    const decoded = this.jwt.decode(token) as { exp?: number } | null;
    if (!decoded?.exp) throw new Error('Signed token has no exp claim');
    return new Date(decoded.exp * 1000);
  }

  private ttlSeconds(token: string): number {
    const decoded = this.jwt.decode(token) as { exp?: number } | null;
    return decoded?.exp ? Math.max(0, decoded.exp - Math.floor(Date.now() / 1000)) : 0;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
