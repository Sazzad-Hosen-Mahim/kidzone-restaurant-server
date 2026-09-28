import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Gender } from '@prisma/client';
import { IsBdMobile, NormalizeBdPhone } from '@common/validators/bd-phone.validator';
import { PaginationQueryDto } from '@common/dto/pagination-query.dto';

const trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class CreateCustomerDto {
  @ApiProperty({ example: 'Shahana Akter', maxLength: 120 })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @trim()
  name!: string;

  @ApiProperty({
    example: '01712345678',
    description:
      'The guardian’s mobile number. This is the key that links a customer across the Kid Zone and the restaurant, so it is unique and always stored as E.164.',
  })
  @IsBdMobile()
  @NormalizeBdPhone()
  phone!: string;

  @ApiPropertyOptional({ example: 'shahana@example.com' })
  @IsEmail()
  @MaxLength(180)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({ example: 'Flat 4B, Road 11, Banani, Dhaka' })
  @IsString()
  @MaxLength(300)
  @trim()
  @IsOptional()
  address?: string;

  @ApiPropertyOptional({ example: 'Prefers a call before 6pm' })
  @IsString()
  @MaxLength(500)
  @trim()
  @IsOptional()
  notes?: string;
}

export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {
  @ApiPropertyOptional({ description: 'Soft delete: an inactive customer is hidden from search but keeps their history.' })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class CreateChildDto {
  @ApiProperty({ example: 'Ayaan Rahman', maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @trim()
  name!: string;

  @ApiProperty({ example: '2020-05-10', description: 'Date of birth (YYYY-MM-DD). Age is computed, never stored.' })
  @IsISO8601({ strict: true })
  dateOfBirth!: string;

  @ApiPropertyOptional({ enum: Gender })
  @IsEnum(Gender)
  @IsOptional()
  gender?: Gender;

  @ApiPropertyOptional({
    example: 'Peanut allergy; carries an inhaler',
    description: 'Allergies and anything staff must know during a visit. Kid Zone staff and admins only.',
  })
  @IsString()
  @MaxLength(500)
  @trim()
  @IsOptional()
  medicalNotes?: string;

  @ApiProperty({ example: 'Shahana Akter', maxLength: 120 })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @trim()
  emergencyContactName!: string;

  @ApiProperty({ example: '01712345678' })
  @IsBdMobile()
  @NormalizeBdPhone()
  emergencyContactPhone!: string;
}

export class UpdateChildDto extends PartialType(CreateChildDto) {
  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class QueryCustomersDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter by activation state. Omit to see both.' })
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

/**
 * Used inside a sale: either point at an existing customer, or supply enough to
 * create one. The service resolves by phone first, so ringing up a returning
 * guardian by phone never creates a duplicate record.
 */
export class CustomerRefDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'An existing customer id. Takes precedence over the other fields.' })
  @IsString()
  @IsOptional()
  id?: string;

  @ApiPropertyOptional({ example: '01712345678', description: 'Looked up first; a new customer is created if unknown.' })
  @IsBdMobile()
  @NormalizeBdPhone()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ example: 'Shahana Akter', description: 'Required when creating a new customer.' })
  @IsString()
  @MaxLength(120)
  @trim()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: 'shahana@example.com' })
  @IsEmail()
  @MaxLength(180)
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({ example: 'Flat 4B, Road 11, Banani, Dhaka' })
  @IsString()
  @MaxLength(300)
  @IsOptional()
  address?: string;
}

/** Used inside a Kid Zone sale: an existing child, or a new one to create. */
export class ChildRefDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'An existing child id, which must belong to the resolved customer.' })
  @IsString()
  @IsOptional()
  id?: string;

  @ApiPropertyOptional({ type: CreateChildDto, description: 'Details for a child not yet on file.' })
  @ValidateNested()
  @Type(() => CreateChildDto)
  @IsOptional()
  create?: CreateChildDto;
}
