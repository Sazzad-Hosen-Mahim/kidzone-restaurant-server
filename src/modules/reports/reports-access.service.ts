import { Injectable } from '@nestjs/common';
import { Role, Section } from '@prisma/client';
import { BusinessCalendarService } from '@common/services/business-calendar.service';
import { ForbiddenDomainException } from '@common/exceptions/domain.exception';
import { AuthenticatedUser, sectionsFor } from '@common/types/authenticated-user';
import { inclusiveDayCount } from '@common/utils/date.util';
import { ReportPeriod } from './reports.types';
import { ReportQueryDto } from './dto/report-query.dto';

/**
 * The access rules for reporting, in one place.
 *
 * Staff get **today, their own section, on screen**. An admin gets any period,
 * either section, and the file exports.
 *
 * The restriction to today is the substantive one: a manager needs to know how
 * the shift is going, but a month of revenue history is the owner's business,
 * and letting staff pull arbitrary historical ranges would quietly hand it to
 * them.
 */
@Injectable()
export class ReportsAccessService {
  constructor(private readonly calendar: BusinessCalendarService) {}

  /**
   * Resolves the requested range, refusing anything the caller's role does not
   * cover.
   */
  async resolvePeriod(query: ReportQueryDto, user: AuthenticatedUser, section: Section): Promise<ReportPeriod> {
    this.assertSection(user, section);

    if (user.role !== Role.ADMIN) {
      const isToday =
        query.range === 'today' || (query.range === 'custom' && query.from === query.to && await this.isToday(query.from));

      if (!isToday) {
        throw new ForbiddenDomainException(
          'REPORT_RANGE_NOT_PERMITTED',
          'Your role may only view today’s figures. Ask an administrator for historical reports.',
          { allowedRange: 'today', requestedRange: query.range },
        );
      }
    }

    const resolved = await this.calendar.resolveRange(query.range, { from: query.from, to: query.to });
    const options = await this.calendar.options();

    return {
      range: resolved.key,
      from: resolved.from,
      to: resolved.to,
      days: inclusiveDayCount(resolved),
      previous: resolved.previous,
      timezone: options.timezone,
    };
  }

  /** File exports are an admin capability, whatever the range. */
  assertMayExport(user: AuthenticatedUser, format: string | undefined): void {
    if (!format) return;
    if (user.role !== Role.ADMIN) {
      throw new ForbiddenDomainException(
        'EXPORT_NOT_PERMITTED',
        'Only an administrator may export reports to a file',
      );
    }
  }

  assertSection(user: AuthenticatedUser, section: Section): void {
    if (!sectionsFor(user.role).includes(section)) {
      throw new ForbiddenDomainException(
        'SECTION_NOT_PERMITTED',
        `Your role (${user.role}) may not view ${section === Section.KIDZONE ? 'Kid Zone' : 'restaurant'} reports`,
      );
    }
  }

  private async isToday(date: string | undefined): Promise<boolean> {
    if (!date) return false;
    return date === (await this.calendar.today());
  }
}
