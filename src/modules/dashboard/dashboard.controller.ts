import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '@common/decorators/roles.decorator';
import { DashboardService } from './dashboard.service';

@ApiTags('Dashboard')
@ApiBearerAuth('access-token')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('combined')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'The combined owner’s dashboard',
    description: `Everything for one screen in a single request:

- today's revenue for the Kid Zone, the restaurant and both together, each compared against yesterday
- who is on the floor right now, how many are in overtime and how much overtime is owed
- memberships expiring **this business week** (using the configured week start, not the next seven days)
- today's top 5 dishes
- the last 7 days of revenue for both sections

Kid Zone revenue here includes overtime settled at check-out, so the dashboard agrees with the day-end closing rather than quietly differing from it.

Admin only: it combines both sections.`,
  })
  @ApiOkResponse({ description: 'The combined dashboard' })
  combined(): Promise<Record<string, unknown>> {
    return this.dashboard.combined();
  }
}
