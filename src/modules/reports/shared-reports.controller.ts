import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import { Roles } from '@common/decorators/roles.decorator';
import { RawResponse } from '@common/decorators/raw-response.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { AuthenticatedUser } from '@common/types/authenticated-user';
import { BusinessCalendarService } from '@common/services/business-calendar.service';
import { inclusiveDayCount } from '@common/utils/date.util';
import { SharedReportsService } from './shared-reports.service';
import { ReportExportService } from './report-export.service';
import { ReportQueryDto, SectionReportQueryDto } from './dto/report-query.dto';
import { ReportPeriod } from './reports.types';
import { envelope } from './kidzone-reports.controller';

/**
 * Reports that span both sections. Admin only throughout: a manager who could
 * read these would see the other section's revenue.
 */
@ApiTags('Reports')
@ApiBearerAuth('access-token')
@Controller('reports')
export class SharedReportsController {
  constructor(
    private readonly reports: SharedReportsService,
    private readonly exporter: ReportExportService,
    private readonly calendar: BusinessCalendarService,
  ) {}

  @Get('payment-methods')
  @Roles(Role.ADMIN)
  @RawResponse()
  @ApiProduces('application/json', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/pdf')
  @ApiOperation({
    summary: 'Totals per payment method',
    description:
      'Built from payment rows, so a split payment counts once per tender — which is what reconciles against each wallet’s own statement. Payments belonging to voided transactions are excluded. Use `section` to narrow to one side of the business.',
  })
  async paymentMethods(
    @Query() query: SectionReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const period = await this.period(query);
    const data = await this.reports.paymentMethods(period, query.section);

    if (this.exporter.isExport(query.export)) {
      return this.exporter.deliver(response, query.export, 'Payment Methods', period, [
        {
          name: 'Payment methods',
          columns: [
            { header: 'Method', key: 'method' },
            { header: 'Payments', key: 'count', type: 'number' },
            { header: 'Total (BDT)', key: 'total', type: 'money' },
            { header: 'Share', key: 'share', type: 'percent' },
          ],
          rows: data.methods,
          totals: {
            method: 'Total',
            count: data.methods.reduce((n, m) => n + m.count, 0),
            total: data.total,
          },
        },
      ]);
    }

    return envelope(period, data);
  }

  @Get('discounts-voids')
  @Roles(Role.ADMIN)
  @RawResponse()
  @ApiOperation({
    summary: 'Every discount and void, with who, when, how much and why',
    description:
      'The oversight report: the two ways money leaves the business without a customer complaining about it. Also rolled up per member of staff, which is how it actually gets reviewed.',
  })
  async discountsVoids(
    @Query() query: SectionReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const period = await this.period(query);
    const data = await this.reports.discountsAndVoids(period, query.section);

    if (this.exporter.isExport(query.export)) {
      return this.exporter.deliver(
        response,
        query.export,
        'Discounts and Voids',
        period,
        [
          {
            name: 'Discounts',
            columns: [
              { header: 'Section', key: 'section' },
              { header: 'Receipt', key: 'receiptNo' },
              { header: 'Date', key: 'businessDate', type: 'date' },
              { header: 'By', key: 'byName' },
              { header: 'Subtotal (BDT)', key: 'subtotal', type: 'money' },
              { header: 'Discount (BDT)', key: 'discountAmount', type: 'money' },
              { header: '%', key: 'discountPercent', type: 'percent' },
              { header: 'Reason', key: 'reason' },
            ],
            rows: (data.discounts as Array<Record<string, unknown>>).map(flattenActor('by')),
          },
          {
            name: 'Voids',
            columns: [
              { header: 'Section', key: 'section' },
              { header: 'Receipt', key: 'receiptNo' },
              { header: 'Date', key: 'businessDate', type: 'date' },
              { header: 'Voided by', key: 'voidedByName' },
              { header: 'Amount (BDT)', key: 'amount', type: 'money' },
              { header: 'Reason', key: 'reason' },
            ],
            rows: (data.voids as Array<Record<string, unknown>>).map(flattenActor('voidedBy')),
          },
          {
            name: 'By staff',
            columns: [
              { header: 'Staff', key: 'name' },
              { header: 'Discounts', key: 'discountCount', type: 'number' },
              { header: 'Discount value (BDT)', key: 'discountAmount', type: 'money' },
              { header: 'Voids', key: 'voidCount', type: 'number' },
              { header: 'Voided value (BDT)', key: 'voidAmount', type: 'money' },
            ],
            rows: data.byStaff as Array<Record<string, unknown>>,
          },
        ],
        { landscape: true },
      );
    }

    return envelope(period, data);
  }

  @Get('cross-section')
  @Roles(Role.ADMIN)
  @RawResponse()
  @ApiOperation({
    summary: 'Customers who used both the Kid Zone and the restaurant',
    description: `Each customer's spend in each section and their total, plus a crossover rate.

This is the report a combo offer rests on, and it is only possible because both sections resolve a guardian to the same customer record by phone number. Note that a restaurant order only counts here if a phone was attached to the bill at the till.`,
  })
  async crossSection(
    @Query() query: ReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const period = await this.period(query);
    const data = await this.reports.crossSection(period);

    if (this.exporter.isExport(query.export)) {
      return this.exporter.deliver(
        response,
        query.export,
        'Cross Section Customers',
        period,
        [
          {
            name: 'Cross-section customers',
            columns: [
              { header: 'Customer', key: 'name' },
              { header: 'Phone', key: 'phone' },
              { header: 'Kid Zone (BDT)', key: 'kidZoneSpend', type: 'money' },
              { header: 'KZ transactions', key: 'kidZoneTransactions', type: 'number' },
              { header: 'Restaurant (BDT)', key: 'restaurantSpend', type: 'money' },
              { header: 'RS orders', key: 'restaurantTransactions', type: 'number' },
              { header: 'Total (BDT)', key: 'totalSpend', type: 'money' },
            ],
            rows: data.customers as Array<Record<string, unknown>>,
            totals: {
              name: 'Total',
              kidZoneSpend: (data.summary as Record<string, number>).kidZoneSpend,
              restaurantSpend: (data.summary as Record<string, number>).restaurantSpend,
              totalSpend: (data.summary as Record<string, number>).totalSpend,
            },
          },
        ],
        { landscape: true },
      );
    }

    return envelope(period, data);
  }

  /** Admin-only endpoints, so no per-role range restriction applies. */
  private async period(query: ReportQueryDto): Promise<ReportPeriod> {
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
}

/** Spreadsheets want a flat `byName` column, not a nested `by: { name }`. */
function flattenActor(key: string) {
  return (row: Record<string, unknown>): Record<string, unknown> => {
    const actor = row[key] as { name?: string } | null | undefined;
    return { ...row, [`${key}Name`]: actor?.name ?? '' };
  };
}
