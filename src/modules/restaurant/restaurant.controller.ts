import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { MenuCategory, MenuItem, Order, Role } from '@prisma/client';
import { Roles } from '@common/decorators/roles.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Client, ClientInfo } from '@common/decorators/client-info.decorator';
import { AuthenticatedUser } from '@common/types/authenticated-user';
import { ApiErrorResponse, PageResult } from '@common/http/api-response';
import { MenuBoard, MenuService } from './menu/menu.service';
import {
  CreateCategoryDto,
  CreateMenuItemDto,
  QueryMenuItemsDto,
  SetAvailabilityDto,
  UpdateCategoryDto,
  UpdateMenuItemDto,
} from './menu/dto/menu.dto';
import { OrdersService } from './orders/orders.service';
import { CreateOrderDto, QueryOrdersDto, VoidOrderDto } from './orders/dto/order.dto';

/** Everyone who works the restaurant floor. */
const RESTAURANT_STAFF = [Role.ADMIN, Role.RESTAURANT_CASHIER] as const;

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

@ApiTags('Restaurant / Menu')
@ApiBearerAuth('access-token')
@Controller('restaurant')
export class MenuController {
  constructor(private readonly menu: MenuService) {}

  @Get('menu')
  @Roles(...RESTAURANT_STAFF)
  @ApiOperation({
    summary: 'The point-of-sale menu',
    description:
      'Active, available items grouped by category and ordered for the POS screen. Empty categories are omitted. One query, built for a screen that is reloaded all day.',
  })
  @ApiOkResponse({ description: 'Categories with their sellable items' })
  board(): Promise<MenuBoard> {
    return this.menu.board();
  }

  @Get('categories')
  @Roles(...RESTAURANT_STAFF)
  @ApiOperation({ summary: 'List menu categories, including inactive ones' })
  listCategories(): Promise<MenuCategory[]> {
    return this.menu.listCategories();
  }

  @Post('categories')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create a menu category' })
  createCategory(
    @Body() dto: CreateCategoryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<MenuCategory> {
    return this.menu.createCategory(dto, user, client);
  }

  @Patch('categories/:id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update a menu category' })
  updateCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<MenuCategory> {
    return this.menu.updateCategory(id, dto, user, client);
  }

  @Delete('categories/:id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Retire a menu category (soft delete)',
    description: 'Refused with `CATEGORY_NOT_EMPTY` while it still holds active items.',
  })
  removeCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<MenuCategory> {
    return this.menu.removeCategory(id, user, client);
  }

  @Get('menu-items')
  @Roles(...RESTAURANT_STAFF)
  @ApiOperation({ summary: 'List menu items', description: 'Includes unavailable and retired items, for management screens.' })
  listItems(@Query() query: QueryMenuItemsDto): Promise<PageResult<MenuItem>> {
    return this.menu.listItems(query);
  }

  @Get('menu-items/:id')
  @Roles(...RESTAURANT_STAFF)
  @ApiOperation({ summary: 'One menu item, with its last 20 price changes' })
  findItem(@Param('id', ParseUUIDPipe) id: string): Promise<MenuItem> {
    return this.menu.findItem(id);
  }

  @Post('menu-items')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create a menu item' })
  createItem(
    @Body() dto: CreateMenuItemDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<MenuItem> {
    return this.menu.createItem(dto, user, client);
  }

  @Patch('menu-items/:id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Update a menu item',
    description:
      'Admin only. Changing `price` writes a MenuItemPriceHistory row and a `PRICE_CHANGED` audit entry; orders already taken keep their own snapshot.',
  })
  updateItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMenuItemDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<MenuItem> {
    return this.menu.updateItem(id, dto, user, client);
  }

  @Patch('menu-items/:id/availability')
  @Roles(...RESTAURANT_STAFF)
  @ApiOperation({
    summary: 'Mark an item available or out of stock',
    description:
      'The one menu change a cashier may make: the kitchen running out of biryani is a floor decision. Every toggle is audited.',
  })
  setAvailability(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetAvailabilityDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<MenuItem> {
    return this.menu.setAvailability(id, dto.isAvailable, user, client);
  }

  @Delete('menu-items/:id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Retire a menu item (soft delete)' })
  removeItem(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<MenuItem> {
    return this.menu.removeItem(id, user, client);
  }
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

@ApiTags('Restaurant / Orders')
@ApiBearerAuth('access-token')
@Controller('restaurant/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @Roles(...RESTAURANT_STAFF)
  @ApiOperation({
    summary: 'Take an order',
    description: `Creates the order, its lines and its payments in one transaction.

- **Prices are never taken from the client.** Each unit price is read from the database inside the transaction, and the item name, price and category are snapshotted onto the line.
- Totals are computed as: subtotal → discount → service charge → VAT. The VAT and service charge **percentages are snapshotted** onto the order, so a later rate change cannot alter an old bill.
- Unavailable or retired items are refused with \`MENU_ITEM_UNAVAILABLE\`.
- \`customerPhone\` optionally attaches a guardian to the bill, linking this order to the same customer record the Kid Zone uses.
- Payments must add up to exactly the total.`,
  })
  @ApiCreatedResponse({ description: 'The order with its lines and payments' })
  @ApiConflictResponse({ type: ApiErrorResponse, description: 'DAY_ALREADY_CLOSED' })
  create(
    @Body() dto: CreateOrderDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<Order> {
    return this.orders.create(dto, user, client);
  }

  @Get()
  @Roles(...RESTAURANT_STAFF)
  @ApiOperation({
    summary: 'List orders',
    description: 'Filter by `from`/`to` business date, `status`, `cashierId`, customer or table. `search` matches receipt number, table, customer name and phone.',
  })
  list(@Query() query: QueryOrdersDto): Promise<PageResult<unknown>> {
    return this.orders.list(query);
  }

  @Get(':id')
  @Roles(...RESTAURANT_STAFF)
  @ApiOperation({ summary: 'One order with its lines and payments' })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<Order> {
    return this.orders.findOne(id);
  }

  @Post(':id/void')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Void an order',
    description:
      'Admin only, reason required, audited. The order is never deleted: it is marked VOIDED, excluded from revenue and reported separately.',
  })
  voidOrder(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidOrderDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<Order> {
    return this.orders.voidOrder(id, dto, user, client);
  }
}
