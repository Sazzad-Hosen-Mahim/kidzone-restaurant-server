import { Injectable } from '@nestjs/common';
import { OrderStatus, SaleStatus, VisitStatus } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { SettingsService } from '@modules/settings/settings.service';
import { BusinessCalendarService } from '@common/services/business-calendar.service';
import { NotFoundDomainException } from '@common/exceptions/domain.exception';
import { formatInTimezone, fromDateColumn } from '@common/utils/date.util';
import { toLocalDisplay } from '@common/utils/phone.util';

/**
 * The structured receipt documents.
 *
 * Everything on a receipt comes from the *snapshots* stored on the sale or
 * order — item names, unit prices, VAT and service charge percentages — never
 * from the live catalogue or the current settings. Reprinting a six-month-old
 * bill therefore reproduces it exactly, even after prices and tax rates have
 * moved on. Only the business header and footer are read live, since those are
 * about the shop rather than the transaction.
 */

export interface ReceiptBusiness {
  name: string;
  address: string;
  phone: string;
  footer: string;
}

export interface ReceiptLine {
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  note?: string | null;
  category?: string;
}

export interface ReceiptPayment {
  method: string;
  amount: number;
  reference: string | null;
}

export interface ReceiptTotals {
  subtotal: number;
  discountAmount: number;
  discountReason?: string | null;
  serviceChargePercent?: number;
  serviceChargeAmount?: number;
  vatPercent?: number;
  vatAmount?: number;
  totalAmount: number;
}

export interface ReceiptDocument {
  kind: 'KIDZONE_SALE' | 'RESTAURANT_ORDER' | 'GATEPASS';
  business: ReceiptBusiness;
  receiptNo: string;
  businessDate: string;
  /** Rendered in the business timezone, ready to print. */
  issuedAt: string;
  issuedAtIso: string;
  timezone: string;
  customer: { name: string; phone: string } | null;
  lines: ReceiptLine[];
  totals: ReceiptTotals;
  payments: ReceiptPayment[];
  servedBy: string;
  tableNo?: string | null;
  /** Set when the underlying sale or order has been voided. */
  voided: {
    isVoided: boolean;
    reason?: string | null;
    voidedAt?: string | null;
    voidedBy?: string | null;
  };
  /** Gatepass only. */
  gatepass?: {
    gatepassNo: string;
    childName: string;
    planName: string;
    checkInAt: string;
    expectedCheckOutAt: string | null;
    checkOutAt: string | null;
    status: VisitStatus;
    /** What to encode in the printed QR square. */
    qrPayload: string;
    overtimeMinutes: number;
    overtimeCharge: number;
  };
}

@Injectable()
export class ReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly calendar: BusinessCalendarService,
  ) {}

  async kidZoneSale(saleId: string): Promise<ReceiptDocument> {
    const sale = await this.prisma.kidZoneSale.findUnique({
      where: { id: saleId },
      include: {
        customer: true,
        child: true,
        soldBy: { select: { name: true } },
        voidedBy: { select: { name: true } },
        payments: true,
        membership: true,
      },
    });
    if (!sale) throw new NotFoundDomainException('Sale', saleId);

    const { business, tz } = await this.header();

    return {
      kind: 'KIDZONE_SALE',
      business,
      receiptNo: sale.receiptNo,
      businessDate: fromDateColumn(sale.businessDate),
      issuedAt: formatInTimezone(sale.createdAt, tz),
      issuedAtIso: sale.createdAt.toISOString(),
      timezone: tz,
      customer: { name: sale.customer.name, phone: toLocalDisplay(sale.customer.phone) },
      lines: [
        {
          name: sale.planNameSnapshot,
          quantity: 1,
          unitPrice: sale.unitPriceSnapshot,
          lineTotal: sale.unitPriceSnapshot,
          note: `For ${sale.child.name}`,
        },
      ],
      totals: {
        subtotal: sale.unitPriceSnapshot,
        discountAmount: sale.discountAmount,
        discountReason: sale.discountReason,
        totalAmount: sale.totalAmount,
      },
      payments: sale.payments.map(toReceiptPayment),
      servedBy: sale.soldBy.name,
      voided: {
        isVoided: sale.status === SaleStatus.VOIDED,
        reason: sale.voidReason,
        voidedAt: sale.voidedAt ? formatInTimezone(sale.voidedAt, tz) : null,
        voidedBy: sale.voidedBy?.name ?? null,
      },
    };
  }

  async restaurantOrder(orderId: string): Promise<ReceiptDocument> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: true,
        cashier: { select: { name: true } },
        voidedBy: { select: { name: true } },
        items: true,
        payments: true,
      },
    });
    if (!order) throw new NotFoundDomainException('Order', orderId);

    const { business, tz } = await this.header();

    return {
      kind: 'RESTAURANT_ORDER',
      business,
      receiptNo: order.receiptNo,
      businessDate: fromDateColumn(order.businessDate),
      issuedAt: formatInTimezone(order.createdAt, tz),
      issuedAtIso: order.createdAt.toISOString(),
      timezone: tz,
      customer: order.customer
        ? { name: order.customer.name, phone: toLocalDisplay(order.customer.phone) }
        : null,
      tableNo: order.tableNo,
      lines: order.items.map((item) => ({
        name: item.itemNameSnapshot,
        category: item.categoryNameSnapshot,
        quantity: item.quantity,
        unitPrice: item.unitPriceSnapshot,
        lineTotal: item.lineTotal,
        note: item.note,
      })),
      totals: {
        subtotal: order.subtotal,
        discountAmount: order.discountAmount,
        discountReason: order.discountReason,
        serviceChargePercent: order.serviceChargePercent.toNumber(),
        serviceChargeAmount: order.serviceChargeAmount,
        vatPercent: order.vatPercent.toNumber(),
        vatAmount: order.vatAmount,
        totalAmount: order.totalAmount,
      },
      payments: order.payments.map(toReceiptPayment),
      servedBy: order.cashier.name,
      voided: {
        isVoided: order.status === OrderStatus.VOIDED,
        reason: order.voidReason,
        voidedAt: order.voidedAt ? formatInTimezone(order.voidedAt, tz) : null,
        voidedBy: order.voidedBy?.name ?? null,
      },
    };
  }

  /**
   * The gatepass a guardian shows to collect their child.
   *
   * `qrPayload` is the gatepass number, not the membership QR token: a printed
   * slip that can be dropped on the floor must not carry a credential that
   * would let anyone check a child in.
   */
  async gatepass(visitId: string): Promise<ReceiptDocument> {
    const visit = await this.prisma.visit.findUnique({
      where: { id: visitId },
      include: {
        customer: true,
        child: true,
        checkedInBy: { select: { name: true } },
        membership: { include: { plan: { select: { name: true } } } },
        sale: { select: { receiptNo: true, planNameSnapshot: true, status: true, voidReason: true, voidedAt: true } },
        payments: true,
      },
    });
    if (!visit) throw new NotFoundDomainException('Visit', visitId);

    const { business, tz } = await this.header();

    const planName = visit.sale?.planNameSnapshot ?? visit.membership?.plan.name ?? 'Kid Zone visit';
    const saleVoided = visit.sale?.status === SaleStatus.VOIDED;

    return {
      kind: 'GATEPASS',
      business,
      receiptNo: visit.gatepassNo,
      businessDate: fromDateColumn(visit.businessDate),
      issuedAt: formatInTimezone(visit.checkInAt, tz),
      issuedAtIso: visit.checkInAt.toISOString(),
      timezone: tz,
      customer: { name: visit.customer.name, phone: toLocalDisplay(visit.customer.phone) },
      lines: [
        {
          name: planName,
          quantity: 1,
          unitPrice: 0,
          lineTotal: 0,
          note: `For ${visit.child.name}`,
        },
      ],
      totals: {
        subtotal: visit.overtimeCharge,
        discountAmount: 0,
        totalAmount: visit.overtimeCharge,
      },
      payments: visit.payments.map(toReceiptPayment),
      servedBy: visit.checkedInBy.name,
      voided: {
        isVoided: saleVoided,
        reason: visit.sale?.voidReason ?? null,
        voidedAt: visit.sale?.voidedAt ? formatInTimezone(visit.sale.voidedAt, tz) : null,
      },
      gatepass: {
        gatepassNo: visit.gatepassNo,
        childName: visit.child.name,
        planName,
        checkInAt: formatInTimezone(visit.checkInAt, tz),
        expectedCheckOutAt: visit.expectedCheckOutAt ? formatInTimezone(visit.expectedCheckOutAt, tz) : null,
        checkOutAt: visit.checkOutAt ? formatInTimezone(visit.checkOutAt, tz) : null,
        status: visit.status,
        qrPayload: visit.gatepassNo,
        overtimeMinutes: visit.overtimeMinutes,
        overtimeCharge: visit.overtimeCharge,
      },
    };
  }

  private async header(): Promise<{ business: ReceiptBusiness; tz: string }> {
    const all = await this.settings.getAll();
    return {
      business: {
        name: all.businessName,
        address: all.address,
        phone: all.phone,
        footer: all.receiptFooter,
      },
      tz: await this.calendar.timezone(),
    };
  }
}

function toReceiptPayment(payment: { method: string; amount: number; reference: string | null }): ReceiptPayment {
  return { method: payment.method, amount: payment.amount, reference: payment.reference };
}
