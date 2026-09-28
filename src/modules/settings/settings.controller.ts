import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '@common/decorators/roles.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Client, ClientInfo } from '@common/decorators/client-info.decorator';
import { AuthenticatedUser } from '@common/types/authenticated-user';
import { AuditService } from '@modules/audit/audit.service';
import { AUDIT_ACTIONS } from '@modules/audit/audit.constants';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { SETTINGS_SCHEMA, SETTING_KEYS, SettingsMap } from './settings.constants';

@ApiTags('Settings')
@ApiBearerAuth('access-token')
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Read every business setting',
    description:
      'Returns all typed settings. Percentages are plain numbers (5 means 5%); money-adjacent settings are not amounts.',
  })
  @ApiOkResponse({ description: 'The complete settings map' })
  getAll(): Promise<SettingsMap> {
    return this.settings.getAll();
  }

  @Get('schema')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Describe every setting key',
    description: 'Key, default value and human description. Lets the admin UI render the settings form generically.',
  })
  getSchema(): Array<{ key: string; default: unknown; description: string }> {
    return SETTING_KEYS.map((key) => ({
      key,
      default: SETTINGS_SCHEMA[key].default,
      description: SETTINGS_SCHEMA[key].description,
    }));
  }

  @Patch()
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Update one or more settings',
    description:
      'Only the keys present in the body are changed. Each value is validated against its own schema; an invalid value returns `SETTINGS_VALIDATION_FAILED` with per-key problems. The change is audited with before/after values.',
  })
  async update(
    @Body() dto: UpdateSettingsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<SettingsMap> {
    const { before, after } = await this.settings.update(dto as Record<string, unknown>);

    const changedKeys = Object.keys(before);
    const afterChanged: Record<string, unknown> = {};
    for (const key of changedKeys) afterChanged[key] = (after as Record<string, unknown>)[key];

    await this.audit.record({
      actorId: user.id,
      action: AUDIT_ACTIONS.SETTINGS_CHANGED,
      entityType: 'Setting',
      entityId: changedKeys.join(','),
      before,
      after: afterChanged,
      ip: client.ip,
      userAgent: client.userAgent,
    });

    return after;
  }
}
