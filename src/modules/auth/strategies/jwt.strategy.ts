import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AppConfigService } from '@config/app-config.service';
import { PrismaService } from '@/prisma/prisma.service';
import { AuthenticatedUser } from '@common/types/authenticated-user';
import { AccessTokenPayload } from '../token.service';

/**
 * Validates the access token and loads the user on every request.
 *
 * The extra read is deliberate: it is what makes "deactivate a user and they
 * lose access now" true, instead of true only once their 15-minute token
 * expires. It also means the role carried by a request is always the role in
 * the database, not the one baked into the token.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: AppConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_ACCESS_SECRET'),
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    if (payload.typ !== 'access') {
      throw new UnauthorizedException('A refresh token cannot be used as an access token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, name: true, phone: true, email: true, role: true, isActive: true, deletedAt: true },
    });

    if (!user || !user.isActive || user.deletedAt) {
      throw new UnauthorizedException('This account is no longer active');
    }

    return { id: user.id, name: user.name, phone: user.phone, email: user.email, role: user.role };
  }
}
