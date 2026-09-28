import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { SmsStatus, SmsType } from '@prisma/client';
import { PaginationQueryDto } from '@common/dto/pagination-query.dto';

export class QuerySmsLogDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: SmsStatus, description: 'QUEUED, SENT or FAILED.' })
  @IsEnum(SmsStatus)
  @IsOptional()
  status?: SmsStatus;

  @ApiPropertyOptional({ enum: SmsType, description: 'OTP, GATEPASS, EXPIRY_REMINDER, RECEIPT or OTHER.' })
  @IsEnum(SmsType)
  @IsOptional()
  type?: SmsType;
}
