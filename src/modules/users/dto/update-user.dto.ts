import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateUserDto } from './create-user.dto';

/**
 * Everything on a user except the password, which is changed through
 * `PATCH /auth/change-password` (self) or `POST /users/:id/reset-password` (admin).
 */
export class UpdateUserDto extends PartialType(OmitType(CreateUserDto, ['password'] as const)) {
  @ApiPropertyOptional({
    description:
      'Deactivate or reactivate the account. A deactivated user loses access immediately, including on refresh.',
  })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
