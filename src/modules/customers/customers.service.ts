import { Injectable } from '@nestjs/common';
import { paginationOrderBy, paginationPage, paginationSkip, paginationTake } from '@common/dto/pagination-query.dto';
import { Child, Customer, Prisma, Role } from '@prisma/client';
import { PrismaService, PrismaExecutor } from '@/prisma/prisma.service';
import { AuditService } from '@modules/audit/audit.service';
import { AUDIT_ACTIONS } from '@modules/audit/audit.constants';
import { BusinessCalendarService } from '@common/services/business-calendar.service';
import { DomainException, NotFoundDomainException } from '@common/exceptions/domain.exception';
import { PageResult, paginate } from '@common/http/api-response';
import { ClientInfo } from '@common/decorators/client-info.decorator';
import { AuthenticatedUser } from '@common/types/authenticated-user';
import { fromDateColumn, toDateColumn } from '@common/utils/date.util';
import {
  CreateChildDto,
  CreateCustomerDto,
  CustomerRefDto,
  QueryCustomersDto,
  UpdateChildDto,
  UpdateCustomerDto,
} from './dto/customer.dto';
import {
  ChildView,
  CustomerView,
  canSeeChildData,
  serializeChild,
  serializeCustomer,
} from './customers.serializer';

const SORTABLE = ['createdAt', 'name', 'phone'] as const;

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly calendar: BusinessCalendarService,
  ) {}

  // -------------------------------------------------------------------------
  // Customers
  // -------------------------------------------------------------------------

  async list(query: QueryCustomersDto, role: Role): Promise<PageResult<CustomerView>> {
    const search = query.search?.trim();

    const where: Prisma.CustomerWhereInput = {
      deletedAt: null,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              // Search by phone in any typed form: normalise when possible,
              // otherwise fall back to a partial match on the stored E.164.
              { phone: { contains: normalizedOrRaw(search) } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        orderBy: paginationOrderBy(query, SORTABLE, 'createdAt'),
        skip: paginationSkip(query),
        take: paginationTake(query),
        include: { _count: { select: { children: true } } },
      }),
      this.prisma.customer.count({ where }),
    ]);

    return paginate(
      items.map((c) => serializeCustomer(c, role)),
      total,
      paginationPage(query),
      paginationTake(query),
    );
  }

  /**
   * One customer with their full history.
   *
   * The Kid Zone half of the response (children, memberships, visits) is only
   * assembled for roles allowed to see it, so a cashier's request never even
   * loads child rows.
   */
  async findOne(id: string, role: Role): Promise<Record<string, unknown>> {
    const customer = await this.prisma.customer.findFirst({
      where: { id, deletedAt: null },
      include: { children: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } } },
    });
    if (!customer) throw new NotFoundDomainException('Customer', id);

    const today = await this.calendar.today();
    const base = serializeCustomer(customer, role, today);

    const orders = await this.prisma.order.findMany({
      where: { customerId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        receiptNo: true,
        businessDate: true,
        totalAmount: true,
        status: true,
        tableNo: true,
        createdAt: true,
      },
    });

    const restaurant = {
      orders: orders.map((o) => ({ ...o, businessDate: fromDateColumn(o.businessDate) })),
      orderCount: orders.length,
      totalSpent: orders.filter((o) => o.status === 'PAID').reduce((sum, o) => sum + o.totalAmount, 0),
    };

    if (!canSeeChildData(role)) {
      return { ...base, restaurant };
    }

    const [memberships, visits, sales] = await Promise.all([
      this.prisma.membership.findMany({
        where: { customerId: id },
        orderBy: { createdAt: 'desc' },
        include: { plan: { select: { id: true, name: true, type: true } }, child: { select: { id: true, name: true } } },
      }),
      this.prisma.visit.findMany({
        where: { customerId: id },
        orderBy: { checkInAt: 'desc' },
        take: 50,
        include: { child: { select: { id: true, name: true } } },
      }),
      this.prisma.kidZoneSale.findMany({
        where: { customerId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          receiptNo: true,
          businessDate: true,
          planNameSnapshot: true,
          totalAmount: true,
          status: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      ...base,
      kidZone: {
        memberships: memberships.map((m) => ({
          ...m,
          startDate: fromDateColumn(m.startDate),
          endDate: fromDateColumn(m.endDate),
          // The QR token is a bearer credential for the gate, so it is never
          // included in a general customer read.
          qrToken: undefined,
        })),
        visits: visits.map((v) => ({ ...v, businessDate: fromDateColumn(v.businessDate) })),
        sales: sales.map((s) => ({ ...s, businessDate: fromDateColumn(s.businessDate) })),
        totalSpent: sales.filter((s) => s.status === 'COMPLETED').reduce((sum, s) => sum + s.totalAmount, 0),
      },
      restaurant,
    };
  }

  async create(dto: CreateCustomerDto, actor: AuthenticatedUser, client: ClientInfo): Promise<CustomerView> {
    const existing = await this.prisma.customer.findUnique({ where: { phone: dto.phone } });
    if (existing) {
      throw new DomainException(
        'CUSTOMER_PHONE_EXISTS',
        `A customer with the phone number ${dto.phone} already exists`,
        409,
        { customerId: existing.id },
      );
    }

    const customer = await this.prisma.customer.create({
      data: {
        name: dto.name,
        phone: dto.phone,
        email: dto.email ?? null,
        address: dto.address ?? null,
        notes: dto.notes ?? null,
      },
      include: { _count: { select: { children: true } } },
    });

    await this.audit.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.CUSTOMER_CREATED,
      entityType: 'Customer',
      entityId: customer.id,
      after: { name: customer.name, phone: customer.phone },
      ip: client.ip,
      userAgent: client.userAgent,
    });

    return serializeCustomer(customer, actor.role);
  }

  async update(
    id: string,
    dto: UpdateCustomerDto,
    actor: AuthenticatedUser,
    client: ClientInfo,
  ): Promise<CustomerView> {
    const existing = await this.prisma.customer.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundDomainException('Customer', id);

    if (dto.phone && dto.phone !== existing.phone) {
      const clash = await this.prisma.customer.findUnique({ where: { phone: dto.phone } });
      if (clash) {
        throw new DomainException('CUSTOMER_PHONE_EXISTS', 'Another customer already uses this phone number', 409, {
          customerId: clash.id,
        });
      }
    }

    const customer = await this.prisma.customer.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.email !== undefined ? { email: dto.email || null } : {}),
        ...(dto.address !== undefined ? { address: dto.address || null } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes || null } : {}),
        ...(dto.isActive !== undefined
          ? { isActive: dto.isActive, deletedAt: dto.isActive ? null : new Date() }
          : {}),
      },
      include: { _count: { select: { children: true } } },
    });

    await this.audit.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.CUSTOMER_UPDATED,
      entityType: 'Customer',
      entityId: id,
      before: { name: existing.name, phone: existing.phone, isActive: existing.isActive },
      after: { name: customer.name, phone: customer.phone, isActive: customer.isActive },
      ip: client.ip,
      userAgent: client.userAgent,
    });

    return serializeCustomer(customer, actor.role);
  }

  /** Soft delete: the customer's sales, visits and orders stay intact. */
  async deactivate(id: string, actor: AuthenticatedUser, client: ClientInfo): Promise<CustomerView> {
    const existing = await this.prisma.customer.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundDomainException('Customer', id);

    const customer = await this.prisma.customer.update({
      where: { id },
      data: { isActive: false, deletedAt: new Date() },
      include: { _count: { select: { children: true } } },
    });

    await this.audit.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.CUSTOMER_UPDATED,
      entityType: 'Customer',
      entityId: id,
      before: { isActive: true },
      after: { isActive: false },
      reason: 'Customer deactivated',
      ip: client.ip,
      userAgent: client.userAgent,
    });

    return serializeCustomer(customer, actor.role);
  }

  // -------------------------------------------------------------------------
  // Children
  // -------------------------------------------------------------------------

  async listChildren(customerId: string, role: Role): Promise<ChildView[]> {
    await this.assertCustomerExists(customerId);
    const children = await this.prisma.child.findMany({
      where: { customerId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    const today = await this.calendar.today();
    return children.map((child) => serializeChild(child, role, today));
  }

  async createChild(
    customerId: string,
    dto: CreateChildDto,
    actor: AuthenticatedUser,
    client: ClientInfo,
  ): Promise<ChildView> {
    await this.assertCustomerExists(customerId);

    const child = await this.prisma.child.create({
      data: this.childData(customerId, dto),
    });

    await this.audit.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.CHILD_CREATED,
      entityType: 'Child',
      entityId: child.id,
      after: { customerId, name: child.name },
      ip: client.ip,
      userAgent: client.userAgent,
    });

    return serializeChild(child, actor.role, await this.calendar.today());
  }

  async updateChild(
    customerId: string,
    childId: string,
    dto: UpdateChildDto,
    actor: AuthenticatedUser,
    client: ClientInfo,
  ): Promise<ChildView> {
    const existing = await this.prisma.child.findFirst({ where: { id: childId, customerId, deletedAt: null } });
    if (!existing) throw new NotFoundDomainException('Child', childId);

    const child = await this.prisma.child.update({
      where: { id: childId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.dateOfBirth !== undefined ? { dateOfBirth: toDateColumn(dto.dateOfBirth.slice(0, 10)) } : {}),
        ...(dto.gender !== undefined ? { gender: dto.gender } : {}),
        ...(dto.medicalNotes !== undefined ? { medicalNotes: dto.medicalNotes || null } : {}),
        ...(dto.emergencyContactName !== undefined ? { emergencyContactName: dto.emergencyContactName } : {}),
        ...(dto.emergencyContactPhone !== undefined ? { emergencyContactPhone: dto.emergencyContactPhone } : {}),
        ...(dto.isActive !== undefined
          ? { isActive: dto.isActive, deletedAt: dto.isActive ? null : new Date() }
          : {}),
      },
    });

    await this.audit.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.CHILD_UPDATED,
      entityType: 'Child',
      entityId: childId,
      before: { name: existing.name, isActive: existing.isActive },
      after: { name: child.name, isActive: child.isActive },
      ip: client.ip,
      userAgent: client.userAgent,
    });

    return serializeChild(child, actor.role, await this.calendar.today());
  }

  async deactivateChild(
    customerId: string,
    childId: string,
    actor: AuthenticatedUser,
    client: ClientInfo,
  ): Promise<ChildView> {
    return this.updateChild(customerId, childId, { isActive: false }, actor, client);
  }

  // -------------------------------------------------------------------------
  // Resolution used by the sales flows
  // -------------------------------------------------------------------------

  /**
   * Finds or creates a customer from a sale payload.
   *
   * Phone is the identity: the same guardian buying a membership and later a
   * meal must land on one record, which is what makes the cross-section report
   * possible at all.
   */
  async resolveCustomer(tx: PrismaExecutor, ref: CustomerRefDto): Promise<Customer> {
    if (ref.id) {
      const customer = await tx.customer.findFirst({ where: { id: ref.id, deletedAt: null } });
      if (!customer) throw new NotFoundDomainException('Customer', ref.id);
      return customer;
    }

    if (!ref.phone) {
      throw new DomainException('CUSTOMER_REQUIRED', 'Provide either a customer id or a phone number', 400);
    }

    const existing = await tx.customer.findUnique({ where: { phone: ref.phone } });
    if (existing) {
      // Reactivate on contact rather than creating a second record.
      if (!existing.isActive || existing.deletedAt) {
        return tx.customer.update({ where: { id: existing.id }, data: { isActive: true, deletedAt: null } });
      }
      return existing;
    }

    if (!ref.name) {
      throw new DomainException(
        'CUSTOMER_NAME_REQUIRED',
        'This phone number is not on file. Provide a name to create the customer.',
        400,
      );
    }

    return tx.customer.create({
      data: {
        name: ref.name,
        phone: ref.phone,
        email: ref.email ?? null,
        address: ref.address ?? null,
      },
    });
  }

  /** Finds or creates a child under a customer, for a Kid Zone sale. */
  async resolveChild(
    tx: PrismaExecutor,
    customerId: string,
    ref: { id?: string; create?: CreateChildDto },
  ): Promise<Child> {
    if (ref.id) {
      const child = await tx.child.findFirst({ where: { id: ref.id, deletedAt: null } });
      if (!child) throw new NotFoundDomainException('Child', ref.id);
      if (child.customerId !== customerId) {
        throw new DomainException(
          'CHILD_CUSTOMER_MISMATCH',
          'That child is registered under a different guardian',
          400,
          { childId: ref.id, customerId },
        );
      }
      return child;
    }

    if (!ref.create) {
      throw new DomainException('CHILD_REQUIRED', 'Provide either a child id or the details to create one', 400);
    }

    return tx.child.create({ data: this.childData(customerId, ref.create) });
  }

  private childData(customerId: string, dto: CreateChildDto): Prisma.ChildCreateInput {
    return {
      customer: { connect: { id: customerId } },
      name: dto.name,
      dateOfBirth: toDateColumn(dto.dateOfBirth.slice(0, 10)),
      gender: dto.gender ?? null,
      medicalNotes: dto.medicalNotes ?? null,
      emergencyContactName: dto.emergencyContactName,
      emergencyContactPhone: dto.emergencyContactPhone,
    };
  }

  private async assertCustomerExists(id: string): Promise<void> {
    const exists = await this.prisma.customer.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!exists) throw new NotFoundDomainException('Customer', id);
  }
}

function normalizedOrRaw(search: string): string {
  const digits = search.replace(/\D/g, '');
  if (digits.length >= 10) {
    // e.g. "01712345678" -> "1712345678", which matches the stored +8801712345678
    return digits.replace(/^(?:00)?880?/, '').replace(/^0/, '');
  }
  return search;
}
