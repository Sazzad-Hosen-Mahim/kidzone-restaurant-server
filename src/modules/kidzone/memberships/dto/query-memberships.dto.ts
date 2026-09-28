import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { MembershipStatus } from '@prisma/client';
import { PaginationQueryDto } from '@common/dto/pagination-query.dto';

export class QueryMembershipsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: MembershipStatus })
  @IsEnum(MembershipStatus)
  @IsOptional()
  status?: MembershipStatus;

  @ApiPropertyOptional({
    example: 7,
    minimum: 0,
    maximum: 365,
    description: 'Only active memberships ending within this many days. Overrides `status`; the follow-up call list.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  @IsOptional()
  expiringWithinDays?: number;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  customerId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  childId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  planId?: string;
}
