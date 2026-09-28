import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { BUSINESS_DATE_FORMAT, RangeKey } from '../utils/date.util';

export const RANGE_KEYS: RangeKey[] = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'this_year',
  'custom',
];

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** `from`/`to` filter used by list endpoints, in business dates. */
export class BusinessDateRangeQueryDto {
  @ApiPropertyOptional({ example: '2026-09-01', description: `Inclusive start business date (${BUSINESS_DATE_FORMAT})` })
  @Matches(DATE_REGEX, { message: `from must be a ${BUSINESS_DATE_FORMAT} date` })
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30', description: `Inclusive end business date (${BUSINESS_DATE_FORMAT})` })
  @Matches(DATE_REGEX, { message: `to must be a ${BUSINESS_DATE_FORMAT} date` })
  @IsOptional()
  to?: string;
}

/** `range` selector used by every report endpoint. */
export class ReportRangeQueryDto extends BusinessDateRangeQueryDto {
  @ApiPropertyOptional({
    enum: RANGE_KEYS,
    default: 'today',
    description:
      'Preset period, resolved in the business timezone using the configured week start day. Use `custom` together with `from` and `to`.',
  })
  @IsIn(RANGE_KEYS)
  @IsOptional()
  range: RangeKey = 'today';
}
