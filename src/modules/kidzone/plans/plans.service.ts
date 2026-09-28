import { Injectable } from '@nestjs/common';
import { paginationOrderBy, paginationPage, paginationSkip, paginationTake } from '@common/dto/pagination-query.dto';
import { KidZonePlan, PlanType, Prisma } from '@prisma/client';
import { PrismaService, PrismaExecutor } from '@/prisma/prisma.service';
import { AuditService } from '@modules/audit/audit.service';
import { AUDIT_ACTIONS } from '@modules/audit/audit.constants';
import { DomainException, NotFoundDomainException } from '@common/exceptions/domain.exception';
import { PageResult, paginate } from '@common/http/api-response';
import { ClientInfo } from '@common/decorators/client-info.decorator';
import { AuthenticatedUser } from '@common/types/authenticated-user';
import { CreatePlanDto, QueryPlansDto, UpdatePlanDto } from './dto/plan.dto';

const SORTABLE = ['sortOrder', 'name', 'price', 'createdAt'] as const;

@Injectable()
export class PlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: QueryPlansDto): Promise<PageResult<KidZonePlan>> {
    const where: Prisma.KidZonePlanWhereInput = {
      deletedAt: null,
      ...(query.type ? { type: query.type } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.kidZonePlan.findMany({
        where,
        orderBy: query.sort ? paginationOrderBy(query, SORTABLE, 'sortOrder') : [{ sortOrder: 'asc' }, { name: 'asc' }],
        skip: paginationSkip(query),
        take: paginationTake(query),
      }),
      this.prisma.kidZonePlan.count({ where }),
    ]);

    return paginate(items, total, paginationPage(query), paginationTake(query));
  }

  async findOne(id: string): Promise<KidZonePlan & { priceHistory: unknown[] }> {
    const plan = await this.prisma.kidZonePlan.findFirst({
      where: { id, deletedAt: null },
      include: {
        priceHistory: {
          orderBy: { changedAt: 'desc' },
          take: 20,
          include: { changedBy: { select: { id: true, name: true } } },
        },
      },
    });
    if (!plan) throw new NotFoundDomainException('Plan', id);
    return plan;
  }

  /**
   * Fetches a sellable plan inside a sale transaction.
   *
   * Retired plans are looked up too, so a cashier who picks a stale entry off a
   * cached POS screen is told the plan is no longer on sale rather than that it
   * does not exist.
   */
  async findSellable(tx: PrismaExecutor, id: string): Promise<KidZonePlan> {
    const plan = await tx.kidZonePlan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundDomainException('Plan', id);
    if (!plan.isActive || plan.deletedAt) {
      throw new DomainException('PLAN_INACTIVE', `The plan "${plan.name}" is no longer on sale`, 422, { planId: id });
    }
    return plan;
  }

  async create(dto: CreatePlanDto, actor: AuthenticatedUser, client: ClientInfo): Promise<KidZonePlan> {
    this.assertCoherent(dto.type, dto);

    const plan = await this.prisma.kidZonePlan.create({
      data: {
        name: dto.name,
        type: dto.type,
        price: dto.price,
        durationDays: dto.type === PlanType.MEMBERSHIP ? (dto.durationDays ?? null) : null,
        sessionMinutes: dto.type === PlanType.SESSION ? (dto.sessionMinutes ?? null) : null,
        includesSnackBox: dto.includesSnackBox ?? false,
        // Memberships are verified at the gate by default; a walk-in session is
        // already standing at the counter when it is sold.
        requiresVerification: dto.requiresVerification ?? dto.type === PlanType.MEMBERSHIP,
        overtimeBlockMinutes: dto.overtimeBlockMinutes ?? null,
        overtimeRatePerBlock: dto.overtimeRatePerBlock ?? null,
        gracePeriodMinutes: dto.gracePeriodMinutes ?? 10,
        sortOrder: dto.sortOrder ?? 0,
      },
    });

    await this.audit.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.PLAN_CREATED,
      entityType: 'KidZonePlan',
      entityId: plan.id,
      after: plan,
      ip: client.ip,
      userAgent: client.userAgent,
    });

    return plan;
  }

  /**
   * Updates a plan. A price change additionally writes a PlanPriceHistory row
   * and its own PRICE_CHANGED audit entry, so "who raised the price and when"
   * is answerable without diffing audit payloads.
   *
   * Existing sales are untouched: they carry their own name and price snapshot.
   */
  async update(
    id: string,
    dto: UpdatePlanDto,
    actor: AuthenticatedUser,
    client: ClientInfo,
  ): Promise<KidZonePlan> {
    const existing = await this.prisma.kidZonePlan.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundDomainException('Plan', id);

    const type = dto.type ?? existing.type;
    this.assertCoherent(type, {
      durationDays: dto.durationDays ?? existing.durationDays ?? undefined,
      sessionMinutes: dto.sessionMinutes ?? existing.sessionMinutes ?? undefined,
    });

    const priceChanged = dto.price !== undefined && dto.price !== existing.price;

    const plan = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.kidZonePlan.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.type !== undefined ? { type: dto.type } : {}),
          ...(dto.price !== undefined ? { price: dto.price } : {}),
          ...(dto.durationDays !== undefined ? { durationDays: type === PlanType.MEMBERSHIP ? dto.durationDays : null } : {}),
          ...(dto.sessionMinutes !== undefined ? { sessionMinutes: type === PlanType.SESSION ? dto.sessionMinutes : null } : {}),
          ...(dto.includesSnackBox !== undefined ? { includesSnackBox: dto.includesSnackBox } : {}),
          ...(dto.requiresVerification !== undefined ? { requiresVerification: dto.requiresVerification } : {}),
          ...(dto.overtimeBlockMinutes !== undefined ? { overtimeBlockMinutes: dto.overtimeBlockMinutes } : {}),
          ...(dto.overtimeRatePerBlock !== undefined ? { overtimeRatePerBlock: dto.overtimeRatePerBlock } : {}),
          ...(dto.gracePeriodMinutes !== undefined ? { gracePeriodMinutes: dto.gracePeriodMinutes } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });

      if (priceChanged) {
        await tx.planPriceHistory.create({
          data: { planId: id, oldPrice: existing.price, newPrice: dto.price!, changedById: actor.id },
        });
        await this.audit.record(
          {
            actorId: actor.id,
            action: AUDIT_ACTIONS.PRICE_CHANGED,
            entityType: 'KidZonePlan',
            entityId: id,
            before: { price: existing.price },
            after: { price: dto.price },
            ip: client.ip,
            userAgent: client.userAgent,
          },
          tx,
        );
      }

      return updated;
    });

    await this.audit.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.PLAN_UPDATED,
      entityType: 'KidZonePlan',
      entityId: id,
      before: existing,
      after: plan,
      ip: client.ip,
      userAgent: client.userAgent,
    });

    return plan;
  }

  /** Soft delete: the plan stops being sellable but history still resolves. */
  async remove(id: string, actor: AuthenticatedUser, client: ClientInfo): Promise<KidZonePlan> {
    const existing = await this.prisma.kidZonePlan.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundDomainException('Plan', id);

    const plan = await this.prisma.kidZonePlan.update({
      where: { id },
      data: { isActive: false, deletedAt: new Date() },
    });

    await this.audit.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.PLAN_DELETED,
      entityType: 'KidZonePlan',
      entityId: id,
      before: existing,
      ip: client.ip,
      userAgent: client.userAgent,
    });

    return plan;
  }

  private assertCoherent(
    type: PlanType,
    values: { durationDays?: number | null; sessionMinutes?: number | null },
  ): void {
    if (type === PlanType.MEMBERSHIP && !values.durationDays) {
      throw new DomainException('PLAN_DURATION_REQUIRED', 'A membership plan needs durationDays', 400);
    }
    if (type === PlanType.SESSION && !values.sessionMinutes) {
      throw new DomainException('PLAN_SESSION_MINUTES_REQUIRED', 'A session plan needs sessionMinutes', 400);
    }
  }
}
