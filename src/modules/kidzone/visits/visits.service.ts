import { Injectable } from '@nestjs/common';
import { paginationOrderBy, paginationPage, paginationSkip, paginationTake } from '@common/dto/pagination-query.dto';
import { Prisma, Section, VisitStatus } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@modules/audit/audit.service';
import { AUDIT_ACTIONS } from '@modules/audit/audit.constants';
import { PaymentsService } from '@modules/payments/payments.service';
import { DayLockService } from '@modules/closing/day-lock.service';
import { BusinessCalendarService } from '@common/services/business-calendar.service';
import { DomainException, NotFoundDomainException } from '@common/exceptions/domain.exception';
import { PageResult, paginate } from '@common/http/api-response';
import { ClientInfo } from '@common/decorators/client-info.decorator';
import { AuthenticatedUser } from '@common/types/authenticated-user';
import { fromDateColumn, toDateColumn } from '@common/utils/date.util';
import { formatPoisha } from '@common/utils/money.util';
import { OvertimePlanTerms, calculateOvertime, sessionProgress } from '../domain/overtime';
import { CheckOutDto, QueryVisitsDto } from './dto/visit.dto';

const SORTABLE = ['checkInAt', 'checkOutAt', 'businessDate', 'createdAt'] as const;

/** A visit with everything needed to price its overtime. */
const VISIT_INCLUDE = {
  child: { select: { id: true, name: true, medicalNotes: true } },
  customer: { select: { id: true, name: true, phone: true } },
  membership: { select: { id: true, endDate: true, planId: true } },
  sale: {
    select: {
      id: true,
      receiptNo: true,
      planNameSnapshot: true,
      plan: {
        select: {
          id: true,
          name: true,
          sessionMinutes: true,
          gracePeriodMinutes: true,
          overtimeBlockMinutes: true,
          overtimeRatePerBlock: true,
        },
      },
    },
  },
  checkedInBy: { select: { id: true, name: true } },
  checkedOutBy: { select: { id: true, name: true } },
} satisfies Prisma.VisitInclude;

type VisitWithRelations = Prisma.VisitGetPayload<{ include: typeof VISIT_INCLUDE }>;

@Injectable()
export class VisitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly calendar: BusinessCalendarService,
    private readonly dayLock: DayLockService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The live board at the gate: who is inside, how long they have left, and who
   * is running over.
   *
   * Sorted so anyone in overtime is at the top — that is the list the staff act
   * on — with the visits closest to their end time next.
   */
  async listActive(): Promise<unknown[]> {
    const visits = await this.prisma.visit.findMany({
      where: { status: VisitStatus.ACTIVE },
      include: VISIT_INCLUDE,
      orderBy: { checkInAt: 'asc' },
    });

    const now = new Date();

    const rows = visits.map((visit) => {
      const terms = termsFor(visit);
      const progress = sessionProgress(visit.checkInAt, now, terms);
      const projected = calculateOvertime(visit.checkInAt, now, terms);

      return {
        ...this.serialize(visit),
        elapsedMinutes: progress.elapsedMinutes,
        remainingMinutes: progress.remainingMinutes,
        isOvertime: progress.isOvertime,
        withinGrace: progress.withinGrace,
        projectedOvertimeMinutes: projected.overtimeMinutes,
        projectedOvertimeCharge: projected.overtimeCharge,
      };
    });

    return rows.sort((a, b) => {
      if (a.isOvertime !== b.isOvertime) return a.isOvertime ? -1 : 1;
      // Both overtime, or neither: whoever is closest to (or furthest past)
      // their end time first.
      const aRemaining = a.remainingMinutes ?? Number.MAX_SAFE_INTEGER;
      const bRemaining = b.remainingMinutes ?? Number.MAX_SAFE_INTEGER;
      return aRemaining - bRemaining;
    });
  }

  /**
   * Checks a child out.
   *
   * Overtime is computed here rather than trusted from the client, and when
   * anything is owed the request must carry payments covering exactly that
   * amount — the child does not leave with an unpaid balance, and the day-end
   * cash count stays correct.
   */
  async checkOut(
    id: string,
    dto: CheckOutDto,
    actor: AuthenticatedUser,
    client: ClientInfo,
  ): Promise<unknown> {
    const visit = await this.prisma.visit.findUnique({ where: { id }, include: VISIT_INCLUDE });
    if (!visit) throw new NotFoundDomainException('Visit', id);

    if (visit.status === VisitStatus.COMPLETED) {
      throw new DomainException('VISIT_ALREADY_COMPLETED', 'This visit has already been checked out', 409, {
        checkOutAt: visit.checkOutAt,
      });
    }

    const checkOutAt = new Date();
    const overtime = calculateOvertime(visit.checkInAt, checkOutAt, termsFor(visit));

    // Overtime is settled on the day the child leaves, which may differ from
    // the day they arrived if the Kid Zone runs past midnight.
    const paymentDate = await this.calendar.businessDateOf(checkOutAt);

    if (overtime.overtimeCharge > 0) {
      await this.dayLock.assertOpen(Section.KIDZONE, paymentDate, 'Settling overtime at check-out');

      if (!dto.payments || dto.payments.length === 0) {
        throw new DomainException(
          'OVERTIME_PAYMENT_REQUIRED',
          `${formatPoisha(overtime.overtimeCharge)} of overtime is owed (${overtime.overtimeMinutes} minutes, ${overtime.blocks} block(s)). Supply payments covering it to complete the check-out.`,
          402,
          {
            overtimeMinutes: overtime.overtimeMinutes,
            blocks: overtime.blocks,
            overtimeCharge: overtime.overtimeCharge,
          },
        );
      }

      this.payments.assertSettlesExactly(dto.payments, overtime.overtimeCharge);
    } else if (dto.payments && dto.payments.length > 0) {
      throw new DomainException(
        'NO_OVERTIME_DUE',
        'No overtime is owed for this visit, so no payment should be taken',
        422,
        { elapsedMinutes: overtime.elapsedMinutes },
      );
    }

    const updated = await this.prisma.runInTransaction(async (tx) => {
      const result = await tx.visit.update({
        where: { id },
        data: {
          checkOutAt,
          checkedOutById: actor.id,
          status: VisitStatus.COMPLETED,
          overtimeMinutes: overtime.overtimeMinutes,
          overtimeCharge: overtime.overtimeCharge,
        },
        include: VISIT_INCLUDE,
      });

      if (overtime.overtimeCharge > 0 && dto.payments) {
        await this.payments.createMany(
          tx,
          dto.payments,
          { visitId: id },
          { receivedById: actor.id, businessDate: paymentDate },
        );
      }

      await this.audit.record(
        {
          actorId: actor.id,
          action: AUDIT_ACTIONS.CHECK_OUT,
          entityType: 'Visit',
          entityId: id,
          after: {
            gatepassNo: visit.gatepassNo,
            elapsedMinutes: overtime.elapsedMinutes,
            overtimeMinutes: overtime.overtimeMinutes,
            overtimeCharge: overtime.overtimeCharge,
          },
          ip: client.ip,
          userAgent: client.userAgent,
        },
        tx,
      );

      if (overtime.overtimeCharge > 0) {
        await this.audit.record(
          {
            actorId: actor.id,
            action: AUDIT_ACTIONS.OVERTIME_CHARGED,
            entityType: 'Visit',
            entityId: id,
            after: {
              overtimeMinutes: overtime.overtimeMinutes,
              blocks: overtime.blocks,
              overtimeCharge: overtime.overtimeCharge,
              businessDate: paymentDate,
            },
            ip: client.ip,
            userAgent: client.userAgent,
          },
          tx,
        );
      }

      return result;
    });

    return {
      ...this.serialize(updated),
      elapsedMinutes: overtime.elapsedMinutes,
      overtimeBlocks: overtime.blocks,
    };
  }

  async list(query: QueryVisitsDto): Promise<PageResult<unknown>> {
    const where: Prisma.VisitWhereInput = {
      ...(query.childId ? { childId: query.childId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.membershipId ? { membershipId: query.membershipId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.verificationMethod ? { verificationMethod: query.verificationMethod } : {}),
      ...(query.from || query.to
        ? {
            businessDate: {
              ...(query.from ? { gte: toDateColumn(query.from) } : {}),
              ...(query.to ? { lte: toDateColumn(query.to) } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { gatepassNo: { contains: query.search, mode: 'insensitive' } },
              { child: { name: { contains: query.search, mode: 'insensitive' } } },
              { customer: { phone: { contains: query.search } } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.visit.findMany({
        where,
        include: VISIT_INCLUDE,
        orderBy: paginationOrderBy(query, SORTABLE, 'checkInAt'),
        skip: paginationSkip(query),
        take: paginationTake(query),
      }),
      this.prisma.visit.count({ where }),
    ]);

    return paginate(items.map((v) => this.serialize(v)), total, paginationPage(query), paginationTake(query));
  }

  async findOne(id: string): Promise<unknown> {
    const visit = await this.prisma.visit.findUnique({ where: { id }, include: VISIT_INCLUDE });
    if (!visit) throw new NotFoundDomainException('Visit', id);
    return this.serialize(visit);
  }

  private serialize(visit: VisitWithRelations) {
    return {
      ...visit,
      businessDate: fromDateColumn(visit.businessDate),
      membership: visit.membership
        ? { ...visit.membership, endDate: fromDateColumn(visit.membership.endDate) }
        : null,
    };
  }
}

/**
 * Overtime terms for a visit.
 *
 * A one-time session takes them from the plan it was sold on. A membership
 * visit is open ended — nothing to run over — so it gets a null session length
 * and is never charged.
 */
function termsFor(visit: VisitWithRelations): OvertimePlanTerms {
  const plan = visit.sale?.plan;
  if (!plan) {
    return { sessionMinutes: null, gracePeriodMinutes: 0, overtimeBlockMinutes: null, overtimeRatePerBlock: null };
  }
  return {
    sessionMinutes: plan.sessionMinutes,
    gracePeriodMinutes: plan.gracePeriodMinutes,
    overtimeBlockMinutes: plan.overtimeBlockMinutes,
    overtimeRatePerBlock: plan.overtimeRatePerBlock,
  };
}
