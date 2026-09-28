import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '@common/dto/pagination-query.dto';
import { AUDIT_ACTION_VALUES, AuditAction } from '../audit.constants';

export class QueryAuditLogsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Only entries written by this user' })
  @IsUUID()
  @IsOptional()
  actorId?: string;

  @ApiPropertyOptional({ enum: AUDIT_ACTION_VALUES, description: 'Only entries with this action' })
  @IsIn(AUDIT_ACTION_VALUES)
  @IsOptional()
  action?: AuditAction;

  @ApiPropertyOptional({ example: 'KidZoneSale', description: 'Only entries about this entity type' })
  @IsString()
  @MaxLength(60)
  @IsOptional()
  entityType?: string;

  @ApiPropertyOptional({ description: 'Only entries about this entity id' })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  entityId?: string;

  @ApiPropertyOptional({
    example: '2026-09-01T00:00:00.000Z',
    description: 'Inclusive lower bound on createdAt (ISO-8601 instant, or a YYYY-MM-DD date)',
  })
  @IsString()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30T23:59:59.999Z', description: 'Inclusive upper bound on createdAt' })
  @IsString()
  @IsOptional()
  to?: string;
}
