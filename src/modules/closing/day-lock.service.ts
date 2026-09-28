import { Injectable } from '@nestjs/common';
import { Section } from '@prisma/client';
import { PrismaService, PrismaExecutor } from '@/prisma/prisma.service';
import { DomainException } from '@common/exceptions/domain.exception';
import { BusinessDate, fromDateColumn, toDateColumn } from '@common/utils/date.util';

/**
 * Enforces the day-end lock.
 *
 * Once a section's day is closed, its cash has been counted and reported; a new
 * sale, a void or an overtime charge dated to that day would silently
 * invalidate the closing. So every write that carries a business date checks
 * here first, and only an admin reopening the day can unlock it.
 *
 * A closing row that has been reopened (`reopenedAt` set) does not lock.
 */
@Injectable()
export class DayLockService {
  constructor(private readonly prisma: PrismaService) {}

  async isClosed(section: Section, businessDate: BusinessDate, tx?: PrismaExecutor): Promise<boolean> {
    const client = tx ?? this.prisma;
    const closing = await client.dayClosing.findUnique({
      where: { section_businessDate: { section, businessDate: toDateColumn(businessDate) } },
      select: { reopenedAt: true },
    });
    return closing !== null && closing.reopenedAt === null;
  }

  /**
   * Throws `DAY_ALREADY_CLOSED` when the section's day is locked.
   * `action` is woven into the message so the cashier is told what to do next.
   */
  async assertOpen(
    section: Section,
    businessDate: BusinessDate,
    action = 'This change',
    tx?: PrismaExecutor,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    const closing = await client.dayClosing.findUnique({
      where: { section_businessDate: { section, businessDate: toDateColumn(businessDate) } },
      select: { id: true, closedAt: true, reopenedAt: true },
    });

    if (!closing || closing.reopenedAt !== null) return;

    throw new DomainException(
      'DAY_ALREADY_CLOSED',
      `${action} affects ${businessDate}, which has already been closed for the ${sectionLabel(section)}. An administrator must reopen that day first.`,
      409,
      {
        section,
        businessDate,
        closingId: closing.id,
        closedAt: closing.closedAt,
      },
    );
  }

  /** The most recent closed business date for a section, or null. */
  async lastClosedDate(section: Section): Promise<BusinessDate | null> {
    const closing = await this.prisma.dayClosing.findFirst({
      where: { section, reopenedAt: null },
      orderBy: { businessDate: 'desc' },
      select: { businessDate: true },
    });
    return closing ? fromDateColumn(closing.businessDate) : null;
  }
}

function sectionLabel(section: Section): string {
  return section === Section.KIDZONE ? 'Kid Zone' : 'restaurant';
}
