import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Role, Section } from '@prisma/client';
import type { Response } from 'express';
import { Roles } from '@common/decorators/roles.decorator';
import { RawResponse } from '@common/decorators/raw-response.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { AuthenticatedUser } from '@common/types/authenticated-user';
import { RestaurantReportsService } from './restaurant-reports.service';
import { ReportsAccessService } from './reports-access.service';
import { ReportExportService } from './report-export.service';
import { ReportQueryDto, TopItemsQueryDto } from './dto/report-query.dto';
import { envelope, summarySheet } from './kidzone-reports.controller';

const RESTAURANT_STAFF = [Role.ADMIN, Role.RESTAURANT_CASHIER] as const;

const RANGE_NOTE = `
**Range**: \`today\` (default), \`yesterday\`, \`this_week\`, \`last_week\`, \`this_month\`, \`last_month\`, \`this_year\`, or \`custom\` with \`from\`/\`to\`.

**Access**: a cashier may only request \`today\`; historical ranges and file exports are admin-only.
`;

@ApiTags('Reports')
@ApiBearerAuth('access-token')
@Controller('reports/restaurant')
export class RestaurantReportsController {
  constructor(
    private readonly reports: RestaurantReportsService,
    private readonly access: ReportsAccessService,
    private readonly exporter: ReportExportService,
  ) {}

  @Get('summary')
  @Roles(...RESTAURANT_STAFF)
  @RawResponse()
  @ApiProduces('application/json', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/pdf')
  @ApiOperation({
    summary: 'Restaurant summary',
    description: `Revenue, order count, average order value, VAT collected, service charge, discounts and voids, each as \`{ current, previous, change }\`.

VAT and service charge are summed from the amounts **stored on each order**, so a rate change part way through a period is reflected exactly rather than re-derived from today's settings.
${RANGE_NOTE}`,
  })
  async summary(
    @Query() query: ReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const period = await this.access.resolvePeriod(query, user, Section.RESTAURANT);
    this.access.assertMayExport(user, query.export);

    const data = await this.reports.summary(period, period.previous);

    if (this.exporter.isExport(query.export)) {
      return this.exporter.deliver(response, query.export, 'Restaurant Summary', period, summarySheet(data));
    }

    return envelope(period, data);
  }

  @Get('revenue-trend')
  @Roles(...RESTAURANT_STAFF)
  @RawResponse()
  @ApiOperation({
    summary: 'Revenue over time',
    description: `Revenue per day, or per month for ranges longer than about ten weeks. Days with no trade are returned as zero.
${RANGE_NOTE}`,
  })
  async revenueTrend(
    @Query() query: ReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const period = await this.access.resolvePeriod(query, user, Section.RESTAURANT);
    this.access.assertMayExport(user, query.export);

    const data = await this.reports.revenueTrend(period);

    if (this.exporter.isExport(query.export)) {
      return this.exporter.deliver(response, query.export, 'Restaurant Revenue Trend', period, [
        {
          name: 'Revenue trend',
          columns: [
            { header: 'Period', key: 'period', type: 'date' },
            { header: 'Orders', key: 'count', type: 'number' },
            { header: 'Revenue (BDT)', key: 'revenue', type: 'money' },
          ],
          rows: data.points,
          totals: {
            period: 'Total',
            count: data.points.reduce((n, p) => n + p.count, 0),
            revenue: data.points.reduce((n, p) => n + p.revenue, 0),
          },
        },
      ]);
    }

    return envelope(period, data);
  }

  @Get('top-items')
  @Roles(...RESTAURANT_STAFF)
  @RawResponse()
  @ApiOperation({
    summary: 'Best sellers, ranked by quantity and by revenue',
    description: `Two rankings, because they answer different questions: by quantity tells the kitchen what to prep, by revenue tells the owner what pays the rent — and they are rarely the same list.

Grouped on the **snapshotted** item name, so a dish that was renamed mid-period is reported as it was sold, and a retired item still appears in a report covering the period it was on the menu.
${RANGE_NOTE}`,
  })
  async topItems(
    @Query() query: TopItemsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const period = await this.access.resolvePeriod(query, user, Section.RESTAURANT);
    this.access.assertMayExport(user, query.export);

    const data = await this.reports.topItems(period, query.limit);

    if (this.exporter.isExport(query.export)) {
      const columns = [
        { header: 'Item', key: 'itemName' },
        { header: 'Category', key: 'categoryName' },
        { header: 'Quantity', key: 'quantity', type: 'number' as const },
        { header: 'Revenue (BDT)', key: 'revenue', type: 'money' as const },
      ];

      return this.exporter.deliver(response, query.export, 'Restaurant Top Items', period, [
        { name: 'By quantity', columns, rows: data.byQuantity },
        { name: 'By revenue', columns, rows: data.byRevenue },
      ]);
    }

    return envelope(period, data);
  }

  @Get('by-category')
  @Roles(...RESTAURANT_STAFF)
  @RawResponse()
  @ApiOperation({
    summary: 'Quantity and revenue per category',
    description: `Uses the category name snapshotted on each order line, so moving a dish between categories does not rewrite history.
${RANGE_NOTE}`,
  })
  async byCategory(
    @Query() query: ReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const period = await this.access.resolvePeriod(query, user, Section.RESTAURANT);
    this.access.assertMayExport(user, query.export);

    const data = await this.reports.byCategory(period);

    if (this.exporter.isExport(query.export)) {
      return this.exporter.deliver(response, query.export, 'Restaurant By Category', period, [
        {
          name: 'By category',
          columns: [
            { header: 'Category', key: 'categoryName' },
            { header: 'Quantity', key: 'quantity', type: 'number' },
            { header: 'Revenue (BDT)', key: 'revenue', type: 'money' },
            { header: 'Share', key: 'revenueShare', type: 'percent' },
          ],
          rows: data,
          totals: {
            categoryName: 'Total',
            quantity: data.reduce((n, r) => n + (r.quantity as number), 0),
            revenue: data.reduce((n, r) => n + (r.revenue as number), 0),
          },
        },
      ]);
    }

    return envelope(period, { categories: data });
  }

  @Get('hourly')
  @Roles(...RESTAURANT_STAFF)
  @RawResponse()
  @ApiOperation({
    summary: 'Orders and revenue by hour of day',
    description: `All 24 hours are returned, including quiet ones. Hours are extracted **in the business timezone**, which is the only way the lunch and dinner peaks land in the right buckets.
${RANGE_NOTE}`,
  })
  async hourly(
    @Query() query: ReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const period = await this.access.resolvePeriod(query, user, Section.RESTAURANT);
    this.access.assertMayExport(user, query.export);

    const data = await this.reports.hourly(period);

    if (this.exporter.isExport(query.export)) {
      return this.exporter.deliver(response, query.export, 'Restaurant Hourly', period, [
        {
          name: 'By hour',
          columns: [
            { header: 'Hour', key: 'hour', type: 'number' },
            { header: 'Orders', key: 'orders', type: 'number' },
            { header: 'Revenue (BDT)', key: 'revenue', type: 'money' },
          ],
          rows: data.hours,
          totals: {
            hour: 'Total',
            orders: data.hours.reduce((n, h) => n + h.orders, 0),
            revenue: data.hours.reduce((n, h) => n + h.revenue, 0),
          },
        },
      ]);
    }

    return envelope(period, data);
  }

  @Get('cashier-performance')
  @Roles(Role.ADMIN)
  @RawResponse()
  @ApiOperation({
    summary: 'Orders, revenue, discounts and voids per cashier',
    description: `Admin only — this is staff oversight, not a floor report.
${RANGE_NOTE}`,
  })
  async cashierPerformance(
    @Query() query: ReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const period = await this.access.resolvePeriod(query, user, Section.RESTAURANT);
    this.access.assertMayExport(user, query.export);

    const data = await this.reports.cashierPerformance(period);

    if (this.exporter.isExport(query.export)) {
      return this.exporter.deliver(response, query.export, 'Restaurant Cashier Performance', period, [
        {
          name: 'Cashier performance',
          columns: [
            { header: 'Cashier', key: 'cashierName' },
            { header: 'Orders', key: 'orders', type: 'number' },
            { header: 'Revenue (BDT)', key: 'revenue', type: 'money' },
            { header: 'Average order (BDT)', key: 'averageOrderValue', type: 'money' },
            { header: 'Discounts (BDT)', key: 'discounts', type: 'money' },
            { header: 'Voids', key: 'voidCount', type: 'number' },
            { header: 'Voided value (BDT)', key: 'voidTotal', type: 'money' },
          ],
          rows: data,
          totals: {
            cashierName: 'Total',
            orders: data.reduce((n, r) => n + (r.orders as number), 0),
            revenue: data.reduce((n, r) => n + (r.revenue as number), 0),
            discounts: data.reduce((n, r) => n + (r.discounts as number), 0),
            voidCount: data.reduce((n, r) => n + (r.voidCount as number), 0),
            voidTotal: data.reduce((n, r) => n + (r.voidTotal as number), 0),
          },
        },
      ]);
    }

    return envelope(period, { cashiers: data });
  }
}
