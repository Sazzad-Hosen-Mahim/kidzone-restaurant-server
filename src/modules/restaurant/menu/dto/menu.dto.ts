import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min, MinLength, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '@common/dto/pagination-query.dto';

const trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class CreateCategoryDto {
  @ApiProperty({ example: 'Kids Meals', maxLength: 80 })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @trim()
  name!: string;

  @ApiPropertyOptional({ example: 1, description: 'Display order on the point-of-sale screen.' })
  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;
}

export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {
  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class CreateMenuItemDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ example: 'Chicken Biryani', maxLength: 120 })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @trim()
  name!: string;

  @ApiPropertyOptional({ example: 'Kacchi style, with borhani', maxLength: 300 })
  @IsString()
  @MaxLength(300)
  @trim()
  @IsOptional()
  description?: string;

  @ApiProperty({ example: 32000, minimum: 0, description: 'Price in **poisha**. 32000 means ৳320.00.' })
  @IsInt()
  @Min(0)
  price!: number;

  @ApiPropertyOptional({ example: 'RIC-001', maxLength: 40, description: 'Optional stock code. Must be unique.' })
  @IsString()
  @MaxLength(40)
  @trim()
  @IsOptional()
  sku?: string;

  @ApiPropertyOptional({ example: 0 })
  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;
}

export class UpdateMenuItemDto extends PartialType(CreateMenuItemDto) {
  @ApiPropertyOptional({ description: 'Temporarily out of stock. Cashiers may change this; only admins may change the rest.' })
  @IsBoolean()
  @IsOptional()
  isAvailable?: boolean;

  @ApiPropertyOptional({ description: 'Soft delete. Past orders keep their own name and price snapshot.' })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class SetAvailabilityDto {
  @ApiProperty({ example: false, description: 'False means "86’d" — off the menu until it is back in stock.' })
  @IsBoolean()
  isAvailable!: boolean;
}

export class QueryMenuItemsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  categoryId?: string;

  @ApiPropertyOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  @IsOptional()
  isAvailable?: boolean;

  @ApiPropertyOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
