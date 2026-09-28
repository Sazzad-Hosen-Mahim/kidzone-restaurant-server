import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';
import { PASSWORD_POLICY, PASSWORD_POLICY_MESSAGE } from '@modules/auth/dto/change-password.dto';

export class ResetPasswordDto {
  @ApiPropertyOptional({
    description: `The new password (${PASSWORD_POLICY_MESSAGE}). Omit it and the server generates a strong one, returned exactly once in the response.`,
  })
  @IsString()
  @Matches(PASSWORD_POLICY, { message: PASSWORD_POLICY_MESSAGE })
  @IsOptional()
  newPassword?: string;
}
