import { ApiProperty } from '@nestjs/swagger';
import { Role } from '@prisma/client';

export class AuthUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Rafiq Ahmed' })
  name!: string;

  @ApiProperty({ example: '+8801711111111', description: 'Always E.164' })
  phone!: string;

  @ApiProperty({ example: 'admin@kidzone.test', nullable: true })
  email!: string | null;

  @ApiProperty({ enum: Role, example: Role.ADMIN })
  role!: Role;
}

export class LoginResponseDto {
  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;

  @ApiProperty({ description: 'JWT access token. Send as `Authorization: Bearer <token>`.' })
  accessToken!: string;

  @ApiProperty({ example: 900, description: 'Access token lifetime in seconds' })
  expiresIn!: number;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: string;
}

export class MeResponseDto extends AuthUserDto {
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  lastLoginAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}
