import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { Section } from '@prisma/client';
import { PaginationQueryDto } from '@common/dto/pagination-query.dto';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export class CloseDayDto {
  @ApiPropertyOptional({
    example: '2026-09-22',
    description: 'The business date to close. Defaults to today. A future date is refused.',
  })
  @Matches(DATE_REGEX, { message: 'date must be a YYYY-MM-DD business date' })
  @IsOptional()
  date?: string;

  @ApiProperty({
    example: 1_250_00,
    minimum: 0,
    description: 'Cash physically counted in the drawer, in **poisha**. The difference against the expected figure is stored.',
  })
  @IsInt()
  @Min(0)
  countedCash!: number;

  @ApiPropertyOptional({ example: 'Two ৳500 notes short, cashier to check the float', maxLength: 500 })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  notes?: string;
}

export class ReopenDayDto {
  @ApiProperty({
    example: 'A cash sale was missed and has to be entered',
    maxLength: 300,
    description: 'Required and audited. Reopening unlocks the day for new writes.',
  })
  @IsString()
  @MaxLength(300)
  reason!: string;
}

export class ClosingPreviewQueryDto {
  @ApiPropertyOptional({ example: '2026-09-22', description: 'Defaults to today’s business date.' })
  @Matches(DATE_REGEX, { message: 'date must be a YYYY-MM-DD business date' })
  @IsOptional()
  date?: string;
}

export class QueryClosingsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: Section })
  @IsEnum(Section)
  @IsOptional()
  section?: Section;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @Matches(DATE_REGEX, { message: 'from must be a YYYY-MM-DD business date' })
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @Matches(DATE_REGEX, { message: 'to must be a YYYY-MM-DD business date' })
  @IsOptional()
  to?: string;

  @ApiPropertyOptional({ description: 'Only days where the counted cash did not match the expected cash.' })
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  @IsOptional()
  onlyDifferences?: boolean;
}
