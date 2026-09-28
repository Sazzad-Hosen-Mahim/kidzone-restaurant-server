import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Role } from '@prisma/client';
import { IsBdMobile, NormalizeBdPhone } from '@common/validators/bd-phone.validator';
import { PASSWORD_POLICY, PASSWORD_POLICY_MESSAGE } from '@modules/auth/dto/change-password.dto';

export class CreateUserDto {
  @ApiProperty({ example: 'Nusrat Jahan', maxLength: 120 })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @ApiProperty({
    example: '01711111111',
    description: 'Bangladeshi mobile number. Stored and returned as E.164 (`+8801XXXXXXXXX`).',
  })
  @IsBdMobile()
  @NormalizeBdPhone()
  phone!: string;

  @ApiPropertyOptional({ example: 'nusrat@kidzone.test' })
  @IsEmail()
  @MaxLength(180)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsOptional()
  email?: string;

  @ApiProperty({ example: 'Staff#2026', description: PASSWORD_POLICY_MESSAGE })
  @IsString()
  @Matches(PASSWORD_POLICY, { message: PASSWORD_POLICY_MESSAGE })
  password!: string;

  @ApiProperty({ enum: Role, example: Role.KIDZONE_MANAGER })
  @IsEnum(Role)
  role!: Role;
}
