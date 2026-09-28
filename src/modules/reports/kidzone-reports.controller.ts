import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Role, Section } from '@prisma/client';
import type { Response } from 'express';
import { Roles } from '@common/decorators/roles.decorator';
import { RawResponse } from '@common/decorators/raw-response.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { AuthenticatedUser } from '@common/types/authenticated-user';
import { SheetSpec } from '@modules/exports/excel.service';
import { KidZoneReportsService } from './kidzone-reports.service';
import { ReportsAccessService } from './reports-access.service';
import { ReportExportService } from './report-export.service';
import { ReportQueryDto, UtilizationQueryDto } from './dto/report-query.dto';
import { ReportPeriod } from './reports.types';

const KIDZONE_STAFF = [Role.ADMIN, Role.KIDZONE_MANAGER] as const;

const RANGE_NOTE = `
**Range**: \`today\` (default), \`yesterday\`, \`this_week\`, \`last_week\`, \`this_month\`, \`last_month\`, \`this_year\`, or \`custom\` with \`from\`/\`to\`.
Resolved in the business timezone using the configured week start day (Saturday by default).

**Access**: a Kid Zone manager may only request \`today\`; historical ranges and file exports are admin-only.
`;

@ApiTags('Reports')
@ApiBearerAuth('access-token')
@Controller('reports/kidzone')
export class KidZoneReportsController {
  constructor(
    private readonly reports: KidZoneReportsService,
    private readonly access: ReportsAccessService,
    private readonly exporter: ReportExportService,
  ) {}

  @Get('summary')
  @Roles(...KIDZONE_STAFF)
  @RawResponse()
  @ApiProduces('application/json', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/pdf')
  @ApiOperation({
    summary: 'Kid Zone summary',
    description: `Revenue, sales count, new memberships, renewals, one-time sessions sold, overtime revenue, discounts and voids.

Every metric is returned as \`{ current, previous, change }\`, where \`previous\` is the equivalent preceding period and \`change\` is the percentage difference (\`null\` when there is no baseline). Voided sales are excluded from revenue and reported separately.
${RANGE_NOTE}`,
  })
  async summary(
    @Query() query: ReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const period = await this.access.resolvePeriod(query, user, Section.KIDZONE);
    this.access.assertMayExport(user, query.export);

    const data = await this.reports.summary(period, period.previous);

    if (this.exporter.isExport(query.export)) {
      return this.exporter.deliver(response, query.export, 'Kid Zone Summary', period, summarySheet(data));
    }

    return envelope(period, data);
  }

  @Get('revenue-trend')
  @Roles(...KIDZONE_STAFF)
  @RawResponse()
  @ApiOperation({
    summary: 'Revenue over time, split by plan',
    description: `Revenue per day, or per month for ranges longer than about ten weeks (\`granularity\` says which). Days with no trade are returned as zero, so a chart does not silently close the gap.
${RANGE_NOTE}`,
  })
  async revenueTrend(
    @Query() query: ReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const period = await this.access.resolvePeriod(query, user, Section.KIDZONE);
    this.access.assertMayExport(user, query.export);

    const data = await this.reports.revenueTrend(period);

    if (this.exporter.isExport(query.export)) {
      return this.exporter.deliver(response, query.export, 'Kid Zone Revenue Trend', period, [
        {
          name: 'Revenue trend',
          columns: [
            { header: 'Period', key: 'period', type: 'date' },
            { header: 'Sales', key: 'count', type: 'number' },
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

  @Get('by-plan')
  @Roles(...KIDZONE_STAFF)
  @RawResponse()
  @ApiOperation({
    summary: 'Sales and revenue per plan',
    description: `Grouped on the **snapshotted** plan name, so a plan that was renamed or retired still appears exactly as it was sold.
${RANGE_NOTE}`,
  })
  async byPlan(
    @Query() query: ReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const period = await this.access.resolvePeriod(query, user, Section.KIDZONE);
    this.access.assertMayExport(user, query.export);

    const data = await this.reports.byPlan(period);

    if (this.exporter.isExport(query.export)) {
      return this.exporter.deliver(response, query.export, 'Kid Zone By Plan', period, [
        {
          name: 'By plan',
          columns: [
            { header: 'Plan', key: 'planName' },
            { header: 'Sold', key: 'count', type: 'number' },
            { header: 'Revenue (BDT)', key: 'revenue', type: 'money' },
            { header: 'Discounts (BDT)', key: 'discounts', type: 'money' },
            { header: 'Average (BDT)', key: 'averageValue', type: 'money' },
            { header: 'Share', key: 'revenueShare', type: 'percent' },
          ],
          rows: data,
          totals: {
            planName: 'Total',
            count: data.reduce((n, r) => n + (r.count as number), 0),
            revenue: data.reduce((n, r) => n + (r.revenue as number), 0),
            discounts: data.reduce((n, r) => n + (r.discounts as number), 0),
          },
        },
      ]);
    }

    return envelope(period, { plans: data });
  }

  @Get('visits')
  @Roles(...KIDZONE_STAFF)
  @RawResponse()
  @ApiOperation({
    summary: 'Visits per day, member vs one-time session',
    description: `Daily visit counts split by whether the child came in on a membership or a one-time session.
${RANGE_NOTE}`,
  })
  async visits(
    @Query() query: ReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const period = await this.access.resolvePeriod(query, user, Section.KIDZONE);
    this.access.assertMayExport(user, query.export);

    const data = await this.reports.visits(period);

    if (this.exporter.isExport(query.export)) {
      return this.exporter.deliver(response, query.export, 'Kid Zone Visits', period, [
        {
          name: 'Visits',
          columns: [
            { header: 'Date', key: 'period', type: 'date' },
            { header: 'Member visits', key: 'member', type: 'number' },
            { header: 'Session visits', key: 'session', type: 'number' },
            { header: 'Total', key: 'total', type: 'number' },
          ],
          rows: data.points,
          totals: { period: 'Total', ...data.totals },
        },
      ]);
    }

    return envelope(period, data);
  }

  @Get('peak-hours')
  @Roles(...KIDZONE_STAFF)
  @RawResponse()
  @ApiOperation({
    summary: 'Day-of-week x hour-of-day heatmap',
    description: `A dense 7x24 grid of check-in counts, ready to render as a heatmap without filling gaps, plus the busiest day and hour.

Hours are extracted **in the business timezone**, so a 9pm Dhaka arrival lands in the 21:00 bucket rather than 15:00 UTC.
${RANGE_NOTE}`,
  })
  async peakHours(
    @Query() query: ReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const period = await this.access.resolvePeriod(query, user, Section.KIDZONE);
    this.access.assertMayExport(user, query.export);

    const data = await this.reports.peakHours(period);

    if (this.exporter.isExport(query.export)) {
      return this.exporter.deliver(
        response,
        query.export,
        'Kid Zone Peak Hours',
        period,
        [
          {
            name: 'Peak hours',
            columns: [
              { header: 'Day', key: 'dayName' },
              { header: 'Hour', key: 'hour', type: 'number' },
              { header: 'Visits', key: 'visits', type: 'number' },
            ],
            // Empty cells are noise in a spreadsheet, unlike in a heatmap.
            rows: data.grid.filter((cell) => cell.visits > 0),
          },
        ],
        { landscape: true },
      );
    }

    return envelope(period, data);
  }

  @Get('membership-utilization')
  @Roles(...KIDZONE_STAFF)
  @RawResponse()
  @ApiOperation({
    summary: 'How much each active membership is used',
    description: `Visits so far and average visits per week for every active membership, plus a \`lowUsage\` list below \`lowUsageThreshold\` visits per week.

The low-usage list is the point: a family paying for six months and coming twice is the one to call before they decide not to renew. Elapsed time is measured from the later of the membership start and the range start, so a membership bought mid-period is not judged on weeks it did not exist for.
${RANGE_NOTE}`,
  })
  async membershipUtilization(
    @Query() query: UtilizationQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const period = await this.access.resolvePeriod(query, user, Section.KIDZONE);
    this.access.assertMayExport(user, query.export);

    const data = await this.reports.membershipUtilization(period, query.lowUsageThreshold);

    if (this.exporter.isExport(query.export)) {
      const columns = [
        { header: 'Guardian', key: 'customerName' },
        { header: 'Phone', key: 'customerPhone' },
        { header: 'Child', key: 'childName' },
        { header: 'Plan', key: 'planName' },
        { header: 'Ends', key: 'endDate', type: 'date' as const },
        { header: 'Visits', key: 'visits', type: 'number' as const },
        { header: 'Visits/week', key: 'visitsPerWeek', type: 'number' as const },
      ];

      return this.exporter.deliver(
        response,
        query.export,
        'Kid Zone Membership Utilization',
        period,
        [
          { name: 'All memberships', columns, rows: data.memberships },
          { name: 'Low usage', columns, rows: data.lowUsage },
        ],
        { landscape: true },
      );
    }

    return envelope(period, data);
  }

  @Get('members')
  @Roles(...KIDZONE_STAFF)
  @RawResponse()
  @ApiOperation({
    summary: 'The membership book and the two call lists',
    description: `Active member count, how many expire in the next 7 and 30 days, the list expiring this week, and **members who expired in the last 30 days without renewing** — the follow-up call list.

"Has not renewed" means no later membership exists for that child, not merely that \`renewedFromId\` is unset: a family who let one lapse and then bought a fresh membership has renewed in every sense that matters.`,
  })
  async members(
    @Query() query: ReportQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const period = await this.access.resolvePeriod(query, user, Section.KIDZONE);
    this.access.assertMayExport(user, query.export);

    const data = await this.reports.members();

    if (this.exporter.isExport(query.export)) {
      return this.exporter.deliver(response, query.export, 'Kid Zone Members', period, [
        {
          name: 'Expiring soon',
          columns: [
            { header: 'Guardian', key: 'customerName' },
            { header: 'Phone', key: 'customerPhone' },
            { header: 'Child', key: 'childName' },
            { header: 'Plan', key: 'planName' },
            { header: 'Ends', key: 'endDate', type: 'date' },
            { header: 'Days left', key: 'daysRemaining', type: 'number' },
          ],
          rows: data.expiringSoon as Array<Record<string, unknown>>,
        },
        {
          name: 'Lapsed, not renewed',
          columns: [
            { header: 'Guardian', key: 'customerName' },
            { header: 'Phone', key: 'customerPhone' },
            { header: 'Child', key: 'childName' },
            { header: 'Plan', key: 'planName' },
            { header: 'Expired', key: 'endDate', type: 'date' },
            { header: 'Days ago', key: 'daysSinceExpiry', type: 'number' },
            { header: 'Total visits', key: 'totalVisits', type: 'number' },
          ],
          rows: data.lapsedWithoutRenewal as Array<Record<string, unknown>>,
        },
      ]);
    }

    return envelope(period, data);
  }
}

/** The `{ data, meta }` envelope, applied by hand on these raw handlers. */
export function envelope(period: ReportPeriod, data: unknown): { data: unknown; meta: Record<string, unknown> } {
  return { data, meta: { period, timestamp: new Date().toISOString() } };
}

/**
 * Metrics whose values are poisha rather than counts.
 *
 * Amounts and counts are split into two sheets rather than sharing a column,
 * because a spreadsheet column carries one number format: putting ৳6,000.00 and
 * "3 sales" in the same column would render one of them wrongly.
 */
const MONEY_METRICS = new Set([
  'revenue',
  'overtimeRevenue',
  'discounts',
  'averageSaleValue',
  'averageOrderValue',
  'subtotal',
  'vatCollected',
  'serviceCharge',
]);

/** Flattens a `{ metric: { current, previous, change } }` summary for export. */
export function summarySheet(summary: Record<string, unknown>, prefix = 'Summary'): SheetSpec[] {
  const amounts: Array<Record<string, unknown>> = [];
  const counts: Array<Record<string, unknown>> = [];

  for (const [key, value] of Object.entries(summary)) {
    if (!value || typeof value !== 'object' || !('current' in value)) continue;

    const metric = value as { current: number; previous: number; change: number | null };
    const row = {
      metric: humanize(key),
      current: metric.current,
      previous: metric.previous,
      change: metric.change,
    };

    (MONEY_METRICS.has(key) ? amounts : counts).push(row);
  }

  const voids = summary.voids as
    | { count: number; total: number; previousCount: number; previousTotal: number }
    | undefined;

  if (voids) {
    counts.push({ metric: 'Voided transactions', current: voids.count, previous: voids.previousCount, change: null });
    amounts.push({ metric: 'Voided value', current: voids.total, previous: voids.previousTotal, change: null });
  }

  const columns = (type: 'money' | 'number') => [
    { header: 'Metric', key: 'metric', width: 26 },
    { header: 'This period', key: 'current', type },
    { header: 'Previous period', key: 'previous', type },
    { header: 'Change', key: 'change', type: 'percent' as const },
  ];

  return [
    { name: `${prefix} - amounts (BDT)`, columns: columns('money'), rows: amounts },
    { name: `${prefix} - counts`, columns: columns('number'), rows: counts },
  ];
}

function humanize(key: string): string {
  const spaced = key.replace(/([A-Z])/g, ' $1').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
