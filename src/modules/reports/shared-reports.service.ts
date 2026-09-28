import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma, SaleStatus, Section } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { DateRange, fromDateColumn, toDateColumn } from '@common/utils/date.util';

/**
 * Reports that span both sections, and are therefore admin-only.
 */
@Injectable()
export class SharedReportsService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------

  /**
   * Payment method totals, optionally narrowed to one section.
   *
   * Built from payment rows so a split payment is counted once per tender,
   * which is what reconciles against each wallet's own statement.
   */
  async paymentMethods(range: DateRange, section?: Section): Promise<{
    methods: Array<{ method: string; count: number; total: number; share: number }>;
    total: number;
  }> {
    const rows = await this.prisma.payment.groupBy({
      by: ['method'],
      where: {
        businessDate: { gte: toDateColumn(range.from), lte: toDateColumn(range.to) },
        ...this.sectionFilter(section),
      },
      _sum: { amount: true },
      _count: { _all: true },
      orderBy: { _sum: { amount: 'desc' } },
    });

    const total = rows.reduce((n, row) => n + (row._sum.amount ?? 0), 0);

    return {
      methods: rows.map((row) => ({
        method: row.method,
        count: row._count._all,
        total: row._sum.amount ?? 0,
        share: total > 0 ? Math.round(((row._sum.amount ?? 0) / total) * 1000) / 10 : 0,
      })),
      total,
    };
  }

  // -------------------------------------------------------------------------

  /**
   * Every discount and every void in the period, with who, when, how much and
   * why. This is the oversight report: the two ways money leaves the business
   * without a customer complaining about it.
   */
  async discountsAndVoids(range: DateRange, section?: Section): Promise<Record<string, unknown>> {
    const dateFilter = { gte: toDateColumn(range.from), lte: toDateColumn(range.to) };
    const wantKidZone = section !== Section.RESTAURANT;
    const wantRestaurant = section !== Section.KIDZONE;

    const [kidZoneDiscounts, kidZoneVoids, restaurantDiscounts, restaurantVoids] = await Promise.all([
      wantKidZone
        ? this.prisma.kidZoneSale.findMany({
            where: { businessDate: dateFilter, status: SaleStatus.COMPLETED, discountAmount: { gt: 0 } },
            orderBy: { createdAt: 'desc' },
            include: {
              soldBy: { select: { id: true, name: true, role: true } },
              customer: { select: { name: true, phone: true } },
            },
          })
        : Promise.resolve([]),
      wantKidZone
        ? this.prisma.kidZoneSale.findMany({
            where: { businessDate: dateFilter, status: SaleStatus.VOIDED },
            orderBy: { voidedAt: 'desc' },
            include: {
              voidedBy: { select: { id: true, name: true, role: true } },
              soldBy: { select: { id: true, name: true } },
              customer: { select: { name: true, phone: true } },
            },
          })
        : Promise.resolve([]),
      wantRestaurant
        ? this.prisma.order.findMany({
            where: { businessDate: dateFilter, status: OrderStatus.PAID, discountAmount: { gt: 0 } },
            orderBy: { createdAt: 'desc' },
            include: {
              cashier: { select: { id: true, name: true, role: true } },
              customer: { select: { name: true, phone: true } },
            },
          })
        : Promise.resolve([]),
      wantRestaurant
        ? this.prisma.order.findMany({
            where: { businessDate: dateFilter, status: OrderStatus.VOIDED },
            orderBy: { voidedAt: 'desc' },
            include: {
              voidedBy: { select: { id: true, name: true, role: true } },
              cashier: { select: { id: true, name: true } },
              customer: { select: { name: true, phone: true } },
            },
          })
        : Promise.resolve([]),
    ]);

    const discounts = [
      ...kidZoneDiscounts.map((sale) => ({
        section: Section.KIDZONE,
        id: sale.id,
        receiptNo: sale.receiptNo,
        businessDate: fromDateColumn(sale.businessDate),
        at: sale.createdAt,
        by: sale.soldBy,
        customer: sale.customer,
        subtotal: sale.unitPriceSnapshot,
        discountAmount: sale.discountAmount,
        discountPercent: percent(sale.discountAmount, sale.unitPriceSnapshot),
        totalAmount: sale.totalAmount,
        reason: sale.discountReason,
      })),
      ...restaurantDiscounts.map((order) => ({
        section: Section.RESTAURANT,
        id: order.id,
        receiptNo: order.receiptNo,
        businessDate: fromDateColumn(order.businessDate),
        at: order.createdAt,
        by: order.cashier,
        customer: order.customer,
        subtotal: order.subtotal,
        discountAmount: order.discountAmount,
        discountPercent: percent(order.discountAmount, order.subtotal),
        totalAmount: order.totalAmount,
        reason: order.discountReason,
      })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());

    const voids = [
      ...kidZoneVoids.map((sale) => ({
        section: Section.KIDZONE,
        id: sale.id,
        receiptNo: sale.receiptNo,
        businessDate: fromDateColumn(sale.businessDate),
        at: sale.voidedAt,
        voidedBy: sale.voidedBy,
        soldBy: sale.soldBy,
        customer: sale.customer,
        amount: sale.totalAmount,
        reason: sale.voidReason,
      })),
      ...restaurantVoids.map((order) => ({
        section: Section.RESTAURANT,
        id: order.id,
        receiptNo: order.receiptNo,
        businessDate: fromDateColumn(order.businessDate),
        at: order.voidedAt,
        voidedBy: order.voidedBy,
        soldBy: order.cashier,
        customer: order.customer,
        amount: order.totalAmount,
        reason: order.voidReason,
      })),
    ].sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));

    return {
      discounts,
      voids,
      totals: {
        discountCount: discounts.length,
        discountAmount: discounts.reduce((n, d) => n + d.discountAmount, 0),
        voidCount: voids.length,
        voidAmount: voids.reduce((n, v) => n + v.amount, 0),
      },
      byStaff: this.groupByStaff(discounts, voids),
    };
  }

  /** Rolls the two lists up per member of staff, which is how it gets reviewed. */
  private groupByStaff(
    discounts: Array<{ by: { id: string; name: string } | null; discountAmount: number }>,
    voids: Array<{ voidedBy: { id: string; name: string } | null; amount: number }>,
  ): Array<Record<string, unknown>> {
    const staff = new Map<string, { name: string; discountCount: number; discountAmount: number; voidCount: number; voidAmount: number }>();

    const entry = (id: string, name: string) => {
      const existing = staff.get(id);
      if (existing) return existing;
      const created = { name, discountCount: 0, discountAmount: 0, voidCount: 0, voidAmount: 0 };
      staff.set(id, created);
      return created;
    };

    for (const discount of discounts) {
      if (!discount.by) continue;
      const row = entry(discount.by.id, discount.by.name);
      row.discountCount++;
      row.discountAmount += discount.discountAmount;
    }

    for (const voided of voids) {
      if (!voided.voidedBy) continue;
      const row = entry(voided.voidedBy.id, voided.voidedBy.name);
      row.voidCount++;
      row.voidAmount += voided.amount;
    }

    return [...staff.entries()]
      .map(([id, row]) => ({ staffId: id, ...row }))
      .sort((a, b) => b.discountAmount + b.voidAmount - (a.discountAmount + a.voidAmount));
  }

  // -------------------------------------------------------------------------

  /**
   * Customers who used both sections in the period, with their spend in each.
   *
   * This is the report the combo-offer decision rests on: it is only possible
   * because both sections resolve a guardian to the same customer record by
   * phone number.
   */
  async crossSection(range: DateRange): Promise<Record<string, unknown>> {
    const from = toDateColumn(range.from);
    const to = toDateColumn(range.to);

    const rows = await this.prisma.$queryRaw<
      Array<{
        customer_id: string;
        name: string;
        phone: string;
        kidzone_spend: bigint;
        kidzone_transactions: bigint;
        restaurant_spend: bigint;
        restaurant_transactions: bigint;
      }>
    >(Prisma.sql`
      WITH kidzone AS (
        SELECT "customerId"  AS customer_id,
               SUM("totalAmount")::bigint AS spend,
               COUNT(*)::bigint AS transactions
        FROM "kidzone_sales"
        WHERE "status" = 'COMPLETED' AND "businessDate" BETWEEN ${from}::date AND ${to}::date
        GROUP BY "customerId"
      ),
      restaurant AS (
        SELECT "customerId" AS customer_id,
               SUM("totalAmount")::bigint AS spend,
               COUNT(*)::bigint AS transactions
        FROM "orders"
        WHERE "status" = 'PAID'
          AND "customerId" IS NOT NULL
          AND "businessDate" BETWEEN ${from}::date AND ${to}::date
        GROUP BY "customerId"
      )
      SELECT c."id"   AS customer_id,
             c."name" AS name,
             c."phone" AS phone,
             k."spend" AS kidzone_spend,
             k."transactions" AS kidzone_transactions,
             r."spend" AS restaurant_spend,
             r."transactions" AS restaurant_transactions
      FROM kidzone k
      JOIN restaurant r ON r.customer_id = k.customer_id
      JOIN "customers" c ON c."id" = k.customer_id
      ORDER BY (k."spend" + r."spend") DESC
    `);

    const customers = rows.map((row) => {
      const kidZoneSpend = Number(row.kidzone_spend);
      const restaurantSpend = Number(row.restaurant_spend);
      return {
        customerId: row.customer_id,
        name: row.name,
        phone: row.phone,
        kidZoneSpend,
        kidZoneTransactions: Number(row.kidzone_transactions),
        restaurantSpend,
        restaurantTransactions: Number(row.restaurant_transactions),
        totalSpend: kidZoneSpend + restaurantSpend,
      };
    });

    // Denominators for "what share of Kid Zone customers also eat here?"
    const [kidZoneCustomers, restaurantCustomers] = await Promise.all([
      this.prisma.kidZoneSale.findMany({
        where: { status: SaleStatus.COMPLETED, businessDate: { gte: from, lte: to } },
        select: { customerId: true },
        distinct: ['customerId'],
      }),
      this.prisma.order.findMany({
        where: { status: OrderStatus.PAID, customerId: { not: null }, businessDate: { gte: from, lte: to } },
        select: { customerId: true },
        distinct: ['customerId'],
      }),
    ]);

    const totalSpend = customers.reduce((n, c) => n + c.totalSpend, 0);

    return {
      customers,
      summary: {
        crossSectionCustomers: customers.length,
        kidZoneCustomers: kidZoneCustomers.length,
        restaurantCustomers: restaurantCustomers.length,
        /** Of the guardians who bought in the Kid Zone, how many also ate here. */
        crossoverRate:
          kidZoneCustomers.length > 0
            ? Math.round((customers.length / kidZoneCustomers.length) * 1000) / 10
            : 0,
        totalSpend,
        kidZoneSpend: customers.reduce((n, c) => n + c.kidZoneSpend, 0),
        restaurantSpend: customers.reduce((n, c) => n + c.restaurantSpend, 0),
        averageSpendPerCustomer: customers.length > 0 ? Math.round(totalSpend / customers.length) : 0,
      },
    };
  }

  // -------------------------------------------------------------------------

  private sectionFilter(section?: Section): Prisma.PaymentWhereInput {
    if (section === Section.KIDZONE) {
      return { OR: [{ kidZoneSale: { status: SaleStatus.COMPLETED } }, { visitId: { not: null } }] };
    }
    if (section === Section.RESTAURANT) {
      return { order: { status: OrderStatus.PAID } };
    }
    // Both: exclude payments whose parent transaction was voided.
    return {
      OR: [
        { kidZoneSale: { status: SaleStatus.COMPLETED } },
        { order: { status: OrderStatus.PAID } },
        { visitId: { not: null } },
      ],
    };
  }
}

function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}
