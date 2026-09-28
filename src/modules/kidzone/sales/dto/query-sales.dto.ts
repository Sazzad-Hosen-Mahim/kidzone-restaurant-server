import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { SaleStatus } from '@prisma/client';
import { PaginationQueryDto } from '@common/dto/pagination-query.dto';
import { BusinessDateRangeQueryDto } from '@common/dto/date-range-query.dto';
import { IntersectionType } from '@nestjs/swagger';

export class QueryKidZoneSalesDto extends IntersectionType(PaginationQueryDto, BusinessDateRangeQueryDto) {
  @ApiPropertyOptional({ enum: SaleStatus, description: 'Omit to see both completed and voided sales.' })
  @IsEnum(SaleStatus)
  @IsOptional()
  status?: SaleStatus;

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
