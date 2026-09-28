import { Injectable } from '@nestjs/common';
import { paginationOrderBy, paginationPage, paginationSkip, paginationTake } from '@common/dto/pagination-query.dto';
import { MenuCategory, MenuItem, Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@modules/audit/audit.service';
import { AUDIT_ACTIONS } from '@modules/audit/audit.constants';
import { DomainException, NotFoundDomainException } from '@common/exceptions/domain.exception';
import { PageResult, paginate } from '@common/http/api-response';
import { ClientInfo } from '@common/decorators/client-info.decorator';
import { AuthenticatedUser } from '@common/types/authenticated-user';
import {
  CreateCategoryDto,
  CreateMenuItemDto,
  QueryMenuItemsDto,
  UpdateCategoryDto,
  UpdateMenuItemDto,
} from './dto/menu.dto';

const SORTABLE = ['sortOrder', 'name', 'price', 'createdAt'] as const;

export interface MenuBoard {
  categories: Array<{
    id: string;
    name: string;
    sortOrder: number;
    items: Array<{ id: string; name: string; description: string | null; price: number; sku: string | null }>;
  }>;
  itemCount: number;
}

@Injectable()
export class MenuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // The POS board
  // -------------------------------------------------------------------------

  /**
   * Everything a cashier can actually sell, grouped by category and ordered the
   * way the screen should render it.
   *
   * One query with a nested include rather than a query per category, because
   * this is the screen the restaurant reloads all day.
   */
  async board(): Promise<MenuBoard> {
    const categories = await this.prisma.menuCategory.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        items: {
          where: { isActive: true, isAvailable: true, deletedAt: null },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, name: true, description: true, price: true, sku: true },
        },
      },
    });

    const withItems = categories.filter((c) => c.items.length > 0);

    return {
      categories: withItems.map((c) => ({
        id: c.id,
        name: c.name,
        sortOrder: c.sortOrder,
        items: c.items,
      })),
      itemCount: withItems.reduce((n, c) => n + c.items.length, 0),
    };
  }

  // -------------------------------------------------------------------------
  // Categories
  // -------------------------------------------------------------------------

  async listCategories(): Promise<MenuCategory[]> {
    return this.prisma.menuCategory.findMany({
      where: { deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createCategory(
    dto: CreateCategoryDto,
    actor: AuthenticatedUser,
    client: ClientInfo,
  ): Promise<MenuCategory> {
    const category = await this.prisma.menuCategory.create({
      data: { name: dto.name, sortOrder: dto.sortOrder ?? 0 },
    });

    await this.audit.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.CATEGORY_CREATED,
      entityType: 'MenuCategory',
      entityId: category.id,
      after: category,
      ip: client.ip,
      userAgent: client.userAgent,
    });

    return category;
  }

  async updateCategory(
    id: string,
    dto: UpdateCategoryDto,
    actor: AuthenticatedUser,
    client: ClientInfo,
  ): Promise<MenuCategory> {
    const existing = await this.prisma.menuCategory.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundDomainException('Menu category', id);

    const category = await this.prisma.menuCategory.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });

    await this.audit.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.CATEGORY_UPDATED,
      entityType: 'MenuCategory',
      entityId: id,
      before: existing,
      after: category,
      ip: client.ip,
      userAgent: client.userAgent,
    });

    return category;
  }

  async removeCategory(id: string, actor: AuthenticatedUser, client: ClientInfo): Promise<MenuCategory> {
    const existing = await this.prisma.menuCategory.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundDomainException('Menu category', id);

    const liveItems = await this.prisma.menuItem.count({ where: { categoryId: id, deletedAt: null, isActive: true } });
    if (liveItems > 0) {
      throw new DomainException(
        'CATEGORY_NOT_EMPTY',
        `This category still holds ${liveItems} active item(s). Move or retire them first.`,
        409,
        { liveItems },
      );
    }

    const category = await this.prisma.menuCategory.update({
      where: { id },
      data: { isActive: false, deletedAt: new Date() },
    });

    await this.audit.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.CATEGORY_DELETED,
      entityType: 'MenuCategory',
      entityId: id,
      before: existing,
      ip: client.ip,
      userAgent: client.userAgent,
    });

    return category;
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  async listItems(query: QueryMenuItemsDto): Promise<PageResult<MenuItem>> {
    const where: Prisma.MenuItemWhereInput = {
      deletedAt: null,
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.isAvailable !== undefined ? { isAvailable: query.isAvailable } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { sku: { contains: query.search, mode: 'insensitive' } },
              { description: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.menuItem.findMany({
        where,
        orderBy: query.sort ? paginationOrderBy(query, SORTABLE, 'sortOrder') : [{ sortOrder: 'asc' }, { name: 'asc' }],
        skip: paginationSkip(query),
        take: paginationTake(query),
        include: { category: { select: { id: true, name: true } } },
      }),
      this.prisma.menuItem.count({ where }),
    ]);

    return paginate(items, total, paginationPage(query), paginationTake(query));
  }

  async findItem(id: string): Promise<MenuItem> {
    const item = await this.prisma.menuItem.findFirst({
      where: { id, deletedAt: null },
      include: {
        category: { select: { id: true, name: true } },
        priceHistory: {
          orderBy: { changedAt: 'desc' },
          take: 20,
          include: { changedBy: { select: { id: true, name: true } } },
        },
      },
    });
    if (!item) throw new NotFoundDomainException('Menu item', id);
    return item;
  }

  async createItem(dto: CreateMenuItemDto, actor: AuthenticatedUser, client: ClientInfo): Promise<MenuItem> {
    const category = await this.prisma.menuCategory.findFirst({ where: { id: dto.categoryId, deletedAt: null } });
    if (!category) throw new NotFoundDomainException('Menu category', dto.categoryId);

    const item = await this.prisma.menuItem.create({
      data: {
        categoryId: dto.categoryId,
        name: dto.name,
        description: dto.description ?? null,
        price: dto.price,
        sku: dto.sku ?? null,
        sortOrder: dto.sortOrder ?? 0,
      },
    });

    await this.audit.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.MENU_ITEM_CREATED,
      entityType: 'MenuItem',
      entityId: item.id,
      after: item,
      ip: client.ip,
      userAgent: client.userAgent,
    });

    return item;
  }

  /**
   * Updates an item. A price change writes a MenuItemPriceHistory row and its
   * own PRICE_CHANGED audit entry. Orders already taken keep their snapshot and
   * are untouched.
   */
  async updateItem(
    id: string,
    dto: UpdateMenuItemDto,
    actor: AuthenticatedUser,
    client: ClientInfo,
  ): Promise<MenuItem> {
    const existing = await this.prisma.menuItem.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundDomainException('Menu item', id);

    if (dto.categoryId && dto.categoryId !== existing.categoryId) {
      const category = await this.prisma.menuCategory.findFirst({ where: { id: dto.categoryId, deletedAt: null } });
      if (!category) throw new NotFoundDomainException('Menu category', dto.categoryId);
    }

    const priceChanged = dto.price !== undefined && dto.price !== existing.price;

    const item = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.menuItem.update({
        where: { id },
        data: {
          ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined ? { description: dto.description || null } : {}),
          ...(dto.price !== undefined ? { price: dto.price } : {}),
          ...(dto.sku !== undefined ? { sku: dto.sku || null } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          ...(dto.isAvailable !== undefined ? { isAvailable: dto.isAvailable } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });

      if (priceChanged) {
        await tx.menuItemPriceHistory.create({
          data: { menuItemId: id, oldPrice: existing.price, newPrice: dto.price!, changedById: actor.id },
        });
        await this.audit.record(
          {
            actorId: actor.id,
            action: AUDIT_ACTIONS.PRICE_CHANGED,
            entityType: 'MenuItem',
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
      action: AUDIT_ACTIONS.MENU_ITEM_UPDATED,
      entityType: 'MenuItem',
      entityId: id,
      before: existing,
      after: item,
      ip: client.ip,
      userAgent: client.userAgent,
    });

    return item;
  }

  /**
   * Toggles availability — the one menu change a cashier may make, because the
   * kitchen running out of biryani is a floor decision, not an admin one.
   */
  async setAvailability(
    id: string,
    isAvailable: boolean,
    actor: AuthenticatedUser,
    client: ClientInfo,
  ): Promise<MenuItem> {
    const existing = await this.prisma.menuItem.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundDomainException('Menu item', id);

    const item = await this.prisma.menuItem.update({ where: { id }, data: { isAvailable } });

    await this.audit.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.MENU_AVAILABILITY_CHANGED,
      entityType: 'MenuItem',
      entityId: id,
      before: { isAvailable: existing.isAvailable },
      after: { isAvailable },
      ip: client.ip,
      userAgent: client.userAgent,
    });

    return item;
  }

  async removeItem(id: string, actor: AuthenticatedUser, client: ClientInfo): Promise<MenuItem> {
    const existing = await this.prisma.menuItem.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundDomainException('Menu item', id);

    const item = await this.prisma.menuItem.update({
      where: { id },
      data: { isActive: false, isAvailable: false, deletedAt: new Date() },
    });

    await this.audit.record({
      actorId: actor.id,
      action: AUDIT_ACTIONS.MENU_ITEM_DELETED,
      entityType: 'MenuItem',
      entityId: id,
      before: existing,
      ip: client.ip,
      userAgent: client.userAgent,
    });

    return item;
  }
}
