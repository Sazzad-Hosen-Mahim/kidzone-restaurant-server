import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { PlanType } from '@prisma/client';
import { PaginationQueryDto } from '@common/dto/pagination-query.dto';

export class CreatePlanDto {
  @ApiProperty({ example: '3 Month Membership', maxLength: 120 })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @ApiProperty({
    enum: PlanType,
    description:
      '`MEMBERSHIP` creates a dated membership with a QR token; `SESSION` checks the child in immediately for a fixed number of minutes.',
  })
  @IsEnum(PlanType)
  type!: PlanType;

  @ApiProperty({ example: 600000, minimum: 0, description: 'Price in **poisha**. 600000 means ৳6,000.00.' })
  @IsInt()
  @Min(0)
  price!: number;

  @ApiPropertyOptional({ example: 90, description: 'Membership length in days. Required for MEMBERSHIP plans.' })
  @ValidateIf((dto: CreatePlanDto) => dto.type === PlanType.MEMBERSHIP)
  @IsInt()
  @Min(1)
  @Max(3650)
  durationDays?: number;

  @ApiPropertyOptional({ example: 120, description: 'Session length in minutes. Required for SESSION plans.' })
  @ValidateIf((dto: CreatePlanDto) => dto.type === PlanType.SESSION)
  @IsInt()
  @Min(1)
  @Max(1440)
  sessionMinutes?: number;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  includesSnackBox?: boolean;

  @ApiPropertyOptional({
    description: 'Whether the gate requires OTP or QR verification. Defaults to true for memberships.',
  })
  @IsBoolean()
  @IsOptional()
  requiresVerification?: boolean;

  @ApiPropertyOptional({ example: 30, description: 'Overtime billing block in minutes.' })
  @IsInt()
  @Min(1)
  @Max(720)
  @IsOptional()
  overtimeBlockMinutes?: number;

  @ApiPropertyOptional({ example: 5000, description: 'Poisha charged per started overtime block.' })
  @IsInt()
  @Min(0)
  @IsOptional()
  overtimeRatePerBlock?: number;

  @ApiPropertyOptional({ example: 10, default: 10, description: 'Minutes of lateness forgiven before overtime starts.' })
  @IsInt()
  @Min(0)
  @Max(240)
  @IsOptional()
  gracePeriodMinutes?: number;

  @ApiPropertyOptional({ example: 0, description: 'Display order on the point-of-sale screen.' })
  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;
}

export class UpdatePlanDto extends PartialType(CreatePlanDto) {
  @ApiPropertyOptional({ description: 'Soft delete. Existing memberships and sales are unaffected.' })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class QueryPlansDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PlanType })
  @IsEnum(PlanType)
  @IsOptional()
  type?: PlanType;

  @ApiPropertyOptional({ description: 'Filter by activation state. Omit to see both.' })
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class PlanIdParamDto {
  @Type(() => String)
  @IsString()
  id!: string;
}
