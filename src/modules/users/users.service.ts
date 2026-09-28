import { Injectable } from '@nestjs/common';
import { paginationOrderBy, paginationPage, paginationSkip, paginationTake } from '@common/dto/pagination-query.dto';
import { Prisma, Role, User } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@modules/audit/audit.service';
import { AUDIT_ACTIONS } from '@modules/audit/audit.constants';
import { PasswordService } from '@modules/auth/password.service';
import { TokenService } from '@modules/auth/token.service';
import { DomainException, NotFoundDomainException } from '@common/exceptions/domain.exception';
import { PageResult, paginate } from '@common/http/api-response';
import { ClientInfo } from '@common/decorators/client-info.decorator';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';

/** Columns a user may be sorted by. Anything else falls back to createdAt. */
const SORTABLE = ['createdAt', 'name', 'role', 'lastLoginAt'] as const;

/** Never select the password hash. */
const PUBLIC_FIELDS = {
  id: true,
  name: true,
  phone: true,
  email: true,
  role: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export type PublicUser = Prisma.UserGetPayload<{ select: typeof PUBLIC_FIELDS }>;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async list(query: QueryUsersDto): Promise<PageResult<PublicUser>> {
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(query.role ? { role: query.role } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { phone: { contains: query.search } },
              { email: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: PUBLIC_FIELDS,
        orderBy: paginationOrderBy(query, SORTABLE, 'createdAt'),
        skip: paginationSkip(query),
        take: paginationTake(query),
      }),
      this.prisma.user.count({ where }),
    ]);

    return paginate(items, total, paginationPage(query), paginationTake(query));
  }

  async findOne(id: string): Promise<PublicUser> {
    const user = await this.prisma.user.findFirst({ where: { id, deletedAt: null }, select: PUBLIC_FIELDS });
    if (!user) throw new NotFoundDomainException('User', id);
    return user;
  }

  async create(dto: CreateUserDto, actor: { id: string }, client: ClientInfo): Promise<PublicUser> {
    await this.assertPhoneAndEmailFree(dto.phone, dto.email);

    const passwordHash = await this.passwords.hash(dto.password);

    const user = await this.prisma.user.create({
      data: {
        name: dto.name,
        phone: dto.phone,
        email: dto.email ?? null,
        passwordHash,
        role: dto.role,
      },
      select: PUBLIC_FIELDS,
    });

    await this.audit.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.USER_CREATED,
      entityType: 'User',
      entityId: user.id,
      after: user,
      ip: client.ip,
      userAgent: client.userAgent,
    });

    return user;
  }

  /**
   * Updates a staff account.
   *
   * Two invariants are enforced here rather than in the controller, so they hold
   * for every caller: an admin cannot deactivate or demote themselves, and the
   * system always keeps at least one active admin.
   */
  async update(id: string, dto: UpdateUserDto, actor: { id: string }, client: ClientInfo): Promise<PublicUser> {
    const existing = await this.prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundDomainException('User', id);

    const deactivating = dto.isActive === false && existing.isActive;
    const demotingFromAdmin = dto.role !== undefined && dto.role !== Role.ADMIN && existing.role === Role.ADMIN;

    if (id === actor.id && deactivating) {
      throw new DomainException('CANNOT_DEACTIVATE_SELF', 'You cannot deactivate your own account', 400);
    }
    if (id === actor.id && demotingFromAdmin) {
      throw new DomainException('CANNOT_DEMOTE_SELF', 'You cannot remove your own admin role', 400);
    }

    if ((deactivating || demotingFromAdmin) && existing.role === Role.ADMIN) {
      await this.assertNotLastActiveAdmin(id);
    }

    if (dto.phone && dto.phone !== existing.phone) {
      await this.assertPhoneAndEmailFree(dto.phone, undefined, id);
    }
    if (dto.email !== undefined && dto.email !== existing.email) {
      await this.assertPhoneAndEmailFree(undefined, dto.email ?? undefined, id);
    }

    const user = await this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.email !== undefined ? { email: dto.email || null } : {}),
        ...(dto.role !== undefined ? { role: dto.role } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
      select: PUBLIC_FIELDS,
    });

    // Losing access must be immediate, so a deactivation or a role change also
    // kills every live session for that account.
    if (deactivating || (dto.role !== undefined && dto.role !== existing.role)) {
      await this.tokens.revokeAllForUser(id);
    }

    await this.audit.record({
      actorId: actor.id,
      action: deactivating
        ? AUDIT_ACTIONS.USER_DEACTIVATED
        : dto.isActive === true && !existing.isActive
          ? AUDIT_ACTIONS.USER_REACTIVATED
          : AUDIT_ACTIONS.USER_UPDATED,
      entityType: 'User',
      entityId: id,
      before: redact(existing),
      after: user,
      ip: client.ip,
      userAgent: client.userAgent,
    });

    return user;
  }

  /**
   * Soft delete. The row stays so that historical sales, visits and audit
   * entries keep resolving to a real name.
   */
  async deactivate(id: string, actor: { id: string }, client: ClientInfo): Promise<PublicUser> {
    const existing = await this.prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundDomainException('User', id);

    if (id === actor.id) {
      throw new DomainException('CANNOT_DEACTIVATE_SELF', 'You cannot deactivate your own account', 400);
    }
    if (existing.role === Role.ADMIN) {
      await this.assertNotLastActiveAdmin(id);
    }

    const user = await this.prisma.user.update({
      where: { id },
      data: { isActive: false, deletedAt: new Date() },
      select: PUBLIC_FIELDS,
    });

    await this.tokens.revokeAllForUser(id);

    await this.audit.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.USER_DEACTIVATED,
      entityType: 'User',
      entityId: id,
      before: redact(existing),
      after: user,
      ip: client.ip,
      userAgent: client.userAgent,
    });

    return user;
  }

  /**
   * Resets someone else's password. Returns the generated password exactly once
   * when the admin did not supply one; it is never stored in plain text or
   * written to the audit entry.
   */
  async resetPassword(
    id: string,
    newPassword: string | undefined,
    actor: { id: string },
    client: ClientInfo,
  ): Promise<{ generatedPassword?: string }> {
    const existing = await this.prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundDomainException('User', id);

    const generated = newPassword ? undefined : generatePassword();
    const password = newPassword ?? generated!;

    await this.prisma.user.update({
      where: { id },
      data: { passwordHash: await this.passwords.hash(password) },
    });

    await this.tokens.revokeAllForUser(id);

    await this.audit.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.PASSWORD_RESET,
      entityType: 'User',
      entityId: id,
      reason: generated ? 'Password generated by the system' : 'Password set by an administrator',
      ip: client.ip,
      userAgent: client.userAgent,
    });

    return generated ? { generatedPassword: generated } : {};
  }

  private async assertPhoneAndEmailFree(phone?: string, email?: string, exceptId?: string): Promise<void> {
    if (phone) {
      const clash = await this.prisma.user.findFirst({ where: { phone, ...(exceptId ? { NOT: { id: exceptId } } : {}) } });
      if (clash) {
        throw new DomainException('PHONE_ALREADY_IN_USE', 'Another staff account already uses this phone number', 409);
      }
    }
    if (email) {
      const clash = await this.prisma.user.findFirst({ where: { email, ...(exceptId ? { NOT: { id: exceptId } } : {}) } });
      if (clash) {
        throw new DomainException('EMAIL_ALREADY_IN_USE', 'Another staff account already uses this email address', 409);
      }
    }
  }

  private async assertNotLastActiveAdmin(excludingId: string): Promise<void> {
    const remaining = await this.prisma.user.count({
      where: { role: Role.ADMIN, isActive: true, deletedAt: null, NOT: { id: excludingId } },
    });
    if (remaining === 0) {
      throw new DomainException(
        'LAST_ACTIVE_ADMIN',
        'The system must keep at least one active administrator. Promote another user first.',
        400,
      );
    }
  }
}

function redact(user: User): Omit<User, 'passwordHash'> {
  const { passwordHash: _ignored, ...rest } = user;
  return rest;
}

/** A readable but strong password: 4 groups of 4 base32-ish characters. */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) out += '-';
    out += alphabet[bytes[i] % alphabet.length];
  }
  // Guarantee the generated value satisfies the password policy.
  return `${out}9Aa`;
}
