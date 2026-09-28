import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CHECK_IN_METHODS, CheckInMethod } from '../settings.constants';

/**
 * Partial update of the business settings. Only the keys present in the body
 * are changed; everything else is left alone. Values are validated twice: by
 * class-validator here for a clean 400, and again by the settings registry's
 * Zod schema before anything is written.
 */
export class UpdateSettingsDto {
  @ApiPropertyOptional({ example: 'Kid Zone & Restaurant', maxLength: 120 })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  businessName?: string;

  @ApiPropertyOptional({ example: 'House 12, Road 5, Dhanmondi, Dhaka 1205' })
  @IsString()
  @MaxLength(300)
  @IsOptional()
  address?: string;

  @ApiPropertyOptional({ example: '+8801700000000' })
  @IsString()
  @MaxLength(60)
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ example: 'Thank you for visiting. Please come again!' })
  @IsString()
  @MaxLength(300)
  @IsOptional()
  receiptFooter?: string;

  @ApiPropertyOptional({ example: 5, minimum: 0, maximum: 100, description: 'VAT %, applied after service charge' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  @IsOptional()
  vatPercent?: number;

  @ApiPropertyOptional({ example: 10, minimum: 0, maximum: 100, description: 'Service charge %, applied after discount' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  @IsOptional()
  serviceChargePercent?: number;

  @ApiPropertyOptional({ example: 10, minimum: 0, maximum: 100, description: 'Largest discount a non-admin may apply' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  @IsOptional()
  maxStaffDiscountPercent?: number;

  @ApiPropertyOptional({ example: 6, minimum: 0, maximum: 6, description: '0 = Sunday … 6 = Saturday' })
  @IsInt()
  @Min(0)
  @Max(6)
  @IsOptional()
  weekStartDay?: number;

  @ApiPropertyOptional({
    example: 0,
    minimum: 0,
    maximum: 23,
    description: 'Trade before this local hour counts toward the previous business day',
  })
  @IsInt()
  @Min(0)
  @Max(23)
  @IsOptional()
  businessDayStartHour?: number;

  @ApiPropertyOptional({ example: 'Asia/Dhaka', description: 'IANA timezone name' })
  @IsString()
  @MaxLength(60)
  @IsOptional()
  businessTimezone?: string;

  @ApiPropertyOptional({ example: [7, 1], description: 'Days before expiry on which a reminder SMS is queued' })
  @IsArray()
  @ArrayMaxSize(10)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(365, { each: true })
  @IsOptional()
  expiryReminderDays?: number[];

  @ApiPropertyOptional({ enum: CHECK_IN_METHODS, example: 'BOTH' })
  @IsIn(CHECK_IN_METHODS)
  @IsOptional()
  checkInMethod?: CheckInMethod;

  @ApiPropertyOptional({ example: 5, minimum: 1, maximum: 60 })
  @IsInt()
  @Min(1)
  @Max(60)
  @IsOptional()
  otpExpiryMinutes?: number;

  @ApiPropertyOptional({ example: 5, minimum: 1, maximum: 10, description: 'Wrong attempts before an OTP is invalidated' })
  @IsInt()
  @Min(1)
  @Max(10)
  @IsOptional()
  otpMaxAttempts?: number;

  @ApiPropertyOptional({ example: 60, minimum: 0, maximum: 600 })
  @IsInt()
  @Min(0)
  @Max(600)
  @IsOptional()
  otpResendCooldownSeconds?: number;

  @ApiPropertyOptional({ example: 5, minimum: 1, maximum: 50 })
  @IsInt()
  @Min(1)
  @Max(50)
  @IsOptional()
  otpMaxSendsPerHour?: number;

  @ApiPropertyOptional({ description: 'Placeholders: {name} {child} {plan} {endDate} {qrCode} {businessName}' })
  @IsString()
  @MaxLength(600)
  @IsOptional()
  smsTemplateMembershipSold?: string;

  @ApiPropertyOptional({
    description: 'Placeholders: {name} {child} {gatepassNo} {checkInTime} {expectedCheckOut} {businessName}',
  })
  @IsString()
  @MaxLength(600)
  @IsOptional()
  smsTemplateGatepass?: string;

  @ApiPropertyOptional({ description: 'Placeholders: {otp} {minutes} {businessName}' })
  @IsString()
  @MaxLength(600)
  @IsOptional()
  smsTemplateOtp?: string;

  @ApiPropertyOptional({ description: 'Placeholders: {name} {child} {plan} {endDate} {daysLeft} {businessName}' })
  @IsString()
  @MaxLength(600)
  @IsOptional()
  smsTemplateExpiryReminder?: string;

  @ApiPropertyOptional({ description: 'Placeholders: {receiptNo} {amount} {date} {businessName}' })
  @IsString()
  @MaxLength(600)
  @IsOptional()
  smsTemplateReceipt?: string;
}
