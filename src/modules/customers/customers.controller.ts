import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '@common/decorators/roles.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Client, ClientInfo } from '@common/decorators/client-info.decorator';
import { AuthenticatedUser } from '@common/types/authenticated-user';
import { PageResult } from '@common/http/api-response';
import { CustomersService } from './customers.service';
import { ChildView, CustomerView } from './customers.serializer';
import {
  CreateChildDto,
  CreateCustomerDto,
  QueryCustomersDto,
  UpdateChildDto,
  UpdateCustomerDto,
} from './dto/customer.dto';

@ApiTags('Customers')
@ApiBearerAuth('access-token')
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @Roles(Role.ADMIN, Role.KIDZONE_MANAGER, Role.RESTAURANT_CASHIER)
  @ApiOperation({
    summary: 'Search customers',
    description:
      '`search` matches name, phone (in any typed form) and email. A restaurant cashier sees the guardian and a child **count** only — never child names, dates of birth, medical notes or emergency contacts.',
  })
  list(@Query() query: QueryCustomersDto, @CurrentUser() user: AuthenticatedUser): Promise<PageResult<CustomerView>> {
    return this.customers.list(query, user.role);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.KIDZONE_MANAGER, Role.RESTAURANT_CASHIER)
  @ApiOperation({
    summary: 'One customer with their history',
    description:
      'Admins and Kid Zone managers get children, memberships, visits, Kid Zone sales and restaurant orders. A restaurant cashier gets the guardian and their restaurant orders only; the `kidZone` block is absent and no child data is loaded. Membership QR tokens are never included here.',
  })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Record<string, unknown>> {
    return this.customers.findOne(id, user.role);
  }

  @Post()
  @Roles(Role.ADMIN, Role.KIDZONE_MANAGER, Role.RESTAURANT_CASHIER)
  @ApiOperation({
    summary: 'Create a customer',
    description:
      'The phone number is the identity that links a guardian across both sections, so it must be unique. A duplicate returns `CUSTOMER_PHONE_EXISTS` with the existing id.',
  })
  create(
    @Body() dto: CreateCustomerDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<CustomerView> {
    return this.customers.create(dto, user, client);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.KIDZONE_MANAGER)
  @ApiOperation({ summary: 'Update a customer' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<CustomerView> {
    return this.customers.update(id, dto, user, client);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Deactivate a customer (soft delete)',
    description: 'Their sales, visits and orders are kept; the record is simply hidden from search.',
  })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<CustomerView> {
    return this.customers.deactivate(id, user, client);
  }

  // -------------------------------------------------------------------------
  // Children — Kid Zone data, never exposed to restaurant staff
  // -------------------------------------------------------------------------

  @Get(':id/children')
  @Roles(Role.ADMIN, Role.KIDZONE_MANAGER)
  @ApiOperation({ summary: 'List a customer’s children', description: 'Includes the computed age in years.' })
  @ApiOkResponse({ description: 'Children with age, medical notes and emergency contact' })
  listChildren(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ChildView[]> {
    return this.customers.listChildren(id, user.role);
  }

  @Post(':id/children')
  @Roles(Role.ADMIN, Role.KIDZONE_MANAGER)
  @ApiOperation({ summary: 'Register a child under a customer' })
  createChild(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateChildDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<ChildView> {
    return this.customers.createChild(id, dto, user, client);
  }

  @Patch(':id/children/:childId')
  @Roles(Role.ADMIN, Role.KIDZONE_MANAGER)
  @ApiOperation({ summary: 'Update a child' })
  updateChild(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('childId', ParseUUIDPipe) childId: string,
    @Body() dto: UpdateChildDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<ChildView> {
    return this.customers.updateChild(id, childId, dto, user, client);
  }

  @Delete(':id/children/:childId')
  @Roles(Role.ADMIN, Role.KIDZONE_MANAGER)
  @ApiOperation({ summary: 'Deactivate a child (soft delete)' })
  removeChild(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('childId', ParseUUIDPipe) childId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<ChildView> {
    return this.customers.deactivateChild(id, childId, user, client);
  }
}
