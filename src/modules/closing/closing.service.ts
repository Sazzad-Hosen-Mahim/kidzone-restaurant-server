import { Injectable } from '@nestjs/common';
import { paginationPage, paginationSkip, paginationTake } from '@common/dto/pagination-query.dto';
import { DayClosing, PaymentMethod, Prisma, Section } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@modules/audit/audit.service';
import { AUDIT_ACTIONS } from '@modules/audit/audit.constants';
import { BusinessCalendarService } from '@common/services/business-calendar.service';
import { DomainException, NotFoundDomainException } from '@common/exceptions/domain.exception';
import { PageResult, paginate } from '@common/http/api-response';
import { ClientInfo } from '@common/decorators/client-info.decorator';
import { AuthenticatedUser } from '@common/types/authenticated-user';
import { BusinessDate, fromDateColumn, toDateColumn } from '@common/utils/date.util';
import { CloseDayDto, QueryClosingsDto, ReopenDayDto } from './dto/closing.dto';

export interface ClosingPreview {
  section: Section;
  businessDate: BusinessDate;
  /** Revenue from completed transactions only; voids are excluded. */
  totalSales: number;
  transactionCount: number;
  /** Poisha per payment method, for reconciling each till and wallet. */
  expectedByMethod: Record<string, number>;
  /** What should physically be in the cash drawer. */
  expectedCash: number;
  totalDiscounts: number;
  voidCount: number;
  totalVoids: number;
  /** Kid Zone only: overtime settled at check-out on this date. */
  overtimeRevenue: number;
  isClosed: boolean;
  closing: DayClosing | null;
}

@Injectable()
export class ClosingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: BusinessCalendarService,
    private readonly audit: AuditService,
  ) {}

  /**
   * What the till *should* hold for a section on a business date.
   *
   * Built from the `payments` table rather than from sale totals, because that
   * is what reconciles against a physical drawer: a split payment puts part of
   * a sale in cash and part in bKash, and only the payment rows know which.
   * Payments attached to voided sales are excluded.
   */
  async preview(section: Section, date?: BusinessDate): Promise<ClosingPreview> {
    const businessDate = date ?? (await this.calendar.today());
    const dateColumn = toDateColumn(businessDate);

    const [byMethod, sales, voids, discounts, overtime, closing] = await Promise.all([
      this.paymentsByMethod(section, dateColumn),
      this.salesTotals(section, dateColumn, false),
      this.salesTotals(section, dateColumn, true),
      this.discountTotal(section, dateColumn),
      section === Section.KIDZONE ? this.overtimeTotal(dateColumn) : Promise.resolve(0),
      this.prisma.dayClosing.findUnique({
        where: { section_businessDate: { section, businessDate: dateColumn } },
      }),
    ]);

    const expectedByMethod: Record<string, number> = {};
    for (const method of Object.values(PaymentMethod)) {
      expectedByMethod[method] = byMethod[method] ?? 0;
    }

    return {
      section,
      businessDate,
      totalSales: sales.total,
      transactionCount: sales.count,
      expectedByMethod,
      expectedCash: expectedByMethod[PaymentMethod.CASH],
      totalDiscounts: discounts,
      voidCount: voids.count,
      totalVoids: voids.total,
      overtimeRevenue: overtime,
      isClosed: closing !== null && closing.reopenedAt === null,
      closing,
    };
  }

  /**
   * Closes a section's day.
   *
   * The expected figures are recomputed here rather than taken from the client,
   * so the recorded difference is genuinely "counted minus what the system
   * says". Re-closing a day that was reopened updates the same row and clears
   * the reopen marker, which keeps the unique (section, businessDate)
   * constraint meaningful.
   */
  async close(
    section: Section,
    dto: CloseDayDto,
    actor: AuthenticatedUser,
    client: ClientInfo,
  ): Promise<DayClosing & { preview: ClosingPreview }> {
    const businessDate = dto.date ?? (await this.calendar.today());
    const today = await this.calendar.today();

    if (businessDate > today) {
      throw new DomainException('CANNOT_CLOSE_FUTURE_DATE', 'A business day cannot be closed before it happens', 400, {
        businessDate,
        today,
      });
    }

    const preview = await this.preview(section, businessDate);

    if (preview.isClosed) {
      throw new DomainException(
        'DAY_ALREADY_CLOSED',
        `The ${sectionLabel(section)} has already been closed for ${businessDate}. An administrator must reopen it first.`,
        409,
        { closingId: preview.closing?.id, closedAt: preview.closing?.closedAt },
      );
    }

    const difference = dto.countedCash - preview.expectedCash;

    const closing = await this.prisma.runInTransaction(async (tx) => {
      const saved = await tx.dayClosing.upsert({
        where: { section_businessDate: { section, businessDate: toDateColumn(businessDate) } },
        create: {
          section,
          businessDate: toDateColumn(businessDate),
          expectedCash: preview.expectedCash,
          countedCash: dto.countedCash,
          difference,
          expectedByMethod: preview.expectedByMethod as Prisma.InputJsonValue,
          totalSales: preview.totalSales,
          totalVoids: preview.totalVoids,
          totalDiscounts: preview.totalDiscounts,
          transactionCount: preview.transactionCount,
          notes: dto.notes ?? null,
          closedById: actor.id,
        },
        update: {
          expectedCash: preview.expectedCash,
          countedCash: dto.countedCash,
          difference,
          expectedByMethod: preview.expectedByMethod as Prisma.InputJsonValue,
          totalSales: preview.totalSales,
          totalVoids: preview.totalVoids,
          totalDiscounts: preview.totalDiscounts,
          transactionCount: preview.transactionCount,
          notes: dto.notes ?? null,
          closedById: actor.id,
          closedAt: new Date(),
          // Re-closing clears the reopen marker, so the day locks again.
          reopenedAt: null,
          reopenedById: null,
          reopenReason: null,
        },
      });

      await this.audit.record(
        {
          actorId: actor.id,
          action: AUDIT_ACTIONS.DAY_CLOSED,
          entityType: 'DayClosing',
          entityId: saved.id,
          after: {
            section,
            businessDate,
            expectedCash: preview.expectedCash,
            countedCash: dto.countedCash,
            difference,
            totalSales: preview.totalSales,
            transactionCount: preview.transactionCount,
          },
          reason: dto.notes ?? null,
          ip: client.ip,
          userAgent: client.userAgent,
        },
        tx,
      );

      return saved;
    });

    return { ...closing, preview };
  }

  /** Unlocks a closed day. Admin only, reason required, audited. */
  async reopen(id: string, dto: ReopenDayDto, actor: AuthenticatedUser, client: ClientInfo): Promise<DayClosing> {
    const reason = dto.reason?.trim();
    if (!reason || reason.length < 5) {
      throw new DomainException(
        'REOPEN_REASON_REQUIRED',
        'A reason of at least 5 characters is required to reopen a closed day',
        400,
      );
    }

    const existing = await this.prisma.dayClosing.findUnique({ where: { id } });
    if (!existing) throw new NotFoundDomainException('Day closing', id);

    if (existing.reopenedAt) {
      throw new DomainException('DAY_ALREADY_REOPENED', 'This day has already been reopened', 409, {
        reopenedAt: existing.reopenedAt,
      });
    }

    return this.prisma.runInTransaction(async (tx) => {
      const reopened = await tx.dayClosing.update({
        where: { id },
        data: { reopenedAt: new Date(), reopenedById: actor.id, reopenReason: reason },
      });

      await this.audit.record(
        {
          actorId: actor.id,
          action: AUDIT_ACTIONS.DAY_REOPENED,
          entityType: 'DayClosing',
          entityId: id,
          before: {
            section: existing.section,
            businessDate: fromDateColumn(existing.businessDate),
            closedAt: existing.closedAt,
            difference: existing.difference,
          },
          after: { reopenedAt: reopened.reopenedAt },
          reason,
          ip: client.ip,
          userAgent: client.userAgent,
        },
        tx,
      );

      return reopened;
    });
  }

  async list(query: QueryClosingsDto): Promise<PageResult<unknown>> {
    const where: Prisma.DayClosingWhereInput = {
      ...(query.section ? { section: query.section } : {}),
      ...(query.from || query.to
        ? {
            businessDate: {
              ...(query.from ? { gte: toDateColumn(query.from) } : {}),
              ...(query.to ? { lte: toDateColumn(query.to) } : {}),
            },
          }
        : {}),
      ...(query.onlyDifferences ? { NOT: { difference: 0 } } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.dayClosing.findMany({
        where,
        orderBy: [{ businessDate: 'desc' }, { section: 'asc' }],
        skip: paginationSkip(query),
        take: paginationTake(query),
        include: { closedBy: { select: { id: true, name: true } } },
      }),
      this.prisma.dayClosing.count({ where }),
    ]);

    return paginate(
      items.map((closing) => ({
        ...closing,
        businessDate: fromDateColumn(closing.businessDate),
        // Surfaced so a UI can highlight a till that did not balance without
        // re-deriving the rule.
        hasDifference: closing.difference !== 0,
        isReopened: closing.reopenedAt !== null,
      })),
      total,
      paginationPage(query),
      paginationTake(query),
    );
  }

  // -------------------------------------------------------------------------
  // Aggregates, computed in SQL
  // -------------------------------------------------------------------------

  private async paymentsByMethod(section: Section, date: Date): Promise<Record<string, number>> {
    const rows = await this.prisma.payment.groupBy({
      by: ['method'],
      where: { businessDate: date, ...this.paymentSectionFilter(section) },
      _sum: { amount: true },
    });

    const out: Record<string, number> = {};
    for (const row of rows) out[row.method] = row._sum.amount ?? 0;
    return out;
  }

  /** Only payments whose parent transaction is still valid count toward the till. */
  private paymentSectionFilter(section: Section): Prisma.PaymentWhereInput {
    if (section === Section.KIDZONE) {
      return {
        OR: [
          { kidZoneSale: { status: 'COMPLETED' } },
          { visit: { is: {} } }, // overtime, which has no separate void path
        ],
      };
    }
    return { order: { status: 'PAID' } };
  }

  private async salesTotals(
    section: Section,
    date: Date,
    voided: boolean,
  ): Promise<{ total: number; count: number }> {
    if (section === Section.KIDZONE) {
      const result = await this.prisma.kidZoneSale.aggregate({
        where: { businessDate: date, status: voided ? 'VOIDED' : 'COMPLETED' },
        _sum: { totalAmount: true },
        _count: { _all: true },
      });
      return { total: result._sum.totalAmount ?? 0, count: result._count._all };
    }

    const result = await this.prisma.order.aggregate({
      where: { businessDate: date, status: voided ? 'VOIDED' : 'PAID' },
      _sum: { totalAmount: true },
      _count: { _all: true },
    });
    return { total: result._sum.totalAmount ?? 0, count: result._count._all };
  }

  private async discountTotal(section: Section, date: Date): Promise<number> {
    if (section === Section.KIDZONE) {
      const result = await this.prisma.kidZoneSale.aggregate({
        where: { businessDate: date, status: 'COMPLETED' },
        _sum: { discountAmount: true },
      });
      return result._sum.discountAmount ?? 0;
    }
    const result = await this.prisma.order.aggregate({
      where: { businessDate: date, status: 'PAID' },
      _sum: { discountAmount: true },
    });
    return result._sum.discountAmount ?? 0;
  }

  private async overtimeTotal(date: Date): Promise<number> {
    const result = await this.prisma.payment.aggregate({
      where: { businessDate: date, visitId: { not: null } },
      _sum: { amount: true },
    });
    return result._sum.amount ?? 0;
  }
}

function sectionLabel(section: Section): string {
  return section === Section.KIDZONE ? 'Kid Zone' : 'restaurant';
}
