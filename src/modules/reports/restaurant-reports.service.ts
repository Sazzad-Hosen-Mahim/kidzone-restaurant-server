import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { BusinessCalendarService } from '@common/services/business-calendar.service';
import { DateRange, businessRangeToInstants, eachDate, fromDateColumn, toDateColumn } from '@common/utils/date.util';
import { Granularity, TrendPoint, compare, granularityFor } from './reports.types';

/**
 * Restaurant reporting.
 *
 * Item-level reports group on the **snapshot** columns (`itemNameSnapshot`,
 * `categoryNameSnapshot`) rather than joining back to the menu. That is
 * deliberate: a dish that was renamed or moved category mid-period should be
 * reported as it was sold, and a retired item must still appear in a report
 * covering the period it was on the menu.
 */
@Injectable()
export class RestaurantReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: BusinessCalendarService,
  ) {}

  // -------------------------------------------------------------------------

  async summary(range: DateRange, previous: DateRange): Promise<Record<string, unknown>> {
    const [current, prior] = await Promise.all([this.summaryFor(range), this.summaryFor(previous)]);

    return {
      revenue: compare(current.revenue, prior.revenue),
      orderCount: compare(current.orderCount, prior.orderCount),
      averageOrderValue: compare(current.averageOrderValue, prior.averageOrderValue),
      subtotal: compare(current.subtotal, prior.subtotal),
      vatCollected: compare(current.vat, prior.vat),
      serviceCharge: compare(current.serviceCharge, prior.serviceCharge),
      discounts: compare(current.discounts, prior.discounts),
      itemsSold: compare(current.itemsSold, prior.itemsSold),
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
    orderCount: number;
    averageOrderValue: number;
    subtotal: number;
    vat: number;
    serviceCharge: number;
    discounts: number;
    itemsSold: number;
    voidCount: number;
    voidTotal: number;
  }> {
    const [orders, voided, items] = await Promise.all([
      this.prisma.order.aggregate({
        where: this.paidWhere(range),
        _sum: {
          totalAmount: true,
          subtotal: true,
          vatAmount: true,
          serviceChargeAmount: true,
          discountAmount: true,
        },
        _count: { _all: true },
      }),
      this.prisma.order.aggregate({
        where: { ...this.dateFilter(range), status: OrderStatus.VOIDED },
        _sum: { totalAmount: true },
        _count: { _all: true },
      }),
      this.prisma.orderItem.aggregate({
        where: { order: this.paidWhere(range) },
        _sum: { quantity: true },
      }),
    ]);

    const revenue = orders._sum.totalAmount ?? 0;
    const orderCount = orders._count._all;

    return {
      revenue,
      orderCount,
      averageOrderValue: orderCount > 0 ? Math.round(revenue / orderCount) : 0,
      subtotal: orders._sum.subtotal ?? 0,
      vat: orders._sum.vatAmount ?? 0,
      serviceCharge: orders._sum.serviceChargeAmount ?? 0,
      discounts: orders._sum.discountAmount ?? 0,
      itemsSold: items._sum.quantity ?? 0,
      voidCount: voided._count._all,
      voidTotal: voided._sum.totalAmount ?? 0,
    };
  }

  // -------------------------------------------------------------------------

  async revenueTrend(range: DateRange): Promise<{ granularity: Granularity; points: TrendPoint[] }> {
    const granularity = granularityFor(range);
    const truncation = granularity === 'month' ? 'month' : 'day';

    const rows = await this.prisma.$queryRaw<Array<{ period: Date; revenue: bigint; orders: bigint }>>(Prisma.sql`
      SELECT date_trunc(${truncation}, "businessDate")::date AS period,
             SUM("totalAmount")::bigint AS revenue,
             COUNT(*)::bigint AS orders
      FROM "orders"
      WHERE "status" = 'PAID'
        AND "businessDate" BETWEEN ${toDateColumn(range.from)}::date AND ${toDateColumn(range.to)}::date
      GROUP BY period
      ORDER BY period ASC
    `);

    const byPeriod = new Map(
      rows.map((row) => [
        granularity === 'month' ? fromDateColumn(row.period).slice(0, 7) : fromDateColumn(row.period),
        { revenue: Number(row.revenue), count: Number(row.orders) },
      ]),
    );

    return {
      granularity,
      points: allPeriods(range, granularity).map((period) => ({
        period,
        revenue: byPeriod.get(period)?.revenue ?? 0,
        count: byPeriod.get(period)?.count ?? 0,
      })),
    };
  }

  // -------------------------------------------------------------------------

  /**
   * Top items ranked two ways, because they answer different questions: by
   * quantity tells the kitchen what to prep, by revenue tells the owner what
   * pays the rent — and they are rarely the same list.
   */
  async topItems(range: DateRange, limit = 10): Promise<{
    byQuantity: Array<Record<string, unknown>>;
    byRevenue: Array<Record<string, unknown>>;
  }> {
    const rows = await this.prisma.orderItem.groupBy({
      by: ['itemNameSnapshot', 'categoryNameSnapshot'],
      where: { order: this.paidWhere(range) },
      _sum: { quantity: true, lineTotal: true },
      _count: { _all: true },
    });

    const items = rows.map((row) => ({
      itemName: row.itemNameSnapshot,
      categoryName: row.categoryNameSnapshot,
      quantity: row._sum.quantity ?? 0,
      revenue: row._sum.lineTotal ?? 0,
      orderLines: row._count._all,
    }));

    return {
      byQuantity: [...items].sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue).slice(0, limit),
      byRevenue: [...items].sort((a, b) => b.revenue - a.revenue || b.quantity - a.quantity).slice(0, limit),
    };
  }

  // -------------------------------------------------------------------------

  async byCategory(range: DateRange): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.orderItem.groupBy({
      by: ['categoryNameSnapshot'],
      where: { order: this.paidWhere(range) },
      _sum: { quantity: true, lineTotal: true },
      orderBy: { _sum: { lineTotal: 'desc' } },
    });

    const totalRevenue = rows.reduce((n, row) => n + (row._sum.lineTotal ?? 0), 0);

    return rows.map((row) => ({
      categoryName: row.categoryNameSnapshot,
      quantity: row._sum.quantity ?? 0,
      revenue: row._sum.lineTotal ?? 0,
      revenueShare: totalRevenue > 0 ? Math.round(((row._sum.lineTotal ?? 0) / totalRevenue) * 1000) / 10 : 0,
    }));
  }

  // -------------------------------------------------------------------------

  /**
   * Orders and revenue by hour of day, in the business timezone — which is the
   * only way the lunch and dinner peaks land in the right buckets.
   */
  async hourly(range: DateRange): Promise<{
    hours: Array<{ hour: number; orders: number; revenue: number }>;
    peakHour: { hour: number; orders: number; revenue: number } | null;
  }> {
    const timezone = await this.calendar.timezone();
    const { startAt, endAt } = businessRangeToInstants(range, await this.calendar.options());

    const rows = await this.prisma.$queryRaw<Array<{ hour: number; orders: bigint; revenue: bigint }>>(Prisma.sql`
      SELECT EXTRACT(HOUR FROM "createdAt" AT TIME ZONE ${timezone})::int AS hour,
             COUNT(*)::bigint AS orders,
             SUM("totalAmount")::bigint AS revenue
      FROM "orders"
      WHERE "status" = 'PAID'
        AND "createdAt" >= ${startAt} AND "createdAt" < ${endAt}
      GROUP BY hour
      ORDER BY hour ASC
    `);

    const byHour = new Map(rows.map((row) => [row.hour, row]));

    const hours = Array.from({ length: 24 }, (_, hour) => {
      const row = byHour.get(hour);
      return {
        hour,
        orders: row ? Number(row.orders) : 0,
        revenue: row ? Number(row.revenue) : 0,
      };
    });

    const peak = hours.reduce((best, current) => (current.orders > (best?.orders ?? -1) ? current : best), hours[0]);

    return { hours, peakHour: peak.orders > 0 ? peak : null };
  }

  // -------------------------------------------------------------------------

  async cashierPerformance(range: DateRange): Promise<Array<Record<string, unknown>>> {
    const [paid, voided] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['cashierId'],
        where: this.paidWhere(range),
        _sum: { totalAmount: true, discountAmount: true },
        _count: { _all: true },
      }),
      this.prisma.order.groupBy({
        by: ['cashierId'],
        where: { ...this.dateFilter(range), status: OrderStatus.VOIDED },
        _sum: { totalAmount: true },
        _count: { _all: true },
      }),
    ]);

    const cashierIds = [...new Set([...paid.map((r) => r.cashierId), ...voided.map((r) => r.cashierId)])];
    const cashiers = await this.prisma.user.findMany({
      where: { id: { in: cashierIds } },
      select: { id: true, name: true, role: true },
    });
    const names = new Map(cashiers.map((c) => [c.id, c]));
    const voidsById = new Map(voided.map((row) => [row.cashierId, row]));

    return paid
      .map((row) => {
        const voids = voidsById.get(row.cashierId);
        const revenue = row._sum.totalAmount ?? 0;
        const orders = row._count._all;

        return {
          cashierId: row.cashierId,
          cashierName: names.get(row.cashierId)?.name ?? 'Unknown',
          role: names.get(row.cashierId)?.role ?? null,
          orders,
          revenue,
          averageOrderValue: orders > 0 ? Math.round(revenue / orders) : 0,
          discounts: row._sum.discountAmount ?? 0,
          voidCount: voids?._count._all ?? 0,
          voidTotal: voids?._sum.totalAmount ?? 0,
        };
      })
      .sort((a, b) => b.revenue - a.revenue);
  }

  // -------------------------------------------------------------------------

  private dateFilter(range: DateRange): { businessDate: Prisma.DateTimeFilter } {
    return { businessDate: { gte: toDateColumn(range.from), lte: toDateColumn(range.to) } };
  }

  private paidWhere(range: DateRange): Prisma.OrderWhereInput {
    return { ...this.dateFilter(range), status: OrderStatus.PAID };
  }
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
