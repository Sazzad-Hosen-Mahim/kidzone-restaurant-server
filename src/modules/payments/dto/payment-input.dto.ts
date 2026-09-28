import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaymentMethod } from '@prisma/client';

/**
 * One tender against a bill. Several may be supplied for a split payment; the
 * server checks that they add up to the total.
 */
export class PaymentInputDto {
  @ApiProperty({ enum: PaymentMethod, example: PaymentMethod.CASH })
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @ApiProperty({
    example: 25000,
    minimum: 1,
    description: 'Amount in **poisha** (1 BDT = 100 poisha). 25000 means ৳250.00.',
  })
  @IsInt()
  @Min(1)
  amount!: number;

  @ApiPropertyOptional({
    example: 'BKS7X21QW9',
    description: 'Transaction id for bKash, Nagad or a card terminal. Recorded for reconciliation.',
  })
  @IsString()
  @MaxLength(80)
  @IsOptional()
  reference?: string;
}

export class PaymentsArrayDto {
  @ApiProperty({
    type: [PaymentInputDto],
    description: 'One entry per tender. The amounts must add up to exactly the amount due.',
  })
  @ValidateNested({ each: true })
  @Type(() => PaymentInputDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  payments!: PaymentInputDto[];
}
