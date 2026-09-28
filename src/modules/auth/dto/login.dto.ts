import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    example: '01711111111',
    description:
      'Phone number or email address. A phone may be given as `01XXXXXXXXX`, `8801XXXXXXXXX` or `+8801XXXXXXXXX`.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  identifier!: string;

  @ApiProperty({ example: 'Admin#2026', minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
