import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsEnum,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { VerificationMethod, VisitStatus } from '@prisma/client';
import { PaginationQueryDto } from '@common/dto/pagination-query.dto';
import { BusinessDateRangeQueryDto } from '@common/dto/date-range-query.dto';
import { PaymentInputDto } from '@modules/payments/dto/payment-input.dto';

export class QueryVisitsDto extends IntersectionType(PaginationQueryDto, BusinessDateRangeQueryDto) {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  childId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  customerId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  membershipId?: string;

  @ApiPropertyOptional({ enum: VisitStatus })
  @IsEnum(VisitStatus)
  @IsOptional()
  status?: VisitStatus;

  @ApiPropertyOptional({ enum: VerificationMethod })
  @IsEnum(VerificationMethod)
  @IsOptional()
  verificationMethod?: VerificationMethod;
}

export class CheckOutDto {
  @ApiPropertyOptional({
    type: [PaymentInputDto],
    description:
      'Required only when overtime is owed, and then the amounts must add up to exactly the overtime charge. Call `GET /kidzone/visits/active` first to see what is due.',
  })
  @ValidateNested({ each: true })
  @Type(() => PaymentInputDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsOptional()
  payments?: PaymentInputDto[];
}

export class ActiveVisitDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'GP-20260922-0007' })
  gatepassNo!: string;

  @ApiProperty({ example: 87, description: 'Minutes since check-in' })
  elapsedMinutes!: number;

  @ApiProperty({
    example: 33,
    nullable: true,
    description: 'Minutes left in the session. Negative once it has run over. Null for an open-ended membership visit.',
  })
  remainingMinutes!: number | null;

  @ApiProperty({ example: false, description: 'True once the session plus its grace period has been exceeded' })
  isOvertime!: boolean;

  @ApiProperty({ example: 0, description: 'Overtime owed so far, in poisha' })
  projectedOvertimeCharge!: number;
}
