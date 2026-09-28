import { Controller, Get, Query } from '@nestjs/common';
import { paginationOrderBy, paginationPage, paginationSkip, paginationTake } from '@common/dto/pagination-query.dto';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma, Role } from '@prisma/client';
import { Roles } from '@common/decorators/roles.decorator';
import { PageResult, paginate } from '@common/http/api-response';
import { PrismaService } from '@/prisma/prisma.service';
import { QueryAuditLogsDto } from './dto/query-audit-logs.dto';

const SORTABLE = ['createdAt', 'action', 'entityType'] as const;

@ApiTags('Audit')
@ApiBearerAuth('access-token')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Read the audit trail',
    description:
      'Paginated and read-only. The audit log is append-only: there is no endpoint to modify or delete an entry. `search` matches the reason text.',
  })
  @ApiOkResponse({ description: 'Audit entries, newest first by default' })
  async list(@Query() query: QueryAuditLogsDto): Promise<PageResult<unknown>> {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.search ? { reason: { contains: query.search, mode: 'insensitive' } } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: parseBoundary(query.from, 'start') } : {}),
              ...(query.to ? { lte: parseBoundary(query.to, 'end') } : {}),
            },
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: paginationOrderBy(query, SORTABLE, 'createdAt'),
        skip: paginationSkip(query),
        take: paginationTake(query),
        include: { actor: { select: { id: true, name: true, role: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return paginate(items, total, paginationPage(query), paginationTake(query));
  }
}

/** Accepts either a full ISO instant or a bare `YYYY-MM-DD`, which is widened to the whole day. */
function parseBoundary(value: string, edge: 'start' | 'end'): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(edge === 'start' ? `${value}T00:00:00.000Z` : `${value}T23:59:59.999Z`);
  }
  return new Date(value);
}
