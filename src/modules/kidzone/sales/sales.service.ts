import { Injectable, Logger } from '@nestjs/common';
import { paginationOrderBy, paginationPage, paginationSkip, paginationTake } from '@common/dto/pagination-query.dto';
import {
  KidZonePlan,
  KidZoneSale,
  Membership,
  MembershipStatus,
  PlanType,
  Prisma,
  SaleStatus,
  Section,
  SmsType,
  VerificationMethod,
  Visit,
  VisitStatus,
} from '@prisma/client';
import { PrismaService, PrismaTransaction } from '@/prisma/prisma.service';
import { AuditService } from '@modules/audit/audit.service';
import { AUDIT_ACTIONS } from '@modules/audit/audit.constants';
import { SettingsService } from '@modules/settings/settings.service';
import { PaymentsService } from '@modules/payments/payments.service';
import { CustomersService } from '@modules/customers/customers.service';
import { DayLockService } from '@modules/closing/day-lock.service';
import { SmsService } from '@modules/sms/sms.service';
import { SmsTemplatesService } from '@modules/sms/sms-templates.service';
import { PlansService } from '../plans/plans.service';
import { generateQrToken, membershipTerm, renewalStartDate } from '../domain/membership';
import { validateDiscount } from '@common/domain/discount';
import { SequenceService } from '@common/services/sequence.service';
import { BusinessCalendarService } from '@common/services/business-calendar.service';
import { DomainException, NotFoundDomainException } from '@common/exceptions/domain.exception';
import { PageResult, paginate, toSalesSummary } from '@common/http/api-response';
import { ClientInfo } from '@common/decorators/client-info.decorator';
import { AuthenticatedUser } from '@common/types/authenticated-user';
import { BusinessDate, formatInTimezone, fromDateColumn, toDateColumn } from '@common/utils/date.util';
import { CreateKidZoneSaleDto, RenewMembershipDto, VoidSaleDto } from './dto/create-sale.dto';
import { QueryKidZoneSalesDto } from './dto/query-sales.dto';

const SORTABLE = ['createdAt', 'businessDate', 'totalAmount', 'receiptNo'] as const;

export interface SaleResult {
  sale: KidZoneSale;
  membership: Membership | null;
  visit: Visit | null;
}

/** Deferred until after the transaction commits, so a rollback sends nothing. */
interface PendingSms {
  phone: string;
  type: SmsType;
  message: string;
}

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlansService,
    private readonly customers: CustomersService,
    private readonly payments: PaymentsService,
    private readonly sequences: SequenceService,
    private readonly calendar: BusinessCalendarService,
    private readonly settings: SettingsService,
    private readonly dayLock: DayLockService,
    private readonly audit: AuditService,
    private readonly sms: SmsService,
    private readonly templates: SmsTemplatesService,
  ) {}

  // -------------------------------------------------------------------------
  // Selling
  // -------------------------------------------------------------------------

  /**
   * Sells a plan.
   *
   * Everything that touches money happens in one transaction: resolving the
   * customer and child, snapshotting the price, allocating the receipt number,
   * writing the sale, its payments and either the membership or the opening
   * visit. If any step fails, nothing is written and the receipt number is not
   * consumed.
   *
   * SMS is deliberately queued *after* the commit, so a rolled-back sale never
   * texts the guardian a membership they do not have.
   */
  async createSale(dto: CreateKidZoneSaleDto, actor: AuthenticatedUser, client: ClientInfo): Promise<SaleResult> {
    const today = await this.calendar.today();
    await this.dayLock.assertOpen(Section.KIDZONE, today, 'A new Kid Zone sale');

    const maxStaffDiscountPercent = await this.settings.get('maxStaffDiscountPercent');
    const pending: PendingSms[] = [];

    const result = await this.prisma.runInTransaction(async (tx) => {
      const customer = await this.customers.resolveCustomer(tx, dto.customer);
      const child = await this.customers.resolveChild(tx, customer.id, dto.child);
      const plan = await this.plans.findSellable(tx, dto.planId);

      const unitPrice = plan.price;
      const discount = validateDiscount({
        subtotal: unitPrice,
        discountAmount: dto.discountAmount ?? 0,
        discountReason: dto.discountReason,
        role: actor.role,
        maxStaffDiscountPercent,
      });

      const totalAmount = unitPrice - discount.discountAmount;
      this.payments.assertSettlesExactly(dto.payments, totalAmount);

      const receiptNo = await this.sequences.nextReceiptNo(Section.KIDZONE, today, tx);

      const sale = await tx.kidZoneSale.create({
        data: {
          receiptNo,
          businessDate: toDateColumn(today),
          customerId: customer.id,
          childId: child.id,
          planId: plan.id,
          planNameSnapshot: plan.name,
          unitPriceSnapshot: unitPrice,
          discountAmount: discount.discountAmount,
          discountReason: discount.discountAmount > 0 ? dto.discountReason!.trim() : null,
          totalAmount,
          status: SaleStatus.COMPLETED,
          soldById: actor.id,
        },
      });

      await this.payments.createMany(
        tx,
        dto.payments,
        { kidZoneSaleId: sale.id },
        { receivedById: actor.id, businessDate: today },
      );

      let membership: Membership | null = null;
      let visit: Visit | null = null;

      if (plan.type === PlanType.MEMBERSHIP) {
        membership = await this.createMembershipForSale(tx, { plan, sale, customerId: customer.id, childId: child.id, startDate: today });
        pending.push(await this.membershipSms(customer.name, customer.phone, child.name, plan, membership));
      } else {
        visit = await this.openSessionVisit(tx, { plan, sale, customerId: customer.id, childId: child.id, businessDate: today, actorId: actor.id });
        pending.push(await this.gatepassSms(customer.name, customer.phone, child.name, visit));
      }

      await this.audit.record(
        {
          actorId: actor.id,
          action: AUDIT_ACTIONS.SALE_CREATED,
          entityType: 'KidZoneSale',
          entityId: sale.id,
          after: { receiptNo, planName: plan.name, totalAmount, businessDate: today },
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
            entityType: 'KidZoneSale',
            entityId: sale.id,
            after: {
              discountAmount: discount.discountAmount,
              discountPercent: discount.discountPercent,
              unitPrice,
              totalAmount,
            },
            reason: dto.discountReason!.trim(),
            ip: client.ip,
            userAgent: client.userAgent,
          },
          tx,
        );
      }

      return { sale, membership, visit };
    });

    await this.flush(pending);
    return result;
  }

  /**
   * Renews a membership.
   *
   * An early renewal starts the day after the current end date so the customer
   * keeps every day they already paid for; a lapsed one simply restarts today.
   * The new membership is linked to the old through `renewedFromId`, which is
   * what the renewal counts in the reports are built on.
   */
  async renew(
    membershipId: string,
    dto: RenewMembershipDto,
    actor: AuthenticatedUser,
    client: ClientInfo,
  ): Promise<SaleResult> {
    const today = await this.calendar.today();
    await this.dayLock.assertOpen(Section.KIDZONE, today, 'A membership renewal');

    const maxStaffDiscountPercent = await this.settings.get('maxStaffDiscountPercent');
    const pending: PendingSms[] = [];

    const result = await this.prisma.runInTransaction(async (tx) => {
      const previous = await tx.membership.findUnique({
        where: { id: membershipId },
        include: { customer: true, child: true, plan: true, renewedTo: { select: { id: true } } },
      });
      if (!previous) throw new NotFoundDomainException('Membership', membershipId);

      if (previous.renewedTo) {
        throw new DomainException(
          'MEMBERSHIP_ALREADY_RENEWED',
          'This membership has already been renewed. Renew the newer one instead.',
          409,
          { membershipId, renewedToId: previous.renewedTo.id },
        );
      }
      if (previous.status === MembershipStatus.CANCELLED) {
        throw new DomainException('MEMBERSHIP_CANCELLED', 'A cancelled membership cannot be renewed', 409);
      }

      const plan = await this.plans.findSellable(tx, dto.planId ?? previous.planId);
      if (plan.type !== PlanType.MEMBERSHIP) {
        throw new DomainException('PLAN_NOT_A_MEMBERSHIP', 'A membership can only be renewed onto a membership plan', 422);
      }

      const unitPrice = plan.price;
      const discount = validateDiscount({
        subtotal: unitPrice,
        discountAmount: dto.discountAmount ?? 0,
        discountReason: dto.discountReason,
        role: actor.role,
        maxStaffDiscountPercent,
      });

      const totalAmount = unitPrice - discount.discountAmount;
      this.payments.assertSettlesExactly(dto.payments, totalAmount);

      const receiptNo = await this.sequences.nextReceiptNo(Section.KIDZONE, today, tx);

      const sale = await tx.kidZoneSale.create({
        data: {
          receiptNo,
          businessDate: toDateColumn(today),
          customerId: previous.customerId,
          childId: previous.childId,
          planId: plan.id,
          planNameSnapshot: plan.name,
          unitPriceSnapshot: unitPrice,
          discountAmount: discount.discountAmount,
          discountReason: discount.discountAmount > 0 ? dto.discountReason!.trim() : null,
          totalAmount,
          status: SaleStatus.COMPLETED,
          soldById: actor.id,
        },
      });

      await this.payments.createMany(
        tx,
        dto.payments,
        { kidZoneSaleId: sale.id },
        { receivedById: actor.id, businessDate: today },
      );

      const startDate = renewalStartDate(fromDateColumn(previous.endDate), today);
      const membership = await this.createMembershipForSale(tx, {
        plan,
        sale,
        customerId: previous.customerId,
        childId: previous.childId,
        startDate,
        renewedFromId: previous.id,
      });

      await this.audit.record(
        {
          actorId: actor.id,
          action: AUDIT_ACTIONS.MEMBERSHIP_RENEWED,
          entityType: 'Membership',
          entityId: membership.id,
          before: { membershipId: previous.id, endDate: fromDateColumn(previous.endDate) },
          after: {
            membershipId: membership.id,
            startDate: fromDateColumn(membership.startDate),
            endDate: fromDateColumn(membership.endDate),
            receiptNo,
            totalAmount,
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
            entityType: 'KidZoneSale',
            entityId: sale.id,
            after: { discountAmount: discount.discountAmount, discountPercent: discount.discountPercent },
            reason: dto.discountReason!.trim(),
            ip: client.ip,
            userAgent: client.userAgent,
          },
          tx,
        );
      }

      pending.push(
        await this.membershipSms(previous.customer.name, previous.customer.phone, previous.child.name, plan, membership),
      );

      return { sale, membership, visit: null };
    });

    await this.flush(pending);
    return result;
  }

  // -------------------------------------------------------------------------
  // Voiding
  // -------------------------------------------------------------------------

  /**
   * Voids a sale. Financial records are never deleted — the row stays, marked
   * VOIDED with a reason, and reports exclude it from revenue while counting it
   * separately.
   *
   * Voiding a membership sale also cancels the membership it created, otherwise
   * a refunded customer would keep walking through the gate.
   */
  async voidSale(id: string, dto: VoidSaleDto, actor: AuthenticatedUser, client: ClientInfo): Promise<KidZoneSale> {
    const reason = dto.reason?.trim();
    if (!reason || reason.length < 5) {
      throw new DomainException('VOID_REASON_REQUIRED', 'A reason of at least 5 characters is required to void a sale', 400);
    }

    return this.prisma.runInTransaction(async (tx) => {
      const sale = await tx.kidZoneSale.findUnique({
        where: { id },
        include: { membership: true, visits: true },
      });
      if (!sale) throw new NotFoundDomainException('Sale', id);

      if (sale.status === SaleStatus.VOIDED) {
        throw new DomainException('SALE_ALREADY_VOIDED', 'This sale has already been voided', 409, {
          voidedAt: sale.voidedAt,
        });
      }

      const businessDate = fromDateColumn(sale.businessDate);
      await this.dayLock.assertOpen(Section.KIDZONE, businessDate, 'Voiding this sale', tx);

      const voided = await tx.kidZoneSale.update({
        where: { id },
        data: { status: SaleStatus.VOIDED, voidedById: actor.id, voidReason: reason, voidedAt: new Date() },
      });

      if (sale.membership) {
        await tx.membership.update({
          where: { id: sale.membership.id },
          data: { status: MembershipStatus.CANCELLED },
        });
      }

      // A session that is still in progress is closed out; the child is leaving.
      for (const visit of sale.visits) {
        if (visit.status === VisitStatus.ACTIVE) {
          await tx.visit.update({
            where: { id: visit.id },
            data: { status: VisitStatus.COMPLETED, checkOutAt: new Date(), checkedOutById: actor.id },
          });
        }
      }

      await this.audit.record(
        {
          actorId: actor.id,
          action: AUDIT_ACTIONS.SALE_VOIDED,
          entityType: 'KidZoneSale',
          entityId: id,
          before: { status: SaleStatus.COMPLETED, totalAmount: sale.totalAmount, receiptNo: sale.receiptNo },
          after: { status: SaleStatus.VOIDED, membershipCancelled: sale.membership?.id ?? null },
          reason,
          ip: client.ip,
          userAgent: client.userAgent,
        },
        tx,
      );

      return voided;
    });
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(query: QueryKidZoneSalesDto): Promise<PageResult<unknown>> {
    const where: Prisma.KidZoneSaleWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.childId ? { childId: query.childId } : {}),
      ...(query.planId ? { planId: query.planId } : {}),
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
              { customer: { name: { contains: query.search, mode: 'insensitive' } } },
              { customer: { phone: { contains: query.search } } },
            ],
          }
        : {}),
    };

    const [items, total, groups] = await Promise.all([
      this.prisma.kidZoneSale.findMany({
        where,
        orderBy: paginationOrderBy(query, SORTABLE, 'createdAt'),
        skip: paginationSkip(query),
        take: paginationTake(query),
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          child: { select: { id: true, name: true } },
          soldBy: { select: { id: true, name: true } },
          payments: { select: { id: true, method: true, amount: true, reference: true } },
        },
      }),
      this.prisma.kidZoneSale.count({ where }),
      this.prisma.kidZoneSale.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
    ]);

    return paginate(
      items.map((sale) => ({ ...sale, businessDate: fromDateColumn(sale.businessDate) })),
      total,
      paginationPage(query),
      paginationTake(query),
      toSalesSummary(groups, SaleStatus.VOIDED),
    );
  }

  async findOne(id: string): Promise<unknown> {
    const sale = await this.prisma.kidZoneSale.findUnique({
      where: { id },
      include: {
        customer: true,
        child: true,
        plan: true,
        soldBy: { select: { id: true, name: true } },
        voidedBy: { select: { id: true, name: true } },
        payments: true,
        membership: true,
        visits: true,
      },
    });
    if (!sale) throw new NotFoundDomainException('Sale', id);
    return { ...sale, businessDate: fromDateColumn(sale.businessDate) };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async createMembershipForSale(
    tx: PrismaTransaction,
    input: {
      plan: KidZonePlan;
      sale: KidZoneSale;
      customerId: string;
      childId: string;
      startDate: BusinessDate;
      renewedFromId?: string;
    },
  ): Promise<Membership> {
    if (!input.plan.durationDays) {
      throw new DomainException(
        'PLAN_DURATION_MISSING',
        `The plan "${input.plan.name}" has no duration and cannot create a membership`,
        422,
      );
    }

    const term = membershipTerm(input.startDate, input.plan.durationDays);

    return tx.membership.create({
      data: {
        customerId: input.customerId,
        childId: input.childId,
        planId: input.plan.id,
        saleId: input.sale.id,
        startDate: toDateColumn(term.startDate),
        endDate: toDateColumn(term.endDate),
        status: MembershipStatus.ACTIVE,
        qrToken: generateQrToken(),
        renewedFromId: input.renewedFromId ?? null,
      },
    });
  }

  /**
   * A one-time session is sold and used in the same breath, so the sale checks
   * the child straight in rather than making the counter staff do it twice.
   */
  private async openSessionVisit(
    tx: PrismaTransaction,
    input: {
      plan: KidZonePlan;
      sale: KidZoneSale;
      customerId: string;
      childId: string;
      businessDate: BusinessDate;
      actorId: string;
    },
  ): Promise<Visit> {
    const active = await tx.visit.findFirst({
      where: { childId: input.childId, status: VisitStatus.ACTIVE },
      select: { id: true, gatepassNo: true },
    });
    if (active) {
      throw new DomainException(
        'CHILD_ALREADY_CHECKED_IN',
        'This child is already inside on gatepass ' + active.gatepassNo + '. Check them out first.',
        409,
        { visitId: active.id, gatepassNo: active.gatepassNo },
      );
    }

    const checkInAt = new Date();
    const expectedCheckOutAt = input.plan.sessionMinutes
      ? new Date(checkInAt.getTime() + input.plan.sessionMinutes * 60_000)
      : null;

    const gatepassNo = await this.sequences.nextGatepassNo(input.businessDate, tx);

    return tx.visit.create({
      data: {
        businessDate: toDateColumn(input.businessDate),
        customerId: input.customerId,
        childId: input.childId,
        saleId: input.sale.id,
        gatepassNo,
        checkInAt,
        expectedCheckOutAt,
        verificationMethod: VerificationMethod.GATEPASS,
        status: VisitStatus.ACTIVE,
        checkedInById: input.actorId,
      },
    });
  }

  private async membershipSms(
    customerName: string,
    phone: string,
    childName: string,
    plan: KidZonePlan,
    membership: Membership,
  ): Promise<PendingSms> {
    const message = await this.templates.render('smsTemplateMembershipSold', {
      name: customerName,
      child: childName,
      plan: plan.name,
      endDate: fromDateColumn(membership.endDate),
      qrCode: membership.qrToken,
    });
    return { phone, type: SmsType.GATEPASS, message };
  }

  private async gatepassSms(
    customerName: string,
    phone: string,
    childName: string,
    visit: Visit,
  ): Promise<PendingSms> {
    const tz = await this.calendar.timezone();
    const message = await this.templates.render('smsTemplateGatepass', {
      name: customerName,
      child: childName,
      gatepassNo: visit.gatepassNo,
      checkInTime: formatInTimezone(visit.checkInAt, tz, 'hh:mm A'),
      expectedCheckOut: visit.expectedCheckOutAt ? formatInTimezone(visit.expectedCheckOutAt, tz, 'hh:mm A') : '-',
    });
    return { phone, type: SmsType.GATEPASS, message };
  }

  /** Queues messages after the transaction committed. Never throws. */
  private async flush(messages: PendingSms[]): Promise<void> {
    for (const message of messages) {
      try {
        await this.sms.enqueue(message);
      } catch (error) {
        this.logger.error('Failed to queue an SMS after a completed sale', error instanceof Error ? error.stack : error);
      }
    }
  }
}
