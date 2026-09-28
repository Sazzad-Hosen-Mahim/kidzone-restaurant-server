import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '@common/decorators/roles.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Client, ClientInfo } from '@common/decorators/client-info.decorator';
import { AuthenticatedUser } from '@common/types/authenticated-user';
import { PageResult } from '@common/http/api-response';
import { PublicUser, UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

@ApiTags('Users')
@ApiBearerAuth('access-token')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'List staff accounts',
    description: 'Paginated. `search` matches name, phone and email. Sortable by createdAt, name, role, lastLoginAt.',
  })
  list(@Query() query: QueryUsersDto): Promise<PageResult<PublicUser>> {
    return this.users.list(query);
  }

  @Get(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Read one staff account' })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<PublicUser> {
    return this.users.findOne(id);
  }

  @Post()
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Create a staff account',
    description: 'The password hash is never returned. Phone numbers are normalised to E.164 and must be unique.',
  })
  @ApiCreatedResponse({ description: 'The created user, without the password hash' })
  create(
    @Body() dto: CreateUserDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<PublicUser> {
    return this.users.create(dto, actor, client);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Update a staff account',
    description:
      'Also used to deactivate or reactivate (`isActive`). An admin cannot deactivate or demote themselves, and the last active admin cannot be removed. A deactivation or role change revokes that user’s sessions immediately.',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<PublicUser> {
    return this.users.update(id, dto, actor, client);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Deactivate a staff account (soft delete)',
    description:
      'The row is kept so historical sales, visits and audit entries still resolve to a real name. Sessions are revoked immediately.',
  })
  @ApiOkResponse({ description: 'The deactivated user' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<PublicUser> {
    return this.users.deactivate(id, actor, client);
  }

  @Post(':id/reset-password')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Reset another user’s password',
    description:
      'Supply `newPassword`, or omit it to have a strong password generated and returned once. All of that user’s sessions are revoked.',
  })
  @ApiOkResponse({ description: '`generatedPassword` is present only when the server generated one' })
  resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetPasswordDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<{ generatedPassword?: string }> {
    return this.users.resetPassword(id, dto.newPassword, actor, client);
  }
}
