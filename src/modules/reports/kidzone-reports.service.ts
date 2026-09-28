import { Injectable } from '@nestjs/common';
import { MembershipStatus, PlanType, Prisma, SaleStatus } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { SettingsService } from '@modules/settings/settings.service';
import { BusinessCalendarService } from '@common/services/business-calendar.service';
import {
  BusinessDate,
  DateRange,
  addDays,
  businessRangeToInstants,
  eachDate,
  fromDateColumn,
  toDateColumn,
} from '@common/utils/date.util';
import { Granularity, TrendPoint, compare, granularityFor } from './reports.types';

/**
 * Kid Zone reporting.
 *
 * Everything here aggregates in SQL — `groupBy` or a parameterised `$queryRaw` —
 * rather than loading rows into Node and reducing them. A year of visits is
 * tens of thousands of rows; the database is where that belongs, and it keeps
 * the report endpoints usable as the business grows.
 *
 * Voided sales are excluded from every revenue figure and reported separately.
 */
@Injectable()
export class KidZoneReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly calendar: BusinessCalendarService,
  ) {}

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  async summary(range: DateRange, previous: DateRange): Promise<Record<string, unknown>> {
    const [current, prior] = await Promise.all([this.summaryFor(range), this.summaryFor(previous)]);

    return {
      revenue: compare(current.revenue, prior.revenue),
      salesCount: compare(current.salesCount, prior.salesCount),
      newMemberships: compare(current.newMemberships, prior.newMemberships),
      renewals: compare(current.renewals, prior.renewals),
      sessionsSold: compare(current.sessionsSold, prior.sessionsSold),
      overtimeRevenue: compare(current.overtimeRevenue, prior.overtimeRevenue),
      discounts: compare(current.discounts, prior.discounts),
      visits: compare(current.visits, prior.visits),
      averageSaleValue: compare(current.averageSaleValue, prior.averageSaleValue),
      voids: {
        count: current.voidCount,
        total: current.voidTotal,
        previousCount: prior.voidCount,
        previousTotal: prior.voidTotal,
      },
    };
  }

  private async summaryFor(range: DateRange): Promise<{
    revenue: number;
    salesCount: number;
    newMemberships: number;
    renewals: number;
    sessionsSold: number;
    overtimeRevenue: number;
    discounts: number;
    visits: number;
    averageSaleValue: number;
    voidCount: number;
    voidTotal: number;
  }> {
    const where = this.saleWhere(range);

    const [sales, voided, byPlanType, memberships, renewals, overtime, visits] = await Promise.all([
      this.prisma.kidZoneSale.aggregate({
        where,
        _sum: { totalAmount: true, discountAmount: true },
        _count: { _all: true },
      }),
      this.prisma.kidZoneSale.aggregate({
        where: { ...this.dateFilter(range), status: SaleStatus.VOIDED },
        _sum: { totalAmount: true },
        _count: { _all: true },
      }),
      this.prisma.kidZoneSale.groupBy({
        by: ['planId'],
        where,
        _count: { _all: true },
      }),
      this.prisma.membership.count({
        where: { sale: where, renewedFromId: null },
      }),
      this.prisma.membership.count({
        where: { sale: where, NOT: { renewedFromId: null } },
      }),
      this.prisma.payment.aggregate({
        where: { businessDate: this.dateBetween(range), visitId: { not: null } },
        _sum: { amount: true },
      }),
      // Visits from a voided sale do not count as attendance; see `visits()`.
      this.prisma.visit.count({
        where: { ...this.dateFilter(range), OR: [{ saleId: null }, { sale: { status: SaleStatus.COMPLETED } }] },
      }),
    ]);

    // One extra query rather than a join, so the plan-type split stays cheap.
    const sessionPlanIds = new Set(
      (await this.prisma.kidZonePlan.findMany({ where: { type: PlanType.SESSION }, select: { id: true } })).map(
        (p) => p.id,
      ),
    );
    const sessionsSold = byPlanType
      .filter((row) => sessionPlanIds.has(row.planId))
      .reduce((n, row) => n + row._count._all, 0);

    const revenue = sales._sum.totalAmount ?? 0;
    const salesCount = sales._count._all;

    return {
      revenue,
      salesCount,
      newMemberships: memberships,
      renewals,
      sessionsSold,
      overtimeRevenue: overtime._sum.amount ?? 0,
      discounts: sales._sum.discountAmount ?? 0,
      visits,
      averageSaleValue: salesCount > 0 ? Math.round(revenue / salesCount) : 0,
      voidCount: voided._count._all,
      voidTotal: voided._sum.totalAmount ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // Revenue trend, split by plan
  // -------------------------------------------------------------------------

  async revenueTrend(range: DateRange): Promise<{
    granularity: Granularity;
    points: TrendPoint[];
    byPlan: Array<{ planName: string; points: Array<{ period: string; revenue: number }> }>;
  }> {
    const granularity = granularityFor(range);
    const truncation = granularity === 'month' ? 'month' : 'day';

    const rows = await this.prisma.$queryRaw<
      Array<{ period: Date; plan_name: string; revenue: bigint; sales: bigint }>
    >(Prisma.sql`
      SELECT date_trunc(${truncation}, "businessDate")::date AS period,
             "planNameSnapshot" AS plan_name,
             SUM("totalAmount")::bigint AS revenue,
             COUNT(*)::bigint AS sales
      FROM "kidzone_sales"
      WHERE "status" = 'COMPLETED'
        AND "businessDate" BETWEEN ${toDateColumn(range.from)}::date AND ${toDateColumn(range.to)}::date
      GROUP BY period, plan_name
      ORDER BY period ASC, plan_name ASC
    `);

    const totals = new Map<string, { revenue: number; count: number }>();
    const plans = new Map<string, Map<string, number>>();

    for (const row of rows) {
      const period = formatPeriod(row.period, granularity);
      const revenue = Number(row.revenue);

      const total = totals.get(period) ?? { revenue: 0, count: 0 };
      total.revenue += revenue;
      total.count += Number(row.sales);
      totals.set(period, total);

      const plan = plans.get(row.plan_name) ?? new Map<string, number>();
      plan.set(period, (plan.get(period) ?? 0) + revenue);
      plans.set(row.plan_name, plan);
    }

    // Days with no trade must appear as zero, otherwise a chart silently closes
    // the gap and a quiet week looks like a short one.
    const periods = allPeriods(range, granularity);

    return {
      granularity,
      points: periods.map((period) => ({
        period,
        revenue: totals.get(period)?.revenue ?? 0,
        count: totals.get(period)?.count ?? 0,
      })),
      byPlan: [...plans.entries()].map(([planName, series]) => ({
        planName,
        points: periods.map((period) => ({ period, revenue: series.get(period) ?? 0 })),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // By plan
  // -------------------------------------------------------------------------

  async byPlan(range: DateRange): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.kidZoneSale.groupBy({
      by: ['planNameSnapshot'],
      where: this.saleWhere(range),
      _sum: { totalAmount: true, discountAmount: true },
      _count: { _all: true },
      orderBy: { _sum: { totalAmount: 'desc' } },
    });

    const totalRevenue = rows.reduce((n, row) => n + (row._sum.totalAmount ?? 0), 0);

    return rows.map((row) => ({
      planName: row.planNameSnapshot,
      count: row._count._all,
      revenue: row._sum.totalAmount ?? 0,
      discounts: row._sum.discountAmount ?? 0,
      averageValue: row._count._all > 0 ? Math.round((row._sum.totalAmount ?? 0) / row._count._all) : 0,
      revenueShare: totalRevenue > 0 ? Math.round(((row._sum.totalAmount ?? 0) / totalRevenue) * 1000) / 10 : 0,
    }));
  }

  // -------------------------------------------------------------------------
  // Visits per day, member vs session
  // -------------------------------------------------------------------------

  /**
   * Visits per day, split by membership vs one-time session.
   *
   * A visit whose originating sale was voided is excluded: if a session is rung
   * up by mistake and voided, the child never came in, and counting it would
   * inflate footfall and skew the peak-hours heatmap. The visit row itself is
   * kept — the visit log records what happened at the gate — it simply does not
   * count as attendance.
   */
  async visits(range: DateRange): Promise<{
    points: Array<{ period: string; member: number; session: number; total: number }>;
    totals: { member: number; session: number; total: number };
  }> {
    const rows = await this.prisma.$queryRaw<Array<{ period: Date; member: bigint; session: bigint }>>(Prisma.sql`
      SELECT v."businessDate"::date AS period,
             COUNT(*) FILTER (WHERE v."membershipId" IS NOT NULL)::bigint AS member,
             COUNT(*) FILTER (WHERE v."membershipId" IS NULL)::bigint AS session
      FROM "visits" v
      LEFT JOIN "kidzone_sales" s ON s."id" = v."saleId"
      WHERE v."businessDate" BETWEEN ${toDateColumn(range.from)}::date AND ${toDateColumn(range.to)}::date
        AND (s."id" IS NULL OR s."status" = 'COMPLETED')
      GROUP BY period
      ORDER BY period ASC
    `);

    const byPeriod = new Map(rows.map((row) => [fromDateColumn(row.period), row]));

    const points = eachDate(range).map((period) => {
      const row = byPeriod.get(period);
      const member = row ? Number(row.member) : 0;
      const session = row ? Number(row.session) : 0;
      return { period, member, session, total: member + session };
    });

    return {
      points,
      totals: {
        member: points.reduce((n, p) => n + p.member, 0),
        session: points.reduce((n, p) => n + p.session, 0),
        total: points.reduce((n, p) => n + p.total, 0),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Peak hours heatmap
  // -------------------------------------------------------------------------

  /**
   * A day-of-week x hour-of-day grid of check-ins, for a heatmap.
   *
   * The hour has to come from `checkInAt` converted into the business timezone:
   * grouping on the raw UTC timestamp would put a 9pm Dhaka arrival in the 3pm
   * bucket and make the evening peak disappear.
   */
  async peakHours(range: DateRange): Promise<{
    grid: Array<{ dayOfWeek: number; dayName: string; hour: number; visits: number }>;
    busiestDay: { dayOfWeek: number; dayName: string; visits: number } | null;
    busiestHour: { hour: number; visits: number } | null;
    totalVisits: number;
  }> {
    const timezone = await this.calendar.timezone();
    const { startAt, endAt } = businessRangeToInstants(range, await this.calendar.options());

    const rows = await this.prisma.$queryRaw<Array<{ dow: number; hour: number; visits: bigint }>>(Prisma.sql`
      SELECT EXTRACT(DOW FROM v."checkInAt" AT TIME ZONE ${timezone})::int AS dow,
             EXTRACT(HOUR FROM v."checkInAt" AT TIME ZONE ${timezone})::int AS hour,
             COUNT(*)::bigint AS visits
      FROM "visits" v
      LEFT JOIN "kidzone_sales" s ON s."id" = v."saleId"
      WHERE v."checkInAt" >= ${startAt} AND v."checkInAt" < ${endAt}
        AND (s."id" IS NULL OR s."status" = 'COMPLETED')
      GROUP BY dow, hour
      ORDER BY dow ASC, hour ASC
    `);

    const lookup = new Map(rows.map((row) => [`${row.dow}:${row.hour}`, Number(row.visits)]));

    // A dense grid, so the client can render a heatmap without filling gaps.
    const grid: Array<{ dayOfWeek: number; dayName: string; hour: number; visits: number }> = [];
    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
      for (let hour = 0; hour < 24; hour++) {
        grid.push({
          dayOfWeek,
          dayName: DAY_NAMES[dayOfWeek],
          hour,
          visits: lookup.get(`${dayOfWeek}:${hour}`) ?? 0,
        });
      }
    }

    const dayTotals = new Map<number, number>();
    const hourTotals = new Map<number, number>();
    for (const cell of grid) {
      dayTotals.set(cell.dayOfWeek, (dayTotals.get(cell.dayOfWeek) ?? 0) + cell.visits);
      hourTotals.set(cell.hour, (hourTotals.get(cell.hour) ?? 0) + cell.visits);
    }

    const busiestDayEntry = maxEntry(dayTotals);
    const busiestHourEntry = maxEntry(hourTotals);
    const totalVisits = grid.reduce((n, cell) => n + cell.visits, 0);

    return {
      grid,
      busiestDay:
        busiestDayEntry && totalVisits > 0
          ? { dayOfWeek: busiestDayEntry[0], dayName: DAY_NAMES[busiestDayEntry[0]], visits: busiestDayEntry[1] }
          : null,
      busiestHour:
        busiestHourEntry && totalVisits > 0 ? { hour: busiestHourEntry[0], visits: busiestHourEntry[1] } : null,
      totalVisits,
    };
  }

  // -------------------------------------------------------------------------
  // Membership utilisation
  // -------------------------------------------------------------------------

  /**
   * How much each active membership is actually being used.
   *
   * The point is the low-usage list: a family paying for six months and coming
   * twice is the one to call before they decide not to renew.
   */
  async membershipUtilization(
    range: DateRange,
    lowUsageThreshold = 0.5,
  ): Promise<{
    memberships: Array<Record<string, unknown>>;
    lowUsage: Array<Record<string, unknown>>;
    averageVisitsPerWeek: number;
  }> {
    const today = await this.calendar.today();

    const rows = await this.prisma.$queryRaw<
      Array<{
        membership_id: string;
        customer_name: string;
        customer_phone: string;
        child_name: string;
        plan_name: string;
        start_date: Date;
        end_date: Date;
        visits: bigint;
        last_visit: Date | null;
      }>
    >(Prisma.sql`
      SELECT m."id" AS membership_id,
             c."name" AS customer_name,
             c."phone" AS customer_phone,
             ch."name" AS child_name,
             p."name" AS plan_name,
             m."startDate" AS start_date,
             m."endDate" AS end_date,
             COUNT(v."id")::bigint AS visits,
             MAX(v."checkInAt") AS last_visit
      FROM "memberships" m
      JOIN "customers" c ON c."id" = m."customerId"
      JOIN "children" ch ON ch."id" = m."childId"
      JOIN "kidzone_plans" p ON p."id" = m."planId"
      LEFT JOIN "visits" v
        ON v."membershipId" = m."id"
       AND v."businessDate" BETWEEN ${toDateColumn(range.from)}::date AND ${toDateColumn(range.to)}::date
      WHERE m."status" = 'ACTIVE'
      GROUP BY m."id", c."name", c."phone", ch."name", p."name", m."startDate", m."endDate"
      ORDER BY visits ASC
    `);

    const memberships = rows.map((row) => {
      const startDate = fromDateColumn(row.start_date);
      const endDate = fromDateColumn(row.end_date);

      // Elapsed days are measured from whichever is later, the membership start
      // or the range start, so a membership bought mid-range is not judged on
      // weeks it did not exist for.
      const effectiveStart = startDate > range.from ? startDate : range.from;
      const effectiveEnd = today < range.to ? today : range.to;
      const elapsedDays = Math.max(1, daysBetween(effectiveStart, effectiveEnd) + 1);
      const visits = Number(row.visits);
      const visitsPerWeek = Math.round((visits / elapsedDays) * 7 * 100) / 100;

      return {
        membershipId: row.membership_id,
        customerName: row.customer_name,
        customerPhone: row.customer_phone,
        childName: row.child_name,
        planName: row.plan_name,
        startDate,
        endDate,
        visits,
        elapsedDays,
        visitsPerWeek,
        lastVisitAt: row.last_visit,
        daysSinceLastVisit: row.last_visit
          ? Math.floor((Date.now() - row.last_visit.getTime()) / 86_400_000)
          : null,
      };
    });

    const totalPerWeek = memberships.reduce((n, m) => n + (m.visitsPerWeek as number), 0);

    return {
      memberships,
      lowUsage: memberships.filter((m) => (m.visitsPerWeek as number) < lowUsageThreshold),
      averageVisitsPerWeek:
        memberships.length > 0 ? Math.round((totalPerWeek / memberships.length) * 100) / 100 : 0,
    };
  }

  // -------------------------------------------------------------------------
  // Members: active, expiring, lapsed
  // -------------------------------------------------------------------------

  /**
   * The membership book, plus the two call lists that actually drive renewals:
   * who is about to expire, and who expired recently without renewing.
   */
  async members(): Promise<Record<string, unknown>> {
    const today = await this.calendar.today();

    const [active, expiringIn7, expiringIn30, lapsed] = await Promise.all([
      this.prisma.membership.count({ where: { status: MembershipStatus.ACTIVE } }),
      this.countExpiringWithin(today, 7),
      this.countExpiringWithin(today, 30),
      this.lapsedWithoutRenewal(today, 30),
    ]);

    const expiringSoon = await this.prisma.membership.findMany({
      where: {
        status: MembershipStatus.ACTIVE,
        endDate: { gte: toDateColumn(today), lte: toDateColumn(addDays(today, 7)) },
      },
      orderBy: { endDate: 'asc' },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        child: { select: { id: true, name: true } },
        plan: { select: { name: true } },
      },
    });

    return {
      activeCount: active,
      expiringIn7Days: expiringIn7,
      expiringIn30Days: expiringIn30,
      expiringSoon: expiringSoon.map((m) => ({
        membershipId: m.id,
        customerName: m.customer.name,
        customerPhone: m.customer.phone,
        childName: m.child.name,
        planName: m.plan.name,
        endDate: fromDateColumn(m.endDate),
        daysRemaining: daysBetween(today, fromDateColumn(m.endDate)) + 1,
      })),
      lapsedWithoutRenewal: lapsed,
      lapsedCount: lapsed.length,
    };
  }

  private countExpiringWithin(today: BusinessDate, days: number): Promise<number> {
    return this.prisma.membership.count({
      where: {
        status: MembershipStatus.ACTIVE,
        endDate: { gte: toDateColumn(today), lte: toDateColumn(addDays(today, days)) },
      },
    });
  }

  /**
   * Members who lapsed in the last `days` days and have not come back.
   *
   * "Has not renewed" means no *later* membership exists for the same child, not
   * merely that `renewedFromId` is unset — a family who let one lapse and then
   * bought a fresh membership has renewed in every sense that matters.
   */
  private async lapsedWithoutRenewal(today: BusinessDate, days: number): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        membership_id: string;
        customer_name: string;
        customer_phone: string;
        child_name: string;
        plan_name: string;
        end_date: Date;
        total_visits: bigint;
      }>
    >(Prisma.sql`
      SELECT m."id" AS membership_id,
             c."name" AS customer_name,
             c."phone" AS customer_phone,
             ch."name" AS child_name,
             p."name" AS plan_name,
             m."endDate" AS end_date,
             (SELECT COUNT(*) FROM "visits" v WHERE v."membershipId" = m."id")::bigint AS total_visits
      FROM "memberships" m
      JOIN "customers" c ON c."id" = m."customerId"
      JOIN "children" ch ON ch."id" = m."childId"
      JOIN "kidzone_plans" p ON p."id" = m."planId"
      WHERE m."endDate" BETWEEN ${toDateColumn(addDays(today, -days))}::date AND ${toDateColumn(addDays(today, -1))}::date
        AND m."status" <> 'CANCELLED'
        AND NOT EXISTS (
          SELECT 1 FROM "memberships" later
          WHERE later."childId" = m."childId"
            AND later."endDate" > m."endDate"
            AND later."status" <> 'CANCELLED'
        )
      ORDER BY m."endDate" DESC
    `);

    return rows.map((row) => ({
      membershipId: row.membership_id,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      childName: row.child_name,
      planName: row.plan_name,
      endDate: fromDateColumn(row.end_date),
      daysSinceExpiry: daysBetween(fromDateColumn(row.end_date), today),
      totalVisits: Number(row.total_visits),
    }));
  }

  // -------------------------------------------------------------------------

  private dateBetween(range: DateRange): Prisma.DateTimeFilter {
    return { gte: toDateColumn(range.from), lte: toDateColumn(range.to) };
  }

  private dateFilter(range: DateRange): { businessDate: Prisma.DateTimeFilter } {
    return { businessDate: this.dateBetween(range) };
  }

  private saleWhere(range: DateRange): Prisma.KidZoneSaleWhereInput {
    return { ...this.dateFilter(range), status: SaleStatus.COMPLETED };
  }
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatPeriod(date: Date, granularity: Granularity): string {
  const iso = fromDateColumn(date);
  return granularity === 'month' ? iso.slice(0, 7) : iso;
}

function allPeriods(range: DateRange, granularity: Granularity): string[] {
  if (granularity === 'day') return eachDate(range);

  const months: string[] = [];
  let cursor = range.from.slice(0, 7);
  const last = range.to.slice(0, 7);
  while (cursor <= last) {
    months.push(cursor);
    const [year, month] = cursor.split('-').map(Number);
    cursor = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
  }
  return months;
}

function daysBetween(from: BusinessDate, to: BusinessDate): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

function maxEntry(map: Map<number, number>): [number, number] | null {
  let best: [number, number] | null = null;
  for (const entry of map) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  return best;
}

