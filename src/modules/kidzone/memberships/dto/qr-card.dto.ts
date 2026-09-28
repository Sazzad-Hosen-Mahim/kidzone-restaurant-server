import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class ReissueQrDto {
  @ApiProperty({
    example: 'Guardian reported the card lost at the gate',
    description:
      'Why the old code is being revoked. Required: rotating a token silently locks a paying customer out of the gate, so the reason is part of the audit trail.',
  })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}
