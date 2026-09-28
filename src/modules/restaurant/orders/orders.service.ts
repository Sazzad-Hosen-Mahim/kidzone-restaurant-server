import { Injectable } from '@nestjs/common';
import { paginationOrderBy, paginationPage, paginationSkip, paginationTake } from '@common/dto/pagination-query.dto';
import { MenuItem, Order, OrderStatus, Prisma, Section } from '@prisma/client';
import { PrismaService, PrismaTransaction } from '@/prisma/prisma.service';
import { AuditService } from '@modules/audit/audit.service';
import { AUDIT_ACTIONS } from '@modules/audit/audit.constants';
import { SettingsService } from '@modules/settings/settings.service';
import { PaymentsService } from '@modules/payments/payments.service';
import { CustomersService } from '@modules/customers/customers.service';
import { DayLockService } from '@modules/closing/day-lock.service';
import { SequenceService } from '@common/services/sequence.service';
import { BusinessCalendarService } from '@common/services/business-calendar.service';
import { validateDiscount } from '@common/domain/discount';
import { DomainException, NotFoundDomainException } from '@common/exceptions/domain.exception';
import { PageResult, paginate, toSalesSummary } from '@common/http/api-response';
import { ClientInfo } from '@common/decorators/client-info.decorator';
import { AuthenticatedUser } from '@common/types/authenticated-user';
import { fromDateColumn, toDateColumn } from '@common/utils/date.util';
import { priceOrder } from '../domain/order-pricing';
import { CreateOrderDto, QueryOrdersDto, VoidOrderDto } from './dto/order.dto';

const SORTABLE = ['createdAt', 'businessDate', 'totalAmount', 'receiptNo'] as const;

const ORDER_INCLUDE = {
  items: true,
  payments: true,
  customer: { select: { id: true, name: true, phone: true } },
  cashier: { select: { id: true, name: true } },
  voidedBy: { select: { id: true, name: true } },
} satisfies Prisma.OrderInclude;

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly payments: PaymentsService,
    private readonly sequences: SequenceService,
    private readonly calendar: BusinessCalendarService,
    private readonly settings: SettingsService,
    private readonly dayLock: DayLockService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Takes an order.
   *
   * Two things are deliberately not trusted from the client: prices and totals.
   * Every unit price is read from the database inside the transaction and
   * snapshotted onto the line, and the bill is computed by the pure pricing
   * function. A client that sends a price is simply ignored — there is no field
   * for it.
   *
   * The VAT and service charge percentages are snapshotted too, so reprinting
   * this receipt after a rate change still reproduces the original figures.
   */
  async create(dto: CreateOrderDto, actor: AuthenticatedUser, client: ClientInfo): Promise<Order> {
    const today = await this.calendar.today();
    await this.dayLock.assertOpen(Section.RESTAURANT, today, 'A new order');

    const { vatPercent, serviceChargePercent, maxStaffDiscountPercent } = await this.settings.getAll();

    return this.prisma.runInTransaction(async (tx) => {
      const menuItems = await this.loadSellableItems(tx, dto.items.map((i) => i.menuItemId));

      const pricing = priceOrder({
        lines: dto.items.map((line) => ({
          unitPrice: menuItems.get(line.menuItemId)!.price,
          quantity: line.quantity,
        })),
        discountAmount: 0, // validated below, then re-applied
        serviceChargePercent,
        vatPercent,
      });

      const discount = validateDiscount({
        subtotal: pricing.subtotal,
        discountAmount: dto.discountAmount ?? 0,
        discountReason: dto.discountReason,
        role: actor.role,
        maxStaffDiscountPercent,
      });

      const final = priceOrder({
        lines: pricing.lines,
        discountAmount: discount.discountAmount,
        serviceChargePercent,
        vatPercent,
      });

      this.payments.assertSettlesExactly(dto.payments, final.totalAmount);

      const customerId = dto.customerPhone
        ? (
            await this.customers.resolveCustomer(tx, {
              phone: dto.customerPhone,
              name: dto.customerName,
            })
          ).id
        : null;

      const receiptNo = await this.sequences.nextReceiptNo(Section.RESTAURANT, today, tx);

      const created = await tx.order.create({
        data: {
          receiptNo,
          businessDate: toDateColumn(today),
          customerId,
          tableNo: dto.tableNo ?? null,
          subtotal: final.subtotal,
          discountAmount: final.discountAmount,
          discountReason: final.discountAmount > 0 ? dto.discountReason!.trim() : null,
          vatPercent: new Prisma.Decimal(vatPercent),
          vatAmount: final.vatAmount,
          serviceChargePercent: new Prisma.Decimal(serviceChargePercent),
          serviceChargeAmount: final.serviceChargeAmount,
          totalAmount: final.totalAmount,
          status: OrderStatus.PAID,
          cashierId: actor.id,
          items: {
            create: dto.items.map((line, index) => {
              const item = menuItems.get(line.menuItemId)!;
              return {
                menuItemId: item.id,
                itemNameSnapshot: item.name,
                unitPriceSnapshot: item.price,
                categoryNameSnapshot: item.categoryName,
                quantity: line.quantity,
                lineTotal: final.lines[index].lineTotal,
                note: line.note ?? null,
              };
            }),
          },
        },
      });

      await this.payments.createMany(
        tx,
        dto.payments,
        { orderId: created.id },
        { receivedById: actor.id, businessDate: today },
      );

      // Re-read so the response carries the payments that were just written;
      // the create() above returns the row as it looked before they existed.
      const order = await tx.order.findUniqueOrThrow({ where: { id: created.id }, include: ORDER_INCLUDE });

      await this.audit.record(
        {
          actorId: actor.id,
          action: AUDIT_ACTIONS.ORDER_CREATED,
          entityType: 'Order',
          entityId: created.id,
          after: {
            receiptNo,
            subtotal: final.subtotal,
            serviceChargeAmount: final.serviceChargeAmount,
            vatAmount: final.vatAmount,
            totalAmount: final.totalAmount,
            itemCount: dto.items.length,
            businessDate: today,
          },
          ip: client.ip,
          userAgent: client.userAgent,
        },
        tx,
      );

      if (discount.requiresAudit) {
        await this.audit.record(
          {
            actorId: actor.id,
            action: AUDIT_ACTIONS.DISCOUNT_APPLIED,
            entityType: 'Order',
            entityId: created.id,
            after: {
              discountAmount: discount.discountAmount,
              discountPercent: discount.discountPercent,
              subtotal: final.subtotal,
              totalAmount: final.totalAmount,
            },
            reason: dto.discountReason!.trim(),
            ip: client.ip,
            userAgent: client.userAgent,
          },
          tx,
        );
      }

      return this.serialize(order);
    });
  }

  /**
   * Voids an order. Like a Kid Zone sale it is never deleted: the row and its
   * payments stay, marked VOIDED with a reason, excluded from revenue and
   * reported separately.
   */
  async voidOrder(id: string, dto: VoidOrderDto, actor: AuthenticatedUser, client: ClientInfo): Promise<Order> {
    const reason = dto.reason?.trim();
    if (!reason || reason.length < 5) {
      throw new DomainException(
        'VOID_REASON_REQUIRED',
        'A reason of at least 5 characters is required to void an order',
        400,
      );
    }

    return this.prisma.runInTransaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id } });
      if (!order) throw new NotFoundDomainException('Order', id);

      if (order.status === OrderStatus.VOIDED) {
        throw new DomainException('ORDER_ALREADY_VOIDED', 'This order has already been voided', 409, {
          voidedAt: order.voidedAt,
        });
      }

      const businessDate = fromDateColumn(order.businessDate);
      await this.dayLock.assertOpen(Section.RESTAURANT, businessDate, 'Voiding this order', tx);

      const voided = await tx.order.update({
        where: { id },
        data: { status: OrderStatus.VOIDED, voidedById: actor.id, voidReason: reason, voidedAt: new Date() },
        include: ORDER_INCLUDE,
      });

      await this.audit.record(
        {
          actorId: actor.id,
          action: AUDIT_ACTIONS.ORDER_VOIDED,
          entityType: 'Order',
          entityId: id,
          before: { status: OrderStatus.PAID, totalAmount: order.totalAmount, receiptNo: order.receiptNo },
          after: { status: OrderStatus.VOIDED },
          reason,
          ip: client.ip,
          userAgent: client.userAgent,
        },
        tx,
      );

      return this.serialize(voided);
    });
  }

  async list(query: QueryOrdersDto): Promise<PageResult<unknown>> {
    const where: Prisma.OrderWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.cashierId ? { cashierId: query.cashierId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.tableNo ? { tableNo: query.tableNo } : {}),
      ...(query.from || query.to
        ? {
            businessDate: {
              ...(query.from ? { gte: toDateColumn(query.from) } : {}),
              ...(query.to ? { lte: toDateColumn(query.to) } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { receiptNo: { contains: query.search, mode: 'insensitive' } },
              { tableNo: { contains: query.search, mode: 'insensitive' } },
              { customer: { name: { contains: query.search, mode: 'insensitive' } } },
              { customer: { phone: { contains: query.search } } },
            ],
          }
        : {}),
    };

    const [items, total, groups] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: paginationOrderBy(query, SORTABLE, 'createdAt'),
        skip: paginationSkip(query),
        take: paginationTake(query),
        include: ORDER_INCLUDE,
      }),
      this.prisma.order.count({ where }),
      this.prisma.order.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
    ]);

    return paginate(
      items.map((o) => this.serialize(o)),
      total,
      paginationPage(query),
      paginationTake(query),
      toSalesSummary(groups, OrderStatus.VOIDED),
    );
  }

  async findOne(id: string): Promise<Order> {
    const order = await this.prisma.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
    if (!order) throw new NotFoundDomainException('Order', id);
    return this.serialize(order);
  }

  // -------------------------------------------------------------------------

  /**
   * Loads and validates the ordered items in one query, rejecting anything
   * unavailable or retired before a single row is written.
   */
  private async loadSellableItems(
    tx: PrismaTransaction,
    ids: string[],
  ): Promise<Map<string, MenuItem & { categoryName: string }>> {
    const unique = [...new Set(ids)];

    const items = await tx.menuItem.findMany({
      where: { id: { in: unique } },
      include: { category: { select: { name: true } } },
    });

    const found = new Map(items.map((item) => [item.id, { ...item, categoryName: item.category.name }]));

    const missing = unique.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new DomainException('MENU_ITEM_NOT_FOUND', 'One or more items are not on the menu', 404, { missing });
    }

    const unsellable = items
      .filter((item) => !item.isActive || item.deletedAt || !item.isAvailable)
      .map((item) => ({
        id: item.id,
        name: item.name,
        reason: !item.isActive || item.deletedAt ? 'removed from the menu' : 'currently unavailable',
      }));

    if (unsellable.length > 0) {
      throw new DomainException(
        'MENU_ITEM_UNAVAILABLE',
        `${unsellable.map((i) => `"${i.name}" is ${i.reason}`).join('; ')}`,
        422,
        { items: unsellable },
      );
    }

    return found;
  }

  private serialize<T extends { businessDate: Date; vatPercent: Prisma.Decimal; serviceChargePercent: Prisma.Decimal }>(
    order: T,
  ): T {
    return {
      ...order,
      businessDate: fromDateColumn(order.businessDate),
      // Decimal serialises as an object over JSON; a number is what the client
      // and every report actually wants.
      vatPercent: order.vatPercent.toNumber(),
      serviceChargePercent: order.serviceChargePercent.toNumber(),
    } as unknown as T;
  }
}
