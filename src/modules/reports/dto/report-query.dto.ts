import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { Section } from '@prisma/client';
import { ReportRangeQueryDto } from '@common/dto/date-range-query.dto';

export const EXPORT_FORMATS = ['xlsx', 'pdf'] as const;

export class ReportQueryDto extends ReportRangeQueryDto {
  @ApiPropertyOptional({
    enum: EXPORT_FORMATS,
    description:
      'Omit for JSON. `xlsx` returns a formatted spreadsheet with money columns in BDT; `pdf` returns an A4 report. Both are downloaded as `<report>_<from>_<to>.<ext>`.',
  })
  @IsIn(EXPORT_FORMATS)
  @IsOptional()
  export?: 'xlsx' | 'pdf';
}

export class TopItemsQueryDto extends ReportQueryDto {
  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 100, description: 'How many items to rank.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit: number = 10;
}

export class SectionReportQueryDto extends ReportQueryDto {
  @ApiPropertyOptional({ enum: Section, description: 'Narrow to one section. Omit to cover both.' })
  @IsEnum(Section)
  @IsOptional()
  section?: Section;
}

export class UtilizationQueryDto extends ReportQueryDto {
  @ApiPropertyOptional({
    default: 0.5,
    minimum: 0,
    maximum: 14,
    description: 'Visits per week below which a membership is listed as low usage.',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(14)
  @IsOptional()
  lowUsageThreshold: number = 0.5;
}
