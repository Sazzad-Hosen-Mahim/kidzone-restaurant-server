import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { KidZonePlan, Role } from '@prisma/client';
import { Roles } from '@common/decorators/roles.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Client, ClientInfo } from '@common/decorators/client-info.decorator';
import { AuthenticatedUser } from '@common/types/authenticated-user';
import { PageResult } from '@common/http/api-response';
import { PlansService } from './plans.service';
import { CreatePlanDto, QueryPlansDto, UpdatePlanDto } from './dto/plan.dto';

@ApiTags('Kid Zone / Plans')
@ApiBearerAuth('access-token')
@Controller('kidzone/plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @Roles(Role.ADMIN, Role.KIDZONE_MANAGER)
  @ApiOperation({
    summary: 'List Kid Zone plans',
    description: 'Ordered by `sortOrder` then name, which is the order the point-of-sale screen should use.',
  })
  list(@Query() query: QueryPlansDto): Promise<PageResult<KidZonePlan>> {
    return this.plans.list(query);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.KIDZONE_MANAGER)
  @ApiOperation({ summary: 'One plan, with its last 20 price changes' })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<KidZonePlan> {
    return this.plans.findOne(id);
  }

  @Post()
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Create a plan',
    description: 'A MEMBERSHIP plan needs `durationDays`; a SESSION plan needs `sessionMinutes`.',
  })
  create(
    @Body() dto: CreatePlanDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<KidZonePlan> {
    return this.plans.create(dto, user, client);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Update a plan',
    description:
      'Changing `price` writes a PlanPriceHistory row and a `PRICE_CHANGED` audit entry. Sales already made keep their own price snapshot and are unaffected.',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePlanDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<KidZonePlan> {
    return this.plans.update(id, dto, user, client);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Retire a plan (soft delete)',
    description: 'It stops being sellable. Memberships already sold keep running to their end date.',
  })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<KidZonePlan> {
    return this.plans.remove(id, user, client);
  }
}
