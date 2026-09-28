import { Injectable } from '@nestjs/common';
import { MembershipStatus, OrderStatus, Prisma, SaleStatus, VisitStatus } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { SettingsService } from '@modules/settings/settings.service';
import { BusinessCalendarService } from '@common/services/business-calendar.service';
import { calculateOvertime, sessionProgress } from '@modules/kidzone/domain/overtime';
import { addDays, endOfWeek, eachDate, fromDateColumn, startOfWeek, toDateColumn } from '@common/utils/date.util';
import { compare } from '@modules/reports/reports.types';

/**
 * The combined at-a-glance dashboard: everything an owner wants on one screen
 * when they walk in, in a single request.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly calendar: BusinessCalendarService,
  ) {}

  async combined(): Promise<Record<string, unknown>> {
    const options = await this.calendar.options();
    const today = await this.calendar.today();
    const yesterday = addDays(today, -1);

    const [
      todayKidZone,
      todayRestaurant,
      yesterdayKidZone,
      yesterdayRestaurant,
      activeVisits,
      expiringThisWeek,
      topDishes,
      trend,
    ] = await Promise.all([
      this.sectionTotals('KIDZONE', today),
      this.sectionTotals('RESTAURANT', today),
      this.sectionTotals('KIDZONE', yesterday),
      this.sectionTotals('RESTAURANT', yesterday),
      this.activeVisits(),
      this.expiringThisWeek(today, options.weekStartDay),
      this.topDishesToday(today),
      this.sevenDayTrend(today),
    ]);

    const todayTotal = todayKidZone.revenue + todayRestaurant.revenue;
    const yesterdayTotal = yesterdayKidZone.revenue + yesterdayRestaurant.revenue;

    return {
      businessDate: today,
      timezone: options.timezone,
      today: {
        kidZone: {
          revenue: compare(todayKidZone.revenue, yesterdayKidZone.revenue),
          transactions: compare(todayKidZone.count, yesterdayKidZone.count),
        },
        restaurant: {
          revenue: compare(todayRestaurant.revenue, yesterdayRestaurant.revenue),
          transactions: compare(todayRestaurant.count, yesterdayRestaurant.count),
        },
        combined: {
          revenue: compare(todayTotal, yesterdayTotal),
          transactions: compare(
            todayKidZone.count + todayRestaurant.count,
            yesterdayKidZone.count + yesterdayRestaurant.count,
          ),
        },
      },
      liveFloor: activeVisits,
      membershipsExpiringThisWeek: expiringThisWeek,
      topDishesToday: topDishes,
      last7Days: trend,
    };
  }

  // -------------------------------------------------------------------------

  private async sectionTotals(
    section: 'KIDZONE' | 'RESTAURANT',
    date: string,
  ): Promise<{ revenue: number; count: number }> {
    const businessDate = toDateColumn(date);

    if (section === 'KIDZONE') {
      const [sales, overtime] = await Promise.all([
        this.prisma.kidZoneSale.aggregate({
          where: { businessDate, status: SaleStatus.COMPLETED },
          _sum: { totalAmount: true },
          _count: { _all: true },
        }),
        this.prisma.payment.aggregate({
          where: { businessDate, visitId: { not: null } },
          _sum: { amount: true },
        }),
      ]);
      return {
        // Overtime is Kid Zone revenue too, and leaving it out would make the
        // dashboard disagree with the day-end closing.
        revenue: (sales._sum.totalAmount ?? 0) + (overtime._sum.amount ?? 0),
        count: sales._count._all,
      };
    }

    const orders = await this.prisma.order.aggregate({
      where: { businessDate, status: OrderStatus.PAID },
      _sum: { totalAmount: true },
      _count: { _all: true },
    });
    return { revenue: orders._sum.totalAmount ?? 0, count: orders._count._all };
  }

  /** Who is inside right now, and who is over their time. */
  private async activeVisits(): Promise<Record<string, unknown>> {
    const visits = await this.prisma.visit.findMany({
      where: { status: VisitStatus.ACTIVE },
      include: {
        child: { select: { id: true, name: true } },
        customer: { select: { name: true, phone: true } },
        sale: {
          select: {
            plan: {
              select: {
                name: true,
                sessionMinutes: true,
                gracePeriodMinutes: true,
                overtimeBlockMinutes: true,
                overtimeRatePerBlock: true,
              },
            },
          },
        },
      },
      orderBy: { checkInAt: 'asc' },
    });

    const now = new Date();

    const rows = visits.map((visit) => {
      const plan = visit.sale?.plan;
      const terms = {
        sessionMinutes: plan?.sessionMinutes ?? null,
        gracePeriodMinutes: plan?.gracePeriodMinutes ?? 0,
        overtimeBlockMinutes: plan?.overtimeBlockMinutes ?? null,
        overtimeRatePerBlock: plan?.overtimeRatePerBlock ?? null,
      };
      const progress = sessionProgress(visit.checkInAt, now, terms);
      const overtime = calculateOvertime(visit.checkInAt, now, terms);

      return {
        visitId: visit.id,
        gatepassNo: visit.gatepassNo,
        childName: visit.child.name,
        guardianName: visit.customer.name,
        guardianPhone: visit.customer.phone,
        planName: plan?.name ?? 'Membership visit',
        checkInAt: visit.checkInAt,
        elapsedMinutes: progress.elapsedMinutes,
        remainingMinutes: progress.remainingMinutes,
        isOvertime: progress.isOvertime,
        owedOvertime: overtime.overtimeCharge,
      };
    });

    const overdue = rows.filter((row) => row.isOvertime);

    return {
      activeVisitCount: rows.length,
      overtimeVisitCount: overdue.length,
      owedOvertimeTotal: overdue.reduce((n, row) => n + row.owedOvertime, 0),
      visits: rows,
      overtimeVisits: overdue,
    };
  }

  private async expiringThisWeek(today: string, weekStartDay: number): Promise<Record<string, unknown>> {
    // "This week" means the configured business week, not the next seven days.
    const weekEnd = endOfWeek(today, weekStartDay);
    const weekStart = startOfWeek(today, weekStartDay);

    const memberships = await this.prisma.membership.findMany({
      where: {
        status: MembershipStatus.ACTIVE,
        endDate: { gte: toDateColumn(today), lte: toDateColumn(weekEnd) },
      },
      orderBy: { endDate: 'asc' },
      include: {
        customer: { select: { name: true, phone: true } },
        child: { select: { name: true } },
        plan: { select: { name: true } },
      },
    });

    return {
      weekStart,
      weekEnd,
      count: memberships.length,
      memberships: memberships.map((m) => ({
        membershipId: m.id,
        customerName: m.customer.name,
        customerPhone: m.customer.phone,
        childName: m.child.name,
        planName: m.plan.name,
        endDate: fromDateColumn(m.endDate),
      })),
    };
  }

  private async topDishesToday(today: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.orderItem.groupBy({
      by: ['itemNameSnapshot'],
      where: { order: { businessDate: toDateColumn(today), status: OrderStatus.PAID } },
      _sum: { quantity: true, lineTotal: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: 5,
    });

    return rows.map((row) => ({
      itemName: row.itemNameSnapshot,
      quantity: row._sum.quantity ?? 0,
      revenue: row._sum.lineTotal ?? 0,
    }));
  }

  /**
   * Seven days of revenue for both sections, as one query per section rather
   * than fourteen point queries.
   */
  private async sevenDayTrend(today: string): Promise<Array<Record<string, unknown>>> {
    const from = addDays(today, -6);
    const fromColumn = toDateColumn(from);
    const toColumn = toDateColumn(today);

    const [kidZone, overtime, restaurant] = await Promise.all([
      this.prisma.$queryRaw<Array<{ period: Date; revenue: bigint; count: bigint }>>(Prisma.sql`
        SELECT "businessDate"::date AS period, SUM("totalAmount")::bigint AS revenue, COUNT(*)::bigint AS count
        FROM "kidzone_sales"
        WHERE "status" = 'COMPLETED' AND "businessDate" BETWEEN ${fromColumn}::date AND ${toColumn}::date
        GROUP BY period
      `),
      this.prisma.$queryRaw<Array<{ period: Date; revenue: bigint }>>(Prisma.sql`
        SELECT "businessDate"::date AS period, SUM("amount")::bigint AS revenue
        FROM "payments"
        WHERE "visitId" IS NOT NULL AND "businessDate" BETWEEN ${fromColumn}::date AND ${toColumn}::date
        GROUP BY period
      `),
      this.prisma.$queryRaw<Array<{ period: Date; revenue: bigint; count: bigint }>>(Prisma.sql`
        SELECT "businessDate"::date AS period, SUM("totalAmount")::bigint AS revenue, COUNT(*)::bigint AS count
        FROM "orders"
        WHERE "status" = 'PAID' AND "businessDate" BETWEEN ${fromColumn}::date AND ${toColumn}::date
        GROUP BY period
      `),
    ]);

    const kidZoneByDay = new Map(kidZone.map((r) => [fromDateColumn(r.period), r]));
    const overtimeByDay = new Map(overtime.map((r) => [fromDateColumn(r.period), Number(r.revenue)]));
    const restaurantByDay = new Map(restaurant.map((r) => [fromDateColumn(r.period), r]));

    return eachDate({ from, to: today }).map((date) => {
      const kz = kidZoneByDay.get(date);
      const rs = restaurantByDay.get(date);
      const kidZoneRevenue = (kz ? Number(kz.revenue) : 0) + (overtimeByDay.get(date) ?? 0);
      const restaurantRevenue = rs ? Number(rs.revenue) : 0;

      return {
        businessDate: date,
        kidZoneRevenue,
        kidZoneTransactions: kz ? Number(kz.count) : 0,
        restaurantRevenue,
        restaurantTransactions: rs ? Number(rs.count) : 0,
        totalRevenue: kidZoneRevenue + restaurantRevenue,
      };
    });
  }
}
