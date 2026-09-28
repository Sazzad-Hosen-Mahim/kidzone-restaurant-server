import { Injectable } from '@nestjs/common';
import { paginationOrderBy, paginationPage, paginationSkip, paginationTake } from '@common/dto/pagination-query.dto';
import { MembershipStatus, Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { SettingsService } from '@modules/settings/settings.service';
import { AuditService } from '@modules/audit/audit.service';
import { AUDIT_ACTIONS } from '@modules/audit/audit.constants';
import { BusinessCalendarService } from '@common/services/business-calendar.service';
import { DomainException, NotFoundDomainException } from '@common/exceptions/domain.exception';
import { ClientInfo } from '@common/decorators/client-info.decorator';
import { AuthenticatedUser } from '@common/types/authenticated-user';
import { PageResult, paginate } from '@common/http/api-response';
import { addDays, fromDateColumn, toDateColumn } from '@common/utils/date.util';
import { daysRemaining, generateQrToken, isExpiringSoon } from '../domain/membership';
import { QueryMembershipsDto } from './dto/query-memberships.dto';
import { ReissueQrDto } from './dto/qr-card.dto';

const SORTABLE = ['endDate', 'startDate', 'createdAt'] as const;

/**
 * Sorts that are not a plain column. The list shows each status as days left,
 * so "status" groups by status and orders by end date within each group; that
 * keeps the badges in the order they read. `id` breaks ties so a page boundary
 * never shows the same membership twice or skips one.
 */
function membershipOrderBy(query: QueryMembershipsDto): Prisma.MembershipOrderByWithRelationInput[] {
  const order = query.order ?? 'desc';
  if (query.sort === 'visitCount') return [{ visits: { _count: order } }, { id: 'asc' }];
  if (query.sort === 'status') return [{ status: order }, { endDate: order }, { id: 'asc' }];
  if (!query.sort) return [{ endDate: 'asc' }, { id: 'asc' }];
  return [paginationOrderBy(query, SORTABLE, 'endDate'), { id: 'asc' }];
}

/** Everything needed to print a membership card, including the gate credential. */
export interface QrCard {
  membershipId: string;
  /** The value to encode in the QR square, and to POST to `/kidzone/checkin/qr`. */
  qrToken: string;
  status: MembershipStatus;
  startDate: string;
  endDate: string;
  daysRemaining: number;
  /** False when the card would be refused at the gate today, with `blockedReason` saying why. */
  usable: boolean;
  blockedReason: string | null;
  child: { id: string; name: string };
  customer: { id: string; name: string; phone: string };
  plan: { id: string; name: string };
}

@Injectable()
export class MembershipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly calendar: BusinessCalendarService,
    private readonly audit: AuditService,
  ) {}

  async list(query: QueryMembershipsDto): Promise<PageResult<unknown>> {
    const today = await this.calendar.today();
    const expiryReminderDays = await this.settings.get('expiryReminderDays');

    const where: Prisma.MembershipWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.childId ? { childId: query.childId } : {}),
      ...(query.planId ? { planId: query.planId } : {}),
      ...(query.expiringWithinDays !== undefined
        ? {
            status: MembershipStatus.ACTIVE,
            endDate: { gte: toDateColumn(today), lte: toDateColumn(addDays(today, query.expiringWithinDays)) },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { customer: { name: { contains: query.search, mode: 'insensitive' } } },
              { customer: { phone: { contains: query.search } } },
              { child: { name: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.membership.findMany({
        where,
        orderBy: membershipOrderBy(query),
        skip: paginationSkip(query),
        take: paginationTake(query),
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          child: { select: { id: true, name: true } },
          plan: { select: { id: true, name: true, durationDays: true } },
          _count: { select: { visits: true } },
        },
      }),
      this.prisma.membership.count({ where }),
    ]);

    return paginate(
      items.map((m) => {
        const endDate = fromDateColumn(m.endDate);
        return {
          ...m,
          // The QR token is a bearer credential for the gate; it is only ever
          // handed out through the receipt/gatepass endpoints, never in a list.
          qrToken: undefined,
          startDate: fromDateColumn(m.startDate),
          endDate,
          daysRemaining: daysRemaining(endDate, today),
          expiringSoon: isExpiringSoon(endDate, today, expiryReminderDays),
          visitCount: m._count.visits,
        };
      }),
      total,
      paginationPage(query),
      paginationTake(query),
    );
  }

  async findOne(id: string): Promise<unknown> {
    const membership = await this.prisma.membership.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        child: { select: { id: true, name: true, dateOfBirth: true, medicalNotes: true } },
        plan: true,
        sale: { select: { id: true, receiptNo: true, totalAmount: true, status: true } },
        renewedFrom: { select: { id: true, endDate: true } },
        renewedTo: { select: { id: true, startDate: true, endDate: true } },
        visits: { orderBy: { checkInAt: 'desc' }, take: 50 },
      },
    });
    if (!membership) throw new NotFoundDomainException('Membership', id);

    const today = await this.calendar.today();
    const expiryReminderDays = await this.settings.get('expiryReminderDays');
    const endDate = fromDateColumn(membership.endDate);

    return {
      ...membership,
      qrToken: undefined,
      startDate: fromDateColumn(membership.startDate),
      endDate,
      daysRemaining: daysRemaining(endDate, today),
      expiringSoon: isExpiringSoon(endDate, today, expiryReminderDays),
      visits: membership.visits.map((v) => ({ ...v, businessDate: fromDateColumn(v.businessDate) })),
    };
  }

  /**
   * The membership card: the QR token plus the names and dates printed beside
   * it.
   *
   * This is the **only** read that hands the token back out — every other
   * endpoint strips it, because it is a bearer credential: anyone holding it
   * can check the child in. So the fetch is audited like any other privileged
   * action, and staff have to ask for it deliberately rather than receive it in
   * a list they happened to load.
   */
  async qrCard(id: string, actor: AuthenticatedUser, client: ClientInfo): Promise<QrCard> {
    const card = await this.buildCard(id);

    await this.audit.recordSafe({
      actorId: actor.id,
      action: AUDIT_ACTIONS.MEMBERSHIP_QR_ISSUED,
      entityType: 'Membership',
      entityId: id,
      // Deliberately not the token itself: the audit log is readable by every
      // admin and would otherwise become a list of working gate credentials.
      after: { childName: card.child.name, printedFor: card.customer.phone },
      ip: client.ip,
      userAgent: client.userAgent,
    });

    return card;
  }

  /**
   * Rotates the token, invalidating the printed card.
   *
   * For a card that was lost rather than merely mislaid. The old token stops
   * working the instant this returns, which is the point — but it also locks a
   * paying customer out until the new card is printed, so a reason is required
   * and the rotation is audited non-safely: if the audit row cannot be written,
   * the token is not rotated either.
   */
  async reissueQr(
    id: string,
    dto: ReissueQrDto,
    actor: AuthenticatedUser,
    client: ClientInfo,
  ): Promise<QrCard> {
    const existing = await this.prisma.membership.findUnique({ where: { id }, select: { status: true } });
    if (!existing) throw new NotFoundDomainException('Membership', id);

    if (existing.status === MembershipStatus.CANCELLED) {
      throw new DomainException(
        'MEMBERSHIP_CANCELLED',
        'A cancelled membership cannot be issued a new card',
        409,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.membership.update({ where: { id }, data: { qrToken: generateQrToken() } });
      await this.audit.record(
        {
          actorId: actor.id,
          action: AUDIT_ACTIONS.MEMBERSHIP_QR_REISSUED,
          entityType: 'Membership',
          entityId: id,
          after: { tokenRotated: true, previousCardRevoked: true },
          reason: dto.reason.trim(),
          ip: client.ip,
          userAgent: client.userAgent,
        },
        tx,
      );
    });

    return this.buildCard(id);
  }

  private async buildCard(id: string): Promise<QrCard> {
    const membership = await this.prisma.membership.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        child: { select: { id: true, name: true } },
        plan: { select: { id: true, name: true } },
      },
    });
    if (!membership) throw new NotFoundDomainException('Membership', id);

    const today = await this.calendar.today();
    const startDate = fromDateColumn(membership.startDate);
    const endDate = fromDateColumn(membership.endDate);

    // The same three refusals the gate applies, resolved here so the card can
    // say "this will not work" before anyone walks it to the door.
    const blockedReason =
      membership.status === MembershipStatus.CANCELLED
        ? 'This membership has been cancelled.'
        : endDate < today
          ? `This membership ended on ${endDate}.`
          : startDate > today
            ? `This membership does not start until ${startDate}.`
            : null;

    return {
      membershipId: membership.id,
      qrToken: membership.qrToken,
      status: membership.status,
      startDate,
      endDate,
      daysRemaining: daysRemaining(endDate, today),
      usable: blockedReason === null,
      blockedReason,
      child: membership.child,
      customer: membership.customer,
      plan: membership.plan,
    };
  }

  /**
   * Marks memberships whose end date has passed as EXPIRED. Run by the daily
   * 00:05 job and safe to run again at any time — it only touches ACTIVE rows
   * that are genuinely past their end date.
   */
  async expirePastDue(today: string): Promise<number> {
    const { count } = await this.prisma.membership.updateMany({
      where: { status: MembershipStatus.ACTIVE, endDate: { lt: toDateColumn(today) } },
      data: { status: MembershipStatus.EXPIRED },
    });
    return count;
  }
}
