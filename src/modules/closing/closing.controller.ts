import { Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { DayClosing, Role, Section } from '@prisma/client';
import { Roles } from '@common/decorators/roles.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Client, ClientInfo } from '@common/decorators/client-info.decorator';
import { AuthenticatedUser, sectionsFor } from '@common/types/authenticated-user';
import { PageResult } from '@common/http/api-response';
import { DomainException } from '@common/exceptions/domain.exception';
import { ClosingPreview, ClosingService } from './closing.service';
import { CloseDayDto, ClosingPreviewQueryDto, QueryClosingsDto, ReopenDayDto } from './dto/closing.dto';

const ALL_STAFF = [Role.ADMIN, Role.KIDZONE_MANAGER, Role.RESTAURANT_CASHIER] as const;

const SECTION_PARAM = {
  name: 'section',
  enum: ['kidzone', 'restaurant'],
  description: 'Which section’s till is being closed.',
} as const;

@ApiTags('Closing')
@ApiBearerAuth('access-token')
@Controller('closing')
export class ClosingController {
  constructor(private readonly closing: ClosingService) {}

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Closing history',
    description:
      'Every row carries `hasDifference` so a UI can highlight a till that did not balance, and `isReopened` for days that were unlocked again. `onlyDifferences=true` narrows to the ones worth investigating.',
  })
  list(@Query() query: QueryClosingsDto): Promise<PageResult<unknown>> {
    return this.closing.list(query);
  }

  @Get(':section/preview')
  @Roles(...ALL_STAFF)
  @ApiParam(SECTION_PARAM)
  @ApiOperation({
    summary: 'What the till should hold',
    description: `Computed for a business date from the **payment** rows, not from sale totals — that is what reconciles against a physical drawer, since a split payment puts part of one sale in cash and part in bKash.

Returns the sales count and total, the total per payment method, the expected cash, the discount total, and the void count and total. Payments belonging to voided transactions are excluded. Staff may only preview their own section.`,
  })
  @ApiOkResponse({ description: 'The expected figures for that date' })
  preview(
    @Param('section') section: string,
    @Query() query: ClosingPreviewQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ClosingPreview> {
    const resolved = this.resolveSection(section, user);
    return this.closing.preview(resolved, query.date);
  }

  @Post(':section')
  @Roles(...ALL_STAFF)
  @ApiParam(SECTION_PARAM)
  @ApiOperation({
    summary: 'Close a section’s day',
    description: `Records the counted cash and stores \`difference = countedCash - expectedCash\`. The expected figures are recomputed server-side, so the difference is genuinely "counted minus what the system says".

**After this, that section's records for that business date are locked**: new sales, voids and overtime charges dated to it are refused with \`DAY_ALREADY_CLOSED\`. Only an admin can reopen the day.

Each role closes its own section; an admin can close either.`,
  })
  close(
    @Param('section') section: string,
    @Body() dto: CloseDayDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<DayClosing> {
    const resolved = this.resolveSection(section, user);
    return this.closing.close(resolved, dto, user, client);
  }

  @Post(':id/reopen')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Reopen a closed day',
    description:
      'Admin only, reason required, audited as `DAY_REOPENED`. Unlocks the date for writes again. Closing it a second time updates the same record and re-locks the day.',
  })
  reopen(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReopenDayDto,
    @CurrentUser() user: AuthenticatedUser,
    @Client() client: ClientInfo,
  ): Promise<DayClosing> {
    return this.closing.reopen(id, dto, user, client);
  }

  /**
   * Maps the path segment to a Section and enforces that staff only touch their
   * own till. A cashier closing the Kid Zone would see its revenue, which is
   * exactly what the role boundary exists to prevent.
   */
  private resolveSection(raw: string, user: AuthenticatedUser): Section {
    const normalized = raw.toUpperCase();
    if (normalized !== Section.KIDZONE && normalized !== Section.RESTAURANT) {
      throw new DomainException('UNKNOWN_SECTION', `"${raw}" is not a section. Use "kidzone" or "restaurant".`, 400);
    }

    const allowed = sectionsFor(user.role);
    if (!allowed.includes(normalized)) {
      throw new ForbiddenException(`Your role (${user.role}) may only close the ${allowed.join(' and ')} section`);
    }

    return normalized;
  }
}
