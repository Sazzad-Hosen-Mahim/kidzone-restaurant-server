import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@modules/audit/audit.service';
import { AUDIT_ACTIONS } from '@modules/audit/audit.constants';
import { AuthenticatedUser } from '@common/types/authenticated-user';
import { DomainException } from '@common/exceptions/domain.exception';
import { maskPhone, tryNormalizeBdPhone } from '@common/utils/phone.util';
import { PasswordService } from './password.service';
import { IssuedTokens, TokenService } from './token.service';
import { LoginDto } from './dto/login.dto';

export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
}

export interface AuthResult {
  user: AuthenticatedUser;
  tokens: IssuedTokens;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Authenticates by phone or email.
   *
   * Every failure — unknown account, wrong password, deactivated account —
   * returns the same message and takes roughly the same time, so the endpoint
   * cannot be used to enumerate staff accounts.
   */
  async login(dto: LoginDto, client: ClientContext): Promise<AuthResult> {
    const identifier = dto.identifier.trim();
    const phone = tryNormalizeBdPhone(identifier);

    const user = await this.prisma.user.findFirst({
      where: {
        deletedAt: null,
        ...(phone ? { phone } : { email: { equals: identifier, mode: 'insensitive' } }),
      },
    });

    if (!user) {
      await this.passwords.fakeVerify();
      await this.audit.recordSafe({
        actorId: null,
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        entityType: 'User',
        reason: 'No account matches the identifier',
        ip: client.ip,
        userAgent: client.userAgent,
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatches = await this.passwords.verify(user.passwordHash, dto.password);

    if (!passwordMatches) {
      await this.audit.recordSafe({
        actorId: user.id,
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        entityType: 'User',
        entityId: user.id,
        reason: 'Wrong password',
        ip: client.ip,
        userAgent: client.userAgent,
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isActive) {
      await this.audit.recordSafe({
        actorId: user.id,
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        entityType: 'User',
        entityId: user.id,
        reason: 'Account is deactivated',
        ip: client.ip,
        userAgent: client.userAgent,
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.tokens.issue(user, client);

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    await this.audit.recordSafe({
      actorId: user.id,
      action: AUDIT_ACTIONS.LOGIN,
      entityType: 'User',
      entityId: user.id,
      ip: client.ip,
      userAgent: client.userAgent,
    });

    this.logger.log(`Login: ${user.role} ${maskPhone(user.phone)}`);

    return { user: toAuthenticatedUser(user), tokens };
  }

  /**
   * Rotates a refresh token. The presented token is consumed first, then the
   * account is re-checked, so a user deactivated mid-session cannot refresh
   * their way back in.
   */
  async refresh(refreshToken: string, client: ClientContext): Promise<AuthResult> {
    const { userId } = await this.tokens.consumeRefreshToken(refreshToken);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user || !user.isActive || user.deletedAt) {
      await this.tokens.revokeAllForUser(userId);
      throw new UnauthorizedException('This account is no longer active');
    }

    const tokens = await this.tokens.issue(user, client);
    return { user: toAuthenticatedUser(user), tokens };
  }

  async logout(refreshToken: string | undefined, user: AuthenticatedUser, client: ClientContext): Promise<void> {
    if (refreshToken) await this.tokens.revokeToken(refreshToken);
    await this.audit.recordSafe({
      actorId: user.id,
      action: AUDIT_ACTIONS.LOGOUT,
      entityType: 'User',
      entityId: user.id,
      ip: client.ip,
      userAgent: client.userAgent,
    });
  }

  async me(userId: string): Promise<AuthenticatedUser & { lastLoginAt: Date | null; createdAt: Date }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        role: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });
    if (!user) throw new UnauthorizedException('This account is no longer active');
    return user;
  }

  /**
   * Changes the caller's own password and revokes every other session, so a
   * password change actually ends access from a device someone else holds.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    client: ClientContext,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('This account is no longer active');

    const matches = await this.passwords.verify(user.passwordHash, currentPassword);
    if (!matches) {
      throw new DomainException('CURRENT_PASSWORD_INCORRECT', 'The current password is not correct', 400);
    }

    if (await this.passwords.verify(user.passwordHash, newPassword)) {
      throw new DomainException('PASSWORD_UNCHANGED', 'The new password must differ from the current one', 400);
    }

    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    await this.tokens.revokeAllForUser(userId);

    await this.audit.recordSafe({
      actorId: userId,
      action: AUDIT_ACTIONS.PASSWORD_CHANGED,
      entityType: 'User',
      entityId: userId,
      ip: client.ip,
      userAgent: client.userAgent,
    });
  }
}

function toAuthenticatedUser(user: {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  role: Role;
}): AuthenticatedUser {
  return { id: user.id, name: user.name, phone: user.phone, email: user.email, role: user.role };
}
