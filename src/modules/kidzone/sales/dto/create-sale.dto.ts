import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ChildRefDto, CustomerRefDto } from '@modules/customers/dto/customer.dto';
import { PaymentInputDto } from '@modules/payments/dto/payment-input.dto';

export class CreateKidZoneSaleDto {
  @ApiProperty({
    type: CustomerRefDto,
    description:
      'The guardian. Give an existing `id`, or a `phone` — an unknown phone creates the customer, a known one reuses it, so the same guardian is never duplicated.',
  })
  @ValidateNested()
  @Type(() => CustomerRefDto)
  customer!: CustomerRefDto;

  @ApiProperty({
    type: ChildRefDto,
    description: 'The child. Give an existing `id` (which must belong to this guardian) or `create` with their details.',
  })
  @ValidateNested()
  @Type(() => ChildRefDto)
  child!: ChildRefDto;

  @ApiProperty({ format: 'uuid', description: 'The plan being sold. Its name and price are snapshotted onto the sale.' })
  @IsUUID()
  planId!: string;

  @ApiPropertyOptional({
    example: 5000,
    minimum: 0,
    description:
      'Discount in **poisha**. Staff are capped at `maxStaffDiscountPercent`; admins are not. Any discount requires `discountReason`.',
  })
  @IsInt()
  @Min(0)
  @IsOptional()
  discountAmount?: number;

  @ApiPropertyOptional({ example: 'Sibling of an existing member', maxLength: 200 })
  @IsString()
  @MaxLength(200)
  @IsOptional()
  discountReason?: string;

  @ApiProperty({
    type: [PaymentInputDto],
    description: 'Split payments are supported. The amounts must add up to exactly the total after discount.',
  })
  @ValidateNested({ each: true })
  @Type(() => PaymentInputDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  payments!: PaymentInputDto[];
}

export class RenewMembershipDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Renew onto a different plan, e.g. upgrading from 3 months to 6. Defaults to the current plan.',
  })
  @IsUUID()
  @IsOptional()
  planId?: string;

  @ApiPropertyOptional({ example: 5000, minimum: 0, description: 'Discount in poisha.' })
  @IsInt()
  @Min(0)
  @IsOptional()
  discountAmount?: number;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  @IsOptional()
  discountReason?: string;

  @ApiProperty({ type: [PaymentInputDto] })
  @ValidateNested({ each: true })
  @Type(() => PaymentInputDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  payments!: PaymentInputDto[];
}

export class VoidSaleDto {
  @ApiProperty({
    example: 'Customer changed their mind before the child entered',
    minLength: 5,
    maxLength: 300,
    description: 'Recorded on the sale and in the audit log. Required.',
  })
  @IsString()
  @MaxLength(300)
  reason!: string;
}
