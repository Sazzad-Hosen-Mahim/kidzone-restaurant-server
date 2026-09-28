import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length, MaxLength, MinLength } from 'class-validator';
import { IsBdMobile, NormalizeBdPhone } from '@common/validators/bd-phone.validator';

export class CheckInLookupDto {
  @ApiProperty({ example: '01712345678', description: 'The guardian’s number, in any commonly typed form.' })
  @IsBdMobile()
  @NormalizeBdPhone()
  phone!: string;
}

export class SendOtpDto extends CheckInLookupDto {}

export class VerifyOtpDto {
  @ApiProperty({ example: '01712345678' })
  @IsBdMobile()
  @NormalizeBdPhone()
  phone!: string;

  @ApiProperty({ example: '482913', minLength: 6, maxLength: 6 })
  @IsString()
  @Length(6, 6)
  code!: string;

  @ApiProperty({ format: 'uuid', description: 'Which child is going in.' })
  @IsUUID()
  childId!: string;

  @ApiProperty({ format: 'uuid', description: 'The membership being used.' })
  @IsUUID()
  membershipId!: string;
}

export class QrCheckInDto {
  @ApiProperty({
    description: 'The `qrToken` from the membership QR code or the SMS sent at purchase.',
    example: 'xQ3n7K1sVb8...',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(200)
  qrToken!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only needed if the membership somehow covers more than one child; normally inferred from the token.',
  })
  @IsUUID()
  @IsOptional()
  childId?: string;
}

export class ManualCheckInDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  membershipId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Defaults to the child on the membership.' })
  @IsUUID()
  @IsOptional()
  childId?: string;

  @ApiProperty({
    example: 'Guardian’s phone is switched off and the QR card was left at home',
    minLength: 5,
    maxLength: 300,
    description: 'Required and audited. Manual override bypasses verification, so the reason matters.',
  })
  @IsString()
  @MinLength(5)
  @MaxLength(300)
  reason!: string;
}
