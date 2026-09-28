import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { OrderStatus } from '@prisma/client';
import { PaginationQueryDto } from '@common/dto/pagination-query.dto';
import { BusinessDateRangeQueryDto } from '@common/dto/date-range-query.dto';
import { PaymentInputDto } from '@modules/payments/dto/payment-input.dto';
import { IsBdMobile, NormalizeBdPhone } from '@common/validators/bd-phone.validator';

export class OrderItemInputDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  menuItemId!: string;

  @ApiProperty({ example: 2, minimum: 1, maximum: 999 })
  @IsInt()
  @Min(1)
  @Max(999)
  quantity!: number;

  @ApiPropertyOptional({ example: 'No chilli', maxLength: 200, description: 'Kitchen note for this line.' })
  @IsString()
  @MaxLength(200)
  @IsOptional()
  note?: string;
}

export class CreateOrderDto {
  @ApiProperty({ type: [OrderItemInputDto], description: 'Prices are read from the database; any price sent by the client is ignored.' })
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  items!: OrderItemInputDto[];

  @ApiPropertyOptional({
    example: '01712345678',
    description:
      'Optionally attach a guardian to the bill by phone. An unknown number creates the customer when `customerName` is also given; a known one links to the existing record, which is what makes the cross-section report possible.',
  })
  @IsBdMobile()
  @NormalizeBdPhone()
  @IsOptional()
  customerPhone?: string;

  @ApiPropertyOptional({ example: 'Shahana Akter', description: 'Only needed when `customerPhone` is not yet on file.' })
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  customerName?: string;

  @ApiPropertyOptional({ example: 'T-12', maxLength: 20 })
  @IsString()
  @MaxLength(20)
  @IsOptional()
  tableNo?: string;

  @ApiPropertyOptional({
    example: 5000,
    minimum: 0,
    description: 'Discount in **poisha**, applied to the subtotal before service charge and VAT.',
  })
  @IsInt()
  @Min(0)
  @IsOptional()
  discountAmount?: number;

  @ApiPropertyOptional({ example: 'Staff meal', maxLength: 200 })
  @IsString()
  @MaxLength(200)
  @IsOptional()
  discountReason?: string;

  @ApiProperty({ type: [PaymentInputDto], description: 'Must add up to exactly the total. Split payments are supported.' })
  @ValidateNested({ each: true })
  @Type(() => PaymentInputDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  payments!: PaymentInputDto[];
}

export class VoidOrderDto {
  @ApiProperty({ example: 'Wrong table, rung up twice', maxLength: 300 })
  @IsString()
  @MaxLength(300)
  reason!: string;
}

export class QueryOrdersDto extends IntersectionType(PaginationQueryDto, BusinessDateRangeQueryDto) {
  @ApiPropertyOptional({ enum: OrderStatus })
  @IsEnum(OrderStatus)
  @IsOptional()
  status?: OrderStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  cashierId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  customerId?: string;

  @ApiPropertyOptional({ example: 'T-12' })
  @IsString()
  @MaxLength(20)
  @IsOptional()
  tableNo?: string;
}
