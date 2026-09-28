import { ApiProperty } from '@nestjs/swagger';
import { BusinessDate, DateRange, RangeKey, percentageChange } from '@common/utils/date.util';

/**
 * Shared report shapes.
 *
 * Every summary metric is reported as `{ current, previous, change }` so the
 * frontend never has to make a second call to answer "is that good?".
 */

export class ComparedMetric {
  @ApiProperty({ example: 1_250_000, description: 'The value for the requested period. Money is in poisha.' })
  current!: number;

  @ApiProperty({ example: 980_000, description: 'The same measure over the equivalent preceding period.' })
  previous!: number;

  @ApiProperty({
    example: 27.6,
    nullable: true,
    description: 'Percentage change, to one decimal. `null` when the previous period was zero, i.e. there is no baseline.',
  })
  change!: number | null;
}

export function compare(current: number, previous: number): ComparedMetric {
  return { current, previous, change: percentageChange(current, previous) };
}

export class ReportPeriod {
  @ApiProperty({ example: 'this_month' })
  range!: RangeKey;

  @ApiProperty({ example: '2026-09-01' })
  from!: BusinessDate;

  @ApiProperty({ example: '2026-09-22' })
  to!: BusinessDate;

  @ApiProperty({ example: 22 })
  days!: number;

  @ApiProperty({ description: 'The equivalent preceding period used for the comparison.' })
  previous!: DateRange;

  @ApiProperty({ example: 'Asia/Dhaka' })
  timezone!: string;
}

/** A point on a trend line. */
export interface TrendPoint {
  /** `YYYY-MM-DD` for daily granularity, `YYYY-MM` for monthly. */
  period: string;
  revenue: number;
  count: number;
}

export type Granularity = 'day' | 'month';

/**
 * Trend granularity. A year-long range as 365 daily points is unreadable and
 * slow to chart, so anything over ~10 weeks switches to months.
 */
export function granularityFor(range: { from: BusinessDate; to: BusinessDate }): Granularity {
  const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1;
  return days > 70 ? 'month' : 'day';
}
