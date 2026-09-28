import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export const PASSWORD_POLICY =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,128}$/;

export const PASSWORD_POLICY_MESSAGE =
  'Password must be 8-128 characters and contain at least one lowercase letter, one uppercase letter and one digit';

export class ChangePasswordDto {
  @ApiProperty({ example: 'Admin#2026', description: 'The password currently in use' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  currentPassword!: string;

  @ApiProperty({
    example: 'NewPass#2027',
    description: PASSWORD_POLICY_MESSAGE,
    minLength: 8,
    maxLength: 128,
  })
  @IsString()
  @Matches(PASSWORD_POLICY, { message: PASSWORD_POLICY_MESSAGE })
  newPassword!: string;
}
